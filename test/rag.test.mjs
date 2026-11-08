import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { Rag, chunkDocument, extractDocument, localOllamaUrl } from '../rag.mjs';
import { documentConversation, documentPrivacy, documentTools } from '../rag-tools.mjs';
import { closeChat, createChat, selectModel } from '../agent.mjs';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { startServer } from '../server.mjs';
import { runEvaluation } from '../scripts/eval-rag.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'haas-rag-'));
  const config = { digest: 'local-model-v1', embeddings: true, downloads: 0, embedCalls: 0, remote: false, sources: new Map(), chatSteps: [], chatRequests: [] };
  const model = 'qwen3-embedding:0.6b';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    if (req.url === '/v1/chat/completions') {
      config.chatRequests.push(input);
      const step = config.chatSteps.shift() || 'Done.';
      const tool = typeof step !== 'string';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'rag-check', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: `tool-${config.chatRequests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: step }) });
      send({}, tool ? 'tool_calls' : 'stop');
      return res.end('data: [DONE]\n\n');
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools', 'embedding'], ...(config.remote ? { remote_host: 'cloud.example' } : {}), model_info: { 'qwen3.embedding_length': 8 } }));
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: model, digest: config.digest }] }));
    if (req.url === '/api/embed') {
      config.embedCalls++;
      if (!config.embeddings) { res.writeHead(503); return res.end('{}'); }
      assert.equal(input.truncate, false);
      const embeddings = input.input.map(text => {
        const electronic = /resistor|resistance|current|electrical opposition|voltage|ne555/i.test(text);
        const railway = /railway|train|locomotive|track/i.test(text);
        return [electronic ? 1 : 0.01, railway ? 1 : 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
      });
      return res.end(JSON.stringify({ embeddings }));
    }
    config.downloads++;
    const source = config.sources.get(req.url);
    if (!source) { res.writeHead(404); return res.end('Missing'); }
    res.setHeader('Content-Type', source.type || 'text/markdown');
    res.end(source.bytes || source.text);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { dataDir: path.join(root, 'data'), manifest: path.join(root, 'documents.json'), projectDir: root, ollamaUrl: url, model };
  const rag = new Rag(options);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, config, url, options, rag, model };
}

test('real LanceDB persists hybrid search, deduplicates themes and replaces document chunks', async t => {
  const { root, rag, options, config } = await fixture(t);
  const file = path.join(root, 'resistors.md');
  await writeFile(file, `# Resistance\n\nResistors limit current flow. NE555 timers use electronic components.\n\n${'Old section about resistors and voltage. '.repeat(180)}`);
  const first = await rag.ingest({ path: file, title: 'Electrical reference', themes: ['electronics', 'components'] });
  assert.ok(first.chunks > 1);
  const embeds = config.embedCalls;
  assert.equal((await rag.ingest({ path: file })).skipped, true);
  assert.equal(config.embedCalls, embeds);
  const railway = await rag.ingest({ name: 'railway.txt', themes: ['railway'] }, { bytes: Buffer.from('A locomotive uses railway track.') });
  config.embeddings = false;
  assert.equal((await rag.search('locomotive')).results[0].documentId, railway.id, 'BM25 must include newly appended rows before optimize');
  config.embeddings = true;
  const reopened = new Rag(options);
  const result = await reopened.search('electrical opposition', { themes: ['electronics', 'components'] });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.results[0].documentId, first.id);
  assert.equal(new Set(result.results.map(row => row.id)).size, result.results.length);
  assert.ok(result.results.every(row => row.documentId !== railway.id));
  assert.match(result.results[0].citation, /^\/documents\/.*\/download/);
  const keyword = await reopened.search('NE555');
  assert.ok(keyword.results.some(row => row.documentId === first.id));
  const catalogue = await readFile(options.manifest, 'utf8');
  assert.match(catalogue, /resistors.md/);
  assert.ok(!catalogue.includes('vector') && !catalogue.includes('indexedAt'));

  await reopened.assignThemes(first.id, ['reference']);
  assert.equal((await reopened.search('NE555', { themes: ['electronics'] })).results.length, 0);
  assert.equal((await reopened.search('NE555', { themes: ['reference'] })).results[0].documentId, first.id);
  await writeFile(file, '# New section\n\nNE555 voltage specification.');
  const updated = await reopened.ingest({ id: first.id });
  assert.equal(updated.chunks, 1);
  const table = await reopened.table((await reopened.state()).table);
  try { assert.equal(await table.countRows(`document_id = '${first.id}'`), 1); }
  finally { table.close(); }
  await reopened.remove(first.id);
  assert.equal((await reopened.search('NE555', { themes: ['reference'] })).results.length, 0);
  assert.match(await readFile(file, 'utf8'), /NE555/);
  assert.equal((await reopened.list()).length, 1);
  const optimized = await reopened.optimize({ ann: true });
  assert.ok(optimized.indexes.some(index => index.columns.includes('vector')));
  assert.doesNotThrow(() => JSON.stringify(optimized));
});

