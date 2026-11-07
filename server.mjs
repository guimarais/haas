import http from 'node:http';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { APP, DATA as DEFAULT_DATA, WORKSPACE as DEFAULT_WORKSPACE, closeChat, createChat, messageText, ollamaModels, selectModel, transcript } from './agent.mjs';
import { atomicJson, listFiles, safePath } from './workspace.mjs';

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

export async function startServer({ port = Number(process.env.PORT || 4317), dataDir: DATA = DEFAULT_DATA, workspace: WORKSPACE = DEFAULT_WORKSPACE, chatOptions = {} } = {}) {
  const warnings = [];
  const onWarning = message => { warnings.push(String(message)); if (warnings.length > 5) warnings.shift(); };
  let sessionFile;
  try { ({ sessionFile } = JSON.parse(await readFile(path.join(DATA, 'current-session.json'), 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const loadChat = options => createChat({ ...chatOptions, dataDir: DATA, workspace: WORKSPACE, onWarning, ...options });
  let chat = await loadChat({ sessionFile });
  const rememberChat = () => atomicJson(path.join(DATA, 'current-session.json'), { sessionFile: chat.session.sessionManager.getSessionFile() });
  await rememberChat();
  let selection = { provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.4' };
  try { selection = JSON.parse(await readFile(path.join(DATA, 'selection.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') onWarning('Saved model selection could not be read; using OpenAI.'); }
  // ponytail: one active conversation/run; independent concurrent runs only if needed.
  let busy = false;

  async function conversations() {
    const currentId = chat.session.sessionManager.getSessionId();
    const saved = (await SessionManager.list(WORKSPACE, path.join(DATA, 'sessions'))).map(info => ({
      id: info.id, title: (info.name || info.firstMessage || 'New conversation').replace(/\s+/g, ' ').slice(0, 90),
      updatedAt: info.modified.toISOString(), active: info.id === currentId,
    }));
    if (!saved.some(info => info.active)) saved.unshift({ id: currentId, title: 'New conversation', updatedAt: new Date().toISOString(), active: true });
    return saved;
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
          selection, busy, conversations: await conversations(), messages: transcript(chat.session), files: await listFiles(WORKSPACE), workspace: WORKSPACE,
          skills: chat.skills, openaiConfigured: !!process.env.OPENAI_API_KEY, searchConfigured: !!process.env.OPENAI_API_KEY,
          models: { openai: chat.runtime.getModels('openai').map(model => model.id), ollama: localModels }, ollamaError,
          tools: chat.session.getAllTools().filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name), warnings,
        });
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
          send({ type: 'done' });
          response.end();
        } catch (error) {
          if (response.headersSent) { response.write(`${JSON.stringify({ type: 'error', text: cleanError(error) })}\n`); response.end(); }
          else json(response, { error: cleanError(error) }, error.status || 400);
        } finally { unsubscribe?.(); busy = false; }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/abort') {
        await chat.session.abort();
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && ['/api/new', '/api/conversations/open'].includes(url.pathname)) {
        if (busy) return json(response, { error: 'Stop the current task before switching conversations.' }, 409);
        busy = true;
        try {
          const fresh = url.pathname === '/api/new';
          let target;
          if (!fresh) {
            const { id } = JSON.parse(await body(request));
            if (id === chat.session.sessionManager.getSessionId()) return json(response, { ok: true });
            target = (await SessionManager.list(WORKSPACE, path.join(DATA, 'sessions'))).find(info => info.id === id);
            if (!target) return json(response, { error: 'Conversation not found.' }, 404);
            await safePath(path.join(DATA, 'sessions'), target.path);
          }
          // Prepare the replacement first so a failed restore leaves the current chat usable.
          const next = await loadChat({ fresh, sessionFile: target?.path });
          await closeChat(chat, fresh ? 'new' : 'resume');
          chat = next;
          await rememberChat();
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
          const copy = await safePath(WORKSPACE, path.join('imports', batch, name));
          await mkdir(path.dirname(original), { recursive: true, mode: 0o700 });
          await mkdir(path.dirname(copy), { recursive: true });
          await writeFile(original, bytes, { flag: 'wx', mode: 0o400 });
          await copyFile(original, copy);
          // copyFile preserves a read-only original's mode; the working copy must be editable.
          const { chmod } = await import('node:fs/promises');
          await chmod(copy, 0o600);
          return json(response, { path: path.relative(WORKSPACE, copy), name });
        } finally { busy = false; }
      }
      if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
        const file = await safePath(WORKSPACE, decodeURIComponent(url.pathname.slice('/files/'.length)));
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
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() { await closeChat(chat); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
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
