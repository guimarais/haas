import http from 'node:http';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP, DATA as DEFAULT_DATA, WORKSPACE as DEFAULT_WORKSPACE, closeChat, createChat, messageText, ollamaModels, selectModel, transcript } from './agent.mjs';
import { atomicJson, listFiles, safePath } from './workspace.mjs';
import { Rag, MAX_DOCUMENT_BYTES } from './rag.mjs';
import { Organization } from './organization.mjs';

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf' };
const cleanError = error => {
  const message = error.message || String(error);
  return process.env.OPENAI_API_KEY ? message.replaceAll(process.env.OPENAI_API_KEY, '[redacted]') : message;
};

async function body(request, max = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export async function startServer({ port = Number(process.env.PORT || 4317), dataDir: DATA = DEFAULT_DATA, workspace: WORKSPACE = DEFAULT_WORKSPACE, chatOptions = {}, ragOptions = {} } = {}) {
  const warnings = [];
  const onWarning = message => { warnings.push(String(message)); if (warnings.length > 5) warnings.shift(); };
  const organization = new Organization(DATA);
  await organization.migrate(WORKSPACE);
  let current;
  try { current = JSON.parse(await readFile(path.join(DATA, 'current-session.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let scope = current?.kind ? await organization.get(current.kind, current.id) : await organization.create('chat');
  const rag = new Rag({ dataDir: DATA, ...ragOptions });
  const loadChat = (target, options = {}) => createChat({ ...chatOptions, dataDir: DATA, workspace: target.workspace,
    sessionDir: target.sessionDir, privacyFile: path.join(target.root, 'local-only.json'),
    project: target.kind === 'project' ? { name: target.name, description: target.description } : undefined, rag, onWarning, ...options });
  let chat = await loadChat(scope, { sessionFile: current?.sessionFile });
  const rememberChat = async () => {
    const sessionFile = chat.session.sessionManager.getSessionFile();
    await organization.save(scope, { currentSession: path.basename(sessionFile), sessionId: chat.session.sessionManager.getSessionId() });
    await atomicJson(path.join(DATA, 'current-session.json'), { kind: scope.kind, id: scope.id, sessionFile });
  };
  await rememberChat();
  let selection = { provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.4' };
  try { selection = JSON.parse(await readFile(path.join(DATA, 'selection.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') onWarning('Saved model selection could not be read; using OpenAI.'); }
  // ponytail: one active conversation/run; independent concurrent runs only if needed.
  let busy = false;
  let documentProgress, documentController, documentTask;

  async function conversations() {
    const currentId = chat.session.sessionManager.getSessionId();
    const saved = [];
    for (const target of [...await organization.list('chat'), ...await organization.list('project')]) {
      const sessions = await organization.sessions(target);
      if (!sessions.length && target.sessionId) saved.push({ id: target.sessionId, title: 'New chat', updatedAt: target.createdAt,
        active: target.sessionId === currentId, kind: target.kind, scopeId: target.id });
      for (const info of sessions) saved.push({
        id: info.id, title: (info.name || info.firstMessage || 'New conversation').replace(/\s+/g, ' ').slice(0, 90),
        updatedAt: info.modified.toISOString(), active: info.id === currentId, kind: target.kind, scopeId: target.id,
      });
    }
    if (!saved.some(info => info.active)) saved.push({ id: currentId, title: 'New chat', updatedAt: new Date().toISOString(), active: true, kind: scope.kind, scopeId: scope.id });
    return saved.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function switchChat(target, options) {
    // Load first so a failed restore leaves the current conversation usable.
    const next = await loadChat(target, options);
    await closeChat(chat, 'resume');
    scope = target;
    chat = next;
    await rememberChat();
  }

  async function snapshot() {
    try { if (await organization.tracking(scope)) await organization.snapshot(scope); }
    catch (error) { onWarning(`Git snapshot failed: ${cleanError(error)}`); }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const actualPort = server.address()?.port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(request.headers.host)) return json(response, { error: 'Invalid host.' }, 403);
      if (request.method !== 'GET' && (request.headers['x-haas-request'] !== '1' ||
          (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`))) {
        return json(response, { error: 'Only requests from this local chat page are accepted.' }, 403);
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        let localModels = [], ollamaError;
        try { localModels = await ollamaModels(); } catch { ollamaError = 'Ollama is not reachable. Start Ollama to use a local model.'; }
        return json(response, {
          selection, busy, conversations: await conversations(), messages: transcript(chat.session), files: await listFiles(scope.workspace), workspace: scope.workspace,
          scope: await organization.publicScope(scope),
          legacyWorkspace: scope.id === 'imported-workspace' ? WORKSPACE : undefined,
          projects: await Promise.all((await organization.list('project')).map(target => organization.publicScope(target))),
          skills: chat.skills, openaiConfigured: !!process.env.OPENAI_API_KEY, searchConfigured: !!process.env.OPENAI_API_KEY,
          models: { openai: chat.runtime.getModels('openai').map(model => model.id), ollama: localModels }, ollamaError,
          tools: chat.session.getAllTools().filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name), warnings,
          localOnly: await chat.isLocalOnly(),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/documents') {
        return json(response, { documents: await rag.list(), progress: documentProgress, embeddingModel: rag.model });
      }
      if (request.method === 'POST' && ['/api/documents/ingest', '/api/documents/update', '/api/documents/retry'].includes(url.pathname)) {
        if (documentController) return json(response, { error: 'A document is already being ingested. Wait for it to finish.' }, 409);
        const controller = new AbortController();
        documentController = controller;
        let finish;
        documentTask = new Promise(resolve => { finish = resolve; });
        try {
          let input, bytes;
          const editing = url.pathname === '/api/documents/update';
          const retrying = url.pathname === '/api/documents/retry';
          if (editing && !(request.headers['content-type'] || '').startsWith('application/json')) throw new Error('Document edits require JSON.');
          if ((request.headers['content-type'] || '').startsWith('application/json')) {
            const value = JSON.parse(await body(request));
            if (retrying) {
              if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)) throw new Error('Supply a valid document ID to retry.');
              input = { id: value.id };
            } else if (editing) {
              if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || typeof value.title !== 'string' || typeof value.url !== 'string' || !Array.isArray(value.themes)) throw new Error('Supply a document ID, title, source URL and theme list.');
              input = { id: value.id, url: value.url, title: value.title, themes: value.themes };
            } else {
              if (!value.url) throw new Error('Supply a document URL or upload a file.');
              input = { url: value.url, title: value.title, themes: value.themes };
            }
          } else {
            if (retrying) {
              const id = url.searchParams.get('id');
              if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Supply a valid document ID for the replacement file.');
              input = { id, name: url.searchParams.get('name') };
            } else input = { name: url.searchParams.get('name'), title: url.searchParams.get('title'), url: url.searchParams.get('url') || undefined,
              themes: JSON.parse(url.searchParams.get('themes') || '[]') };
            if (!input.name || /[\\/\x00-\x1f]/.test(input.name)) throw new Error('Supply a valid upload filename.');
            bytes = await body(request, MAX_DOCUMENT_BYTES);
          }
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
          const send = value => { if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`); };
          const options = { bytes, signal: controller.signal, onProgress: progress => {
            documentProgress = progress; send({ type: 'progress', ...progress });
          } };
          const result = editing ? await rag.update(input.id, input, options) : await rag.ingest(input, options);
          send({ type: 'done', ...result });
          response.end();
        } catch (error) {
          if (response.headersSent) { if (!response.destroyed) response.end(`${JSON.stringify({ type: 'error', error: cleanError(error), catalogueSaved: error.catalogueSaved, documentStatus: error.documentStatus })}\n`); }
          else json(response, { error: cleanError(error) }, error.status || 400);
        } finally { documentProgress = undefined; documentController = undefined; finish(); documentTask = undefined; }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/documents/remove') {
        if (documentController) return json(response, { error: 'Wait for document ingestion to finish before removing a document.' }, 409);
        const { id } = JSON.parse(await body(request));
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Supply a valid document ID.');
        return json(response, await rag.remove(id));
      }
      if (request.method === 'GET' && /^\/documents\/[a-zA-Z0-9_-]+\/download$/.test(url.pathname)) {
        const file = await rag.original(url.pathname.split('/')[2]);
        const pdf = path.extname(file) === '.pdf';
        response.writeHead(200, { 'Content-Type': pdf ? 'application/pdf' : 'application/octet-stream',
          'Content-Disposition': `${pdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
        const stream = createReadStream(file);
        stream.on('error', () => response.destroy()); stream.pipe(response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        if (busy) return json(response, { error: 'A task is already running. Stop it or wait for completion.' }, 409);
        busy = true;
        let unsubscribe;
        try {
          const input = JSON.parse(await body(request));
          if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 30_000) {
            throw new Error('Enter a message between 1 and 30,000 characters.');
          }
          await selectModel(chat, input.provider, input.model);
          selection = { provider: input.provider, model: input.model };
          await atomicJson(path.join(DATA, 'selection.json'), selection);
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
          const send = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
          // Closing the tab detaches the client; the task can finish and is saved in Pi's history.
          unsubscribe = chat.session.subscribe(event => {
            if (event.type === 'message_start' && event.message.role === 'assistant') send({ type: 'assistant_start' });
            if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') send({ type: 'delta', text: event.assistantMessageEvent.delta });
            if (event.type === 'message_end' && event.message.role === 'assistant') send({ type: 'assistant_end', text: messageText(event.message), error: event.message.errorMessage });
            if (event.type === 'tool_execution_start') send({ type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args });
            if (event.type === 'tool_execution_end') send({ type: 'tool_end', id: event.toolCallId, name: event.toolName, text: messageText(event.result), isError: !!event.isError || !!event.result?.isError });
            if (event.type === 'compaction_start') send({ type: 'status', text: 'Summarising earlier messages…' });
          });
          await chat.session.prompt(input.message.trim(), { expandPromptTemplates: false });
          await snapshot();
          send({ type: 'done' });
          response.end();
        } catch (error) {
          await snapshot();
          if (response.headersSent) { response.write(`${JSON.stringify({ type: 'error', text: cleanError(error) })}\n`); response.end(); }
          else json(response, { error: cleanError(error) }, error.status || 400);
        } finally { unsubscribe?.(); busy = false; }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/abort') {
        await chat.session.abort();
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && ['/api/new', '/api/conversations/open', '/api/projects', '/api/projects/open', '/api/projects/conversations/new', '/api/git', '/api/snapshot'].includes(url.pathname)) {
        if (busy) return json(response, { error: 'Stop the current task before switching conversations.' }, 409);
        busy = true;
        try {
          if (url.pathname === '/api/git') {
            const { enabled } = JSON.parse(await body(request));
            await organization.setTracking(scope, enabled);
          } else if (url.pathname === '/api/snapshot') {
            await organization.snapshot(scope);
          } else if (url.pathname === '/api/projects') {
            const input = JSON.parse(await body(request));
            await switchChat(await organization.create('project', input), { fresh: true });
          } else if (url.pathname === '/api/projects/open') {
            const { id } = JSON.parse(await body(request));
            const target = await organization.get('project', id);
            if (scope.kind !== 'project' || scope.id !== id) await switchChat(target, { sessionFile: target.currentSession && await safePath(target.sessionDir, target.currentSession) });
          } else if (url.pathname === '/api/projects/conversations/new') {
            if (scope.kind !== 'project') throw new Error('Open a project first.');
            await switchChat(scope, { fresh: true });
          } else if (url.pathname === '/api/new') {
            await switchChat(await organization.create('chat'), { fresh: true });
          } else {
            const { id } = JSON.parse(await body(request));
            const conversation = (await conversations()).find(info => info.id === id);
            if (!conversation) return json(response, { error: 'Conversation not found.' }, 404);
            if (!conversation.active) {
              const target = await organization.get(conversation.kind, conversation.scopeId);
              const session = (await organization.sessions(target)).find(info => info.id === id);
              await switchChat(target, { sessionFile: session?.path || await safePath(target.sessionDir, target.currentSession) });
            }
          }
          await snapshot();
          return json(response, { ok: true });
        } finally { busy = false; }
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        if (busy) return json(response, { error: 'Wait for the current task before importing files.' }, 409);
        busy = true;
        try {
          const name = url.searchParams.get('name');
          const batch = url.searchParams.get('batch') || randomUUID();
          if (!name || name.length > 180 || name.startsWith('.') || /[\\/\x00-\x1f]/.test(name) || !/^[a-f0-9-]{36}$/.test(batch)) throw new Error('Invalid file name.');
          const bytes = await body(request, 25 * 1024 * 1024);
          const original = path.join(DATA, 'originals', batch, name);
          const copy = await safePath(scope.workspace, path.join('imports', batch, name));
          await mkdir(path.dirname(original), { recursive: true, mode: 0o700 });
          await mkdir(path.dirname(copy), { recursive: true });
          await writeFile(original, bytes, { flag: 'wx', mode: 0o400 });
          await copyFile(original, copy);
          // copyFile preserves a read-only original's mode; the working copy must be editable.
          const { chmod } = await import('node:fs/promises');
          await chmod(copy, 0o600);
          await snapshot();
          return json(response, { path: path.relative(scope.workspace, copy), name });
        } finally { busy = false; }
      }
      if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
        const file = await safePath(scope.workspace, decodeURIComponent(url.pathname.slice('/files/'.length)));
        if (!(await stat(file)).isFile()) return json(response, { error: 'File not found.' }, 404);
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
        const stream = createReadStream(file);
        stream.on('error', () => response.destroy());
        stream.pipe(response);
        return;
      }
      const assets = {
        '/': path.join(APP, 'public/index.html'), '/app.js': path.join(APP, 'public/app.js'), '/theme.js': path.join(APP, 'public/theme.js'), '/style.css': path.join(APP, 'public/style.css'),
        '/vendor/marked.js': path.join(APP, 'node_modules/marked/lib/marked.umd.js'),
        '/vendor/purify.js': path.join(APP, 'node_modules/dompurify/dist/purify.min.js'),
      };
      if (request.method === 'GET' && assets[url.pathname]) {
        response.setHeader('Content-Type', contentTypes[path.extname(assets[url.pathname])]);
        return response.end(await readFile(assets[url.pathname]));
      }
      json(response, { error: 'Not found.' }, 404);
    } catch (error) { json(response, { error: cleanError(error) }, error.status || (error.code === 'ENOENT' ? 404 : 400)); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() {
    documentController?.abort();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await documentTask;
    await closeChat(chat);
    await closed;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startServer();
  console.log(`Haas is ready at ${app.url}\nProject files: ${DEFAULT_WORKSPACE}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  });
}