test('URL rebuild restores a missing database, retains failed updates and safely migrates embedding spaces', async t => {
  const { root, rag, options, config, url } = await fixture(t);
  config.sources.set('/manual.md', { text: '# Components\n\nNE555 resistors and voltage.' });
  const doc = await rag.ingest({ url: `${url}/manual.md`, themes: ['electronics'] });
  config.sources.delete('/manual.md');
  const failed = await rag.rebuild();
  assert.equal(failed.failed, 1);
  assert.equal((await rag.list())[0].status.status, 'stale');
  assert.equal((await rag.search('NE555')).results[0].stale, true);
  config.embeddings = false;
  const fallback = await rag.search('NE555');
  assert.equal(fallback.mode, 'bm25');
  assert.match(fallback.warning, /Semantic search skipped/);
  assert.equal(fallback.results[0].documentId, doc.id);
  config.embeddings = true;
  config.digest = 'local-model-v2';
  const migration = await rag.rebuild();
  assert.equal(migration.published, false);
  assert.equal((await rag.state()).embedding.digest, 'local-model-v1');
  config.sources.set('/manual.md', { text: '# Components\n\nNew NE555 voltage data.' });
  assert.equal((await rag.rebuild()).failed, 0);
  assert.equal((await rag.state()).embedding.digest, 'local-model-v2');
  assert.match((await rag.search('NE555')).results[0].text, /New/);
  await rm(path.join(root, 'data/rag/lancedb'), { recursive: true });
  const fresh = new Rag({ ...options, dataDir: path.join(root, 'fresh-data') });
  const downloads = config.downloads;
  assert.equal((await fresh.rebuild()).failed, 0);
  assert.equal(config.downloads, downloads + 1);
  assert.equal((await fresh.search('NE555')).results[0].documentId, doc.id);
  const cli = spawnSync(process.execPath, ['scripts/rag.mjs', 'rebuild', '--manifest', options.manifest, '--data-dir', path.join(root, 'cli-data')],
    { cwd: process.cwd(), env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1' }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
});

test('extracts PDF page citations and HTML/Markdown sections, rejects nontext documents and unsafe configuration', async () => {
  const html = await extractDocument(Buffer.from('<html><body><nav>unwanted menu</nav><h1>Resistors</h1><p>Limit current.</p><script>bad()</script></body></html>'), 'page.html');
  const passages = chunkDocument(html.sections);
  assert.equal(passages[0].section, 'Resistors');
  assert.ok(!passages.map(row => row.text).join('').includes('unwanted'));
  assert.ok(!passages.map(row => row.text).join('').includes('bad()'));
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>> endobj\n4 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj\n5 0 obj <</Length 64>> stream\nBT /F1 12 Tf 50 700 Td (NE555 voltage specification.) Tj ET\nendstream endobj\ntrailer <</Root 1 0 R>>\n%%EOF');
  const extracted = await extractDocument(pdf, 'manual.pdf');
  assert.equal(extracted.sections[0].page, 1);
  assert.match(extracted.sections[0].text, /NE555 voltage/);
  assert.equal(chunkDocument(extracted.sections)[0].page, 1);
  await assert.rejects(extractDocument(Buffer.from('binary\0data'), 'file.txt'));
  await assert.rejects(extractDocument(Buffer.from('fake office file'), 'file.docx'), /Supported formats/);
  assert.throws(() => localOllamaUrl('https://cloud.example'), /localhost/);
});

test('document privacy locks survive session restore, block cloud models and external tools, and confine chat ingestion', async t => {
  const { root, rag, url, model, config } = await fixture(t);
  const handlers = {};
  const entries = [];
  const manager = { getEntries: () => entries };
  documentPrivacy(rag)({ on: (event, handler) => { handlers[event] = handler; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
  const context = { model: { provider: 'openai', id: 'cloud', baseUrl: 'https://api.openai.com/v1' }, sessionManager: manager };
  assert.equal((await handlers.tool_call({ toolName: 'rag_list' }, context)).block, true);
  assert.equal(documentConversation(manager), false);
  context.model = { provider: 'ollama', id: model, baseUrl: `${url}/v1` };
  config.remote = true;
  assert.equal((await handlers.tool_call({ toolName: 'rag_list' }, context)).block, true);
  config.remote = false;
  assert.equal(await handlers.tool_call({ toolName: 'rag_list' }, context), undefined);
  assert.equal(documentConversation(manager), true);
  assert.equal((await handlers.tool_call({ toolName: 'web_search' }, context)).block, true);
  assert.equal((await handlers.tool_call({ toolName: 'mcp__other__send' }, context)).block, true);
  assert.equal(await handlers.tool_call({ toolName: 'read' }, context), undefined);
  await assert.rejects(selectModel({ session: { sessionManager: manager } }, 'openai', 'gpt-5.4'), /must stay local/);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const tool = documentTools(rag, workspace).find(tool => tool.name === 'rag_add');
  await assert.rejects(tool.execute('test', { path: '../secret.txt', themes: ['test'] }), /outside/);
  await assert.rejects(tool.execute('test', { url: 'https://example.com/leak?text=private', themes: ['test'] }, undefined, undefined,
    { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Add https://example.com/manual.pdf' } }] } }), /explicitly/);

  const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('ollama', { api: 'openai-completions', baseUrl: `${url}/v1`, apiKey: 'test', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const options = { runtime, dataDir: path.join(root, 'chat-data'), workspace, extensions: [], rag, privacyFile: path.join(root, 'local-only.json') };
  await rag.ingest({ name: 'private.md', themes: ['electronics'] }, { bytes: Buffer.from('Private resistor notes: NE555 current specification.') });
  config.chatSteps.push({ name: 'rag_search', args: { query: 'NE555', themes: ['electronics'] } },
    { name: 'web_search', args: { query: 'Private resistor notes' } }, 'The local passage is available. External search is disabled.');
  const chat = await createChat(options);
  await chat.session.setModel(runtime.getModel('ollama', model));
  await chat.session.prompt('Search my documents for NE555.', { expandPromptTemplates: false });
  assert.equal(config.chatRequests.length, 3);
  assert.ok(chat.session.messages.some(message => message.role === 'toolResult' && message.toolName === 'rag_search' && !message.isError));
  assert.ok(chat.session.messages.some(message => message.role === 'toolResult' && message.toolName === 'web_search' && message.isError));
  assert.match(JSON.stringify(config.chatRequests[2]), /local-only/);
  assert.equal(documentConversation(chat.session.sessionManager), true);
  const sessionFile = chat.session.sessionManager.getSessionFile();
  await closeChat(chat);
  const restored = await createChat({ ...options, sessionFile });
  try { assert.equal(documentConversation(restored.session.sessionManager), true); }
  finally { await closeChat(restored); }
  const sibling = await createChat({ ...options, fresh: true });
  try {
    assert.equal(documentConversation(sibling.session.sessionManager), false);
    assert.equal(await sibling.isLocalOnly(), true, 'Shared project files retain the privacy restriction in a fresh conversation.');
    await assert.rejects(selectModel(sibling, 'openai', 'gpt-5.4'), /must stay local/);
  } finally { await closeChat(sibling); }
});

test('frontend ingestion streams progress, persists uploads and rebuilds local-only sources', async t => {
  const { root, options, config, rag } = await fixture(t);
  const app = await startServer({ port: 0, dataDir: options.dataDir, workspace: path.join(root, 'workspace'),
    chatOptions: { extensions: [] }, ragOptions: options });
  t.after(() => app.close());
  const headers = { 'X-Haas-Request': '1', 'Content-Type': 'application/octet-stream' };
  const params = new URLSearchParams({ name: 'reference.md', themes: JSON.stringify(['electronics', 'reference']) });
  const response = await fetch(`${app.url}/api/documents/ingest?${params}`, { method: 'POST', headers, body: '# Resistance\n\nNE555 resistors limit current.' });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.stage === 'embedding'));
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events));
  const collection = await (await fetch(`${app.url}/api/documents`)).json();
  assert.equal(collection.documents.length, 1);
  assert.equal(collection.documents[0].rebuildable, false);
  assert.equal(collection.documents[0].status.status, 'ready');
  const original = await fetch(`${app.url}/documents/${collection.documents[0].id}/download`);
  assert.match(await original.text(), /NE555/);
  const modelCalls = config.embedCalls;
  assert.equal((await rag.rebuild()).failed, 0);
  assert.ok(config.embedCalls > modelCalls);
  assert.equal((await fetch(`${app.url}/api/documents/ingest?${params}`, { method: 'POST', body: 'denied' })).status, 403);
  const page = await (await fetch(app.url)).text();
  assert.match(page, /id="document-form"/);
});

test('frontend edits preserve IDs, re-ingest title/source changes and remove every theme without deleting originals', async t => {
  const { root, options, config, rag, url } = await fixture(t);
  const originalText = '# Reference\n\nNE555 resistors limit current.';
  const { id } = await rag.ingest({ name: 'reference.md', title: 'Original reference', themes: ['electronics', 'reference'] }, { bytes: Buffer.from(originalText) });
  const original = await rag.original(id);
  const sourceFile = path.resolve(root, (await rag.list())[0].source.path);
  const app = await startServer({ port: 0, dataDir: options.dataDir, workspace: path.join(root, 'workspace'), chatOptions: { extensions: [] }, ragOptions: options });
  t.after(() => app.close());
  const post = (endpoint, value) => fetch(`${app.url}/api/documents/${endpoint}`, { method: 'POST',
    headers: { 'X-Haas-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const edit = async value => {
    const response = await post('update', { id, ...value });
    assert.equal(response.status, 200);
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1);
  };
  let calls = config.embedCalls;
  config.embeddings = false;
  const metadata = await edit({ title: 'Original reference', url: '', themes: ['components'] });
  assert.equal(metadata.metadataOnly, true);
  assert.equal(config.embedCalls, calls);
  assert.equal((await rag.search('NE555', { themes: ['components'], mode: 'bm25' })).results[0].documentId, id);
  assert.equal((await rag.search('NE555', { themes: ['reference'], mode: 'bm25' })).results.length, 0);

  config.embeddings = true;
  const renamed = await edit({ title: 'Renamed reference', url: '', themes: ['components'] });
  assert.equal(renamed.type, 'done'); assert.equal(renamed.skipped, false);
  assert.ok(config.embedCalls > calls);
  assert.equal((await rag.search('Renamed', { mode: 'bm25' })).results[0].documentId, id);
  config.sources.set('/replacement.md', { text: '# Replacement\n\nReplacement voltage specification.' });
  assert.equal((await edit({ title: 'Renamed reference', url: `${url}/replacement.md`, themes: ['components'] })).type, 'done');
  assert.match((await rag.search('Replacement', { mode: 'bm25' })).results[0].text, /Replacement voltage/);
  assert.equal((await edit({ title: 'Renamed reference', url: '', themes: ['components'] })).type, 'done');
  assert.equal((await rag.list())[0].source.url, undefined, 'Clearing a URL must restore use of the registered local source.');
  assert.match((await rag.search('NE555', { mode: 'bm25' })).results[0].text, /NE555 resistors/);

  const indexedHash = (await rag.state()).documents[id].catalogueHash;
  config.embeddings = false;
  const failed = await edit({ title: 'Pending title', url: '', themes: ['components'] });
  assert.equal(failed.type, 'error'); assert.equal(failed.catalogueSaved, true); assert.equal(failed.documentStatus, 'stale');
  assert.equal((await rag.list())[0].title, 'Pending title');
  assert.equal((await rag.search('NE555', { mode: 'bm25' })).results[0].stale, true);
  calls = config.embedCalls;
  assert.equal((await edit({ title: 'Pending title', url: '', themes: ['railway', 'components'] })).metadataOnly, true);
  assert.equal(config.embedCalls, calls);
  assert.equal((await rag.state()).documents[id].catalogueHash, indexedHash, 'Theme edits must not conceal a title update awaiting indexing.');
  config.embeddings = true;
  assert.equal((await rag.ingest({ id })).skipped, false);
  assert.ok(config.embedCalls > calls);
  assert.equal((await rag.list()).length, 1);

  const retained = await rag.original(id);
  assert.equal((await post('remove', { id })).status, 200);
  assert.equal((await rag.list()).length, 0);
  assert.equal((await rag.search('NE555', { mode: 'bm25' })).results.length, 0);
  for (const file of [original, sourceFile, retained]) assert.equal(await readFile(file, 'utf8'), originalText);
  assert.equal((await fetch(`${app.url}/documents/${id}/download`)).status, 404);
});

test('frontend management validates edits, prevents unregistered filesystem access and requires local request headers', async t => {
  const { root, options, config, rag, url } = await fixture(t);
  config.sources.set('/web.md', { text: '# Web reference\n\nNE555 current specification.' });
  const { id } = await rag.ingest({ url: `${url}/web.md`, title: 'Web reference', themes: ['electronics'] });
  const app = await startServer({ port: 0, dataDir: options.dataDir, workspace: path.join(root, 'workspace'), chatOptions: { extensions: [] }, ragOptions: options });
  t.after(() => app.close());
  const baseline = await readFile(options.manifest, 'utf8');
  const valid = { id, title: 'Web reference', url: `${url}/web.md`, themes: ['electronics'] };
  for (const change of [{ title: ' ' }, { url: '' }, { url: 'file:///unregistered.md' }, { themes: [] }, { id: 'missing' }]) {
    const response = await fetch(`${app.url}/api/documents/update`, { method: 'POST', headers: { 'X-Haas-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...valid, ...change }) });
    assert.equal((await response.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1).type, 'error');
    assert.equal(await readFile(options.manifest, 'utf8'), baseline);
  }
  const attempt = await fetch(`${app.url}/api/documents/update`, { method: 'POST', headers: { 'X-Haas-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...valid, path: '/unregistered.md' }) });
  assert.equal((await attempt.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1).unchanged, true);
  assert.equal((await rag.list())[0].source.path, undefined);
  assert.equal((await fetch(`${app.url}/api/documents/remove`, { method: 'POST', body: JSON.stringify({ id }) })).status, 403);
  assert.equal((await fetch(`${app.url}/api/documents/update`, { method: 'POST', headers: { 'X-Haas-Request': '1', Origin: 'https://other.example' }, body: JSON.stringify(valid) })).status, 403);
  assert.equal((await rag.list()).length, 1);
});

test('frontend retry recovers failed and stale documents using their existing IDs and current catalogue sources', async t => {
  const { root, options, config, rag, url } = await fixture(t);
  const initialUrl = `${url}/missing.md`;
  await assert.rejects(rag.ingest({ url: initialUrl, title: 'Recovery reference', themes: ['electronics'] }), /HTTP 404/);
  const failed = (await rag.list())[0];
  assert.equal(failed.status.status, 'failed');
  const app = await startServer({ port: 0, dataDir: options.dataDir, workspace: path.join(root, 'workspace'), chatOptions: { extensions: [] }, ragOptions: options });
  t.after(() => app.close());
  const retry = async value => {
    const response = await fetch(`${app.url}/api/documents/retry`, { method: 'POST', headers: { 'X-Haas-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200);
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  };
  config.sources.set('/missing.md', { text: '# Reference\n\nNE555 initial current specification.' });
  const first = await retry({ id: failed.id });
  assert.ok(first.some(event => event.stage === 'embedding'));
  assert.equal(first.at(-1).type, 'done');
  assert.equal(first.at(-1).id, failed.id);
  assert.equal((await rag.list())[0].status.status, 'ready');
  const retained = await rag.original(failed.id);
  await assert.rejects(rag.update(failed.id, { title: 'Updated recovery reference', url: `${url}/revised.md`, themes: ['reference', 'electronics'] }), /HTTP 404/);
  const unavailable = await retry({ id: failed.id });
  assert.equal(unavailable.at(-1).type, 'error');
  assert.equal(unavailable.at(-1).documentStatus, 'stale');
  assert.match((await rag.search('NE555', { mode: 'bm25' })).results[0].text, /initial/);
  assert.equal((await rag.search('NE555', { mode: 'bm25' })).results[0].stale, true);
  config.sources.set('/revised.md', { text: '# Revised\n\nNE556 revised current specification.' });
  const recovered = await retry({ id: failed.id, url: initialUrl, title: 'Ignored old draft', themes: ['ignored'], path: '/unregistered.txt' });
  assert.equal(recovered.at(-1).type, 'done');
  const documents = await rag.list();
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, failed.id);
  assert.equal(documents[0].title, 'Updated recovery reference');
  assert.equal(documents[0].source.url, `${url}/revised.md`);
  assert.equal(documents[0].source.path, undefined);
  assert.deepEqual(documents[0].themes, ['reference', 'electronics']);
  assert.equal(documents[0].status.status, 'ready');
  assert.equal(documents[0].status.error, undefined);
  assert.equal((await rag.search('NE555', { mode: 'bm25' })).results.length, 0);
  assert.match((await rag.search('NE556', { mode: 'bm25' })).results[0].text, /revised/);
  assert.match(await readFile(retained, 'utf8'), /NE555 initial/);
  assert.match(JSON.stringify((await retry({ id: 'unknown' })).at(-1)), /Document not found/);
  assert.equal((await rag.list()).length, 1);
  for (const value of [{}, { id: '../escape' }]) {
    const response = await fetch(`${app.url}/api/documents/retry`, { method: 'POST', headers: { 'X-Haas-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${app.url}/api/documents/retry`, { method: 'POST', body: JSON.stringify({ id: failed.id }) })).status, 403);
});

test('replacement uploads recover missing local sources and retain old indexed content until a retry succeeds', async t => {
  const { root, options, config, rag } = await fixture(t);
  const originalText = '# Original\n\nNE555 original reference.';
  const { id } = await rag.ingest({ name: 'original.md', title: 'Local recovery reference', themes: ['electronics', 'reference'] }, { bytes: Buffer.from(originalText) });
  const original = await rag.original(id);
  await rm(path.resolve(root, (await rag.list())[0].source.path));
  const app = await startServer({ port: 0, dataDir: options.dataDir, workspace: path.join(root, 'workspace'), chatOptions: { extensions: [] }, ragOptions: options });
  t.after(() => app.close());
  const request = async (file, bytes) => {
    const params = file ? `?${new URLSearchParams({ id, name: file, title: 'Ignored filename title', themes: '["ignored"]' })}` : '';
    const response = await fetch(`${app.url}/api/documents/retry${params}`, { method: 'POST',
      headers: { 'X-Haas-Request': '1', 'Content-Type': file ? 'application/octet-stream' : 'application/json' }, body: file ? bytes : JSON.stringify({ id }) });
    assert.equal(response.status, 200);
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1);
  };
  const missing = await request();
  assert.equal(missing.type, 'error');
  assert.match(missing.error, /Restore it or choose a replacement file/);
  assert.equal((await rag.list())[0].status.status, 'stale');
  const replacement = '# Recovered\n\nNE556 replacement reference.';
  config.embeddings = false;
  const failedReplacement = await request('recovered.md', replacement);
  assert.equal(failedReplacement.type, 'error');
  assert.equal(failedReplacement.documentStatus, 'stale');
  const pending = (await rag.list())[0];
  assert.equal(pending.id, id);
  assert.equal(pending.title, 'Local recovery reference');
  assert.deepEqual(pending.themes, ['electronics', 'reference']);
  assert.match(pending.source.path, /recovered\.md$/);
  assert.equal(await readFile(path.resolve(root, pending.source.path), 'utf8'), replacement);
  assert.equal(await readFile(await rag.original(id), 'utf8'), originalText);
  assert.match((await rag.search('NE555', { mode: 'bm25' })).results[0].text, /original/);
  config.embeddings = true;
  assert.equal((await request()).type, 'done', 'Retry must read the registered replacement without another upload.');
  const recovered = (await rag.list())[0];
  assert.equal((await rag.list()).length, 1);
  assert.equal(recovered.status.status, 'ready');
  assert.equal(recovered.status.error, undefined);
  assert.equal(recovered.id, id);
  assert.equal(recovered.title, pending.title);
  assert.deepEqual(recovered.themes, pending.themes);
  assert.equal(await readFile(await rag.original(id), 'utf8'), replacement);
  assert.equal(await readFile(original, 'utf8'), originalText);
  assert.equal((await rag.search('NE555', { mode: 'bm25' })).results.length, 0);
  assert.match((await rag.search('NE556', { mode: 'bm25' })).results[0].text, /replacement/);
  const manifest = await readFile(options.manifest, 'utf8');
  assert.equal((await request('empty.md', '')).type, 'error');
  assert.equal(await readFile(options.manifest, 'utf8'), manifest);
});

test('one writer spans separate Rag instances and cancellation leaves no partial searchable document', async t => {
  const { rag, options } = await fixture(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = rag.write(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  try { await assert.rejects(new Rag(options).ingest({ name: 'blocked.txt', themes: ['test'] }, { bytes: Buffer.from('Blocked document.') }), /writer is active/); }
  finally { release(); await blocked; }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(rag.ingest({ name: 'cancelled.txt', themes: ['test'] }, { bytes: Buffer.from('Never indexed.'), signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await rag.search('Never indexed')).results.length, 0);
  const added = await new Rag(options).ingest({ name: 'ready.txt', themes: ['test'] }, { bytes: Buffer.from('Resistor current limit.') });
  assert.equal((await rag.search('Resistor')).results[0].documentId, added.id);
});

test('explicit retrieval modes keep BM25 offline and never disguise failed semantic search as fallback', async t => {
  const { rag } = await fixture(t);
  const doc = await rag.ingest({ name: 'timer.md', themes: ['electronics'] }, { bytes: Buffer.from('# Reset\n\nNE555 RESET stops the timer.') });
  const semantic = await rag.search('NE555', { mode: 'semantic' });
  assert.equal(semantic.mode, 'semantic');
  assert.equal(semantic.results[0].documentId, doc.id);
  rag.fetch = async () => { throw new Error('Ollama must not be called for BM25.'); };
  const bm25 = await rag.search('NE555', { mode: 'bm25' });
  assert.equal(bm25.mode, 'bm25');
  assert.equal(bm25.results[0].documentId, doc.id);
  assert.equal(bm25.warning, undefined);
  await assert.rejects(rag.search('NE555', { mode: 'semantic' }), /Ollama must not be called/);
  const fallback = await rag.search('NE555');
  assert.equal(fallback.mode, 'bm25');
  assert.match(fallback.warning, /Semantic search skipped/);
  await assert.rejects(rag.search('NE555', { mode: 'unknown' }), /Search mode/);
});

test('retrieval evaluation runs real isolated indexing and all search modes without requiring an installed model', async t => {
  const { rag, url, options, config, model } = await fixture(t);
  await rag.ingest({ name: 'private.md', themes: ['private'] }, { bytes: Buffer.from('Private NE555 design notes.') });
  const manifestBefore = await readFile(options.manifest, 'utf8');
  const stateBefore = await readFile(path.join(rag.directory, 'state.json'), 'utf8');
  const report = await runEvaluation({ ollamaUrl: url, model });
  assert.equal(report.passed, true, JSON.stringify(report.structuralFailures));
  assert.equal(report.embedding.dimensions, 8);
  assert.equal(report.embedding.digest, config.digest);
  assert.equal(report.queries.length, report.corpus.queries * 3);
  assert.ok(report.corpus.passages > report.corpus.documents);
  for (const mode of ['bm25', 'semantic', 'hybrid']) {
    assert.equal(report.modes[mode].queries, report.corpus.queries);
    assert.equal(report.modes[mode].structuralFailures, 0);
    assert.ok(report.modes[mode].unsupported.queries > 0);
    assert.ok(report.modes[mode].byTag['cross-language']);
    assert.ok(report.modes[mode].latency.medianMs >= 0);
  }
  assert.ok(report.modes.semantic.unsupported.queriesWithResults > 0, 'Unsupported questions must expose the lack of a relevance threshold.');
  assert.ok(report.queries.some(row => row.metrics?.hitAtK === false), 'Poor synthetic embeddings must be reported as ranking misses, not fail the baseline.');
  assert.equal(await readFile(options.manifest, 'utf8'), manifestBefore);
  assert.equal(await readFile(path.join(rag.directory, 'state.json'), 'utf8'), stateBefore);
  assert.ok(!JSON.stringify(report).includes('Private NE555 design notes'));
});
