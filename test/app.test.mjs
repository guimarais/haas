import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { APP, closeChat, createChat, searchTool, transcript, workspaceGuard } from '../agent.mjs';
import { confineArguments, safePath } from '../workspace.mjs';
import { startServer } from '../server.mjs';

test('workspace guards reject traversal, symlink escapes, nested MCP paths and global mutations', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haas-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'workspace');
  await mkdir(root);
  await mkdir(path.join(dir, 'elsewhere'));
  await symlink(path.join(dir, 'elsewhere'), path.join(root, 'escape'));
  assert.equal(await safePath(root, 'board/new.kicad_pcb'), path.join(root, 'board/new.kicad_pcb'));
  await assert.rejects(safePath(root, '../original.kicad_pcb'), /outside/);
  await assert.rejects(safePath(root, 'escape/new.kicad_pcb'), /symlink/);
  await assert.rejects(confineArguments(root, { options: [{ output_dir: '../../elsewhere' }] }), /outside/);
  await assert.rejects(confineArguments(root, { name: '../board' }), /separators/);
  const args = await confineArguments(root, { board: 'test.kicad_pcb', net_name: '/USB/D+' });
  assert.equal(args.board, path.join(root, 'test.kicad_pcb'));
  assert.equal(args.net_name, '/USB/D+');
  const handlers = {};
  workspaceGuard(root, path.join(APP, 'skills'))({ on: (name, handler) => { handlers[name] = handler; }, getAllTools: () => [] });
  const guard = handlers.tool_call;
  assert.equal(await guard({ toolName: 'write', input: { path: 'safe.txt' } }), undefined);
  assert.equal((await guard({ toolName: 'write', input: { path: '../unsafe.txt' } })).block, true);
  assert.equal((await guard({ toolName: 'mcp__konnect__save_project', input: {} })).block, true);
  assert.equal((await guard({ toolName: 'mcp__konnect__add_design_rule', input: { scope: 'user' } })).block, true);
  assert.equal(await guard({ toolName: 'read', input: { path: path.join(APP, 'skills/component-research/SKILL.md') } }), undefined);
  assert.equal((await guard({ toolName: 'mcp__konnect__register_symbol_library', input: { scope: 'global' } })).block, true);
  const fullOutputPath = path.join(dir, 'large-output.txt');
  await writeFile(fullOutputPath, 'large result');
  const relocated = await handlers.tool_result({ details: { fullOutputPath }, content: [{ type: 'text', text: `Read ${fullOutputPath}` }] });
  assert.ok(relocated.details.fullOutputPath.startsWith(path.join(root, '.tool-results')));
  assert.equal(await readFile(relocated.details.fullOutputPath, 'utf8'), 'large result');
  assert.ok(!relocated.content[0].text.includes(fullOutputPath));
});

test('search requires actual hosted search, preserves citations and propagates failures/cancellation', async () => {
  let captured;
  const tool = searchTool({ apiKey: 'test-key', model: 'search-check', fetchImpl: async (_url, options) => {
    captured = options;
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Observed offer; shipping unknown.', annotations: [{ type: 'url_citation', url: 'https://vendor.example/part', title: 'Exact part' }] }] }] }) };
  } });
  const result = await tool.execute('check', { query: '10 exact parts to Portugal' });
  const request = JSON.parse(captured.body);
  assert.equal(request.tool_choice, 'required');
  assert.equal(request.tools[0].type, 'web_search');
  assert.equal(request.tools[0].user_location.country, 'PT');
  assert.equal(request.store, false);
  assert.match(result.content[0].text, /\[Exact part\]\(https:\/\/vendor.example\/part\)/);
  assert.match(result.content[0].text, /Retrieved:/);
  const failure = searchTool({ apiKey: 'test-key', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(failure.execute('check', { query: 'parts' }), /HTTP 429/);
  const missingKey = searchTool({ apiKey: '' });
  await assert.rejects(missingKey.execute('check', { query: 'parts' }), /OPENAI_API_KEY/);
  const abort = new AbortController(); abort.abort();
  const cancelled = searchTool({ apiKey: 'test-key', fetchImpl: async (_url, { signal }) => { signal.throwIfAborted(); } });
  await assert.rejects(cancelled.execute('check', { query: 'parts' }, abort.signal), { name: 'AbortError' });
});

test('Pi executes model-selected skill and search tools, streams the answer and restores history', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haas-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks)); requests.push(request);
    const turn = requests.length;
    const tools = turn === 1
      ? [{ index: 0, id: 'skill_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(APP, 'skills/component-research/SKILL.md') }) } }]
      : turn === 2
        ? [{ index: 0, id: 'search_1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '10 NE555P timers Portugal EUR' }) } }]
        : null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'check', object: 'chat.completion.chunk', created: 1, model: 'scripted', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', ...(tools ? { tool_calls: tools } : { content: 'A sourced offer is ready: https://vendor.example/part. Shipping is unknown.' }) });
    send({}, tools ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, modelsStorePath: path.join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('ollama', {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'test-key',
    models: [{ id: 'scripted', name: 'Scripted check', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }],
  });
  const chat = await createChat({ runtime, dataDir: path.join(dir, 'data'), workspace: path.join(dir, 'workspace'), extensions: [],
    customTools: [searchTool({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Offer: EUR 1; shipping unknown.', annotations: [{ type: 'url_citation', url: 'https://vendor.example/part', title: 'Vendor' }] }] }] }) }) })],
  });
  t.after(() => closeChat(chat));
  await chat.session.setModel(runtime.getModel('ollama', 'scripted'));
  const events = [];
  chat.session.subscribe(event => events.push(event));
  await chat.session.prompt('Research prices for 10 NE555P timers to Portugal.', { expandPromptTemplates: false });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.match(requests[0].messages.map(message => message.content).join('\n'), /component-research/);
  assert.ok(!requests[0].tools.some(tool => tool.function.name === 'bash'));
  assert.deepEqual(events.filter(event => event.type === 'tool_execution_start').map(event => event.toolName), ['read', 'web_search']);
  assert.ok(events.some(event => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'));
  assert.match(chat.session.getLastAssistantText(), /sourced offer/);
  const saved = SessionManager.open(chat.session.sessionManager.getSessionFile());
  assert.match(JSON.stringify(saved.buildSessionContext().messages), /Shipping is unknown/);
  assert.deepEqual(chat.skills.sort(), ['component-research', 'kicad', 'turnout']);
  assert.ok(transcript(chat.session).some(message => message.role === 'tool' && message.name === 'web_search'));
  const fresh = await createChat({ fresh: true, runtime, dataDir: path.join(dir, 'data'), workspace: path.join(dir, 'workspace'), extensions: [] });
  const emptySessionFile = fresh.session.sessionManager.getSessionFile();
  await closeChat(fresh);
  const restoredEmpty = await createChat({ sessionFile: emptySessionFile, runtime, dataDir: path.join(dir, 'data'), workspace: path.join(dir, 'workspace'), extensions: [] });
  t.after(() => closeChat(restoredEmpty));
  assert.equal(transcript(restoredEmpty.session).length, 0, 'A new empty chat must not restore an older conversation.');
});

test('conversation history reopens saved messages and tools, rejects unknown IDs and remembers selection', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'haas-history-'));
  const workspace = path.join(dir, 'workspace');
  const dataDir = path.join(dir, 'data');
  await mkdir(workspace, { recursive: true });
  const sessions = path.join(dataDir, 'sessions');
  const first = SessionManager.create(workspace, sessions);
  first.appendMessage({ role: 'user', content: 'Compare component prices', timestamp: Date.now() });
  first.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved comparison.' }], api: 'openai-completions', provider: 'ollama', model: 'check', stopReason: 'stop', timestamp: Date.now() });
  first.appendMessage({ role: 'toolResult', toolCallId: 'saved-tool', toolName: 'web_search', content: [{ type: 'text', text: 'Saved source links.' }], isError: false, timestamp: Date.now() });
  const second = SessionManager.create(workspace, sessions);
  second.appendMessage({ role: 'user', content: 'Plan a railway', timestamp: Date.now() });
  second.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved layout discussion.' }], api: 'openai-completions', provider: 'ollama', model: 'check', stopReason: 'stop', timestamp: Date.now() });
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const options = { port: 0, workspace, dataDir, chatOptions: { extensions: [] } };
  app = await startServer(options);
  const getState = async () => (await fetch(`${app.url}/api/state`)).json();
  const open = id => fetch(`${app.url}/api/conversations/open`, { method: 'POST', headers: { 'X-Haas-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  let state = await getState();
  assert.ok(state.conversations.some(chat => chat.title === 'Compare component prices'));
  assert.ok(state.conversations.some(chat => chat.title === 'Plan a railway'));
  assert.equal((await open(first.getSessionId())).status, 200);
  state = await getState();
  assert.equal(state.conversations.find(chat => chat.active).id, first.getSessionId());
  assert.ok(state.messages.some(message => message.text === 'Saved comparison.'));
  assert.ok(state.messages.some(message => message.role === 'tool' && message.text === 'Saved source links.'));
  assert.equal((await open('../../outside.jsonl')).status, 404);
  assert.equal((await getState()).conversations.find(chat => chat.active).id, first.getSessionId());
  await app.close(); app = undefined;
  app = await startServer(options);
  assert.equal((await getState()).conversations.find(chat => chat.active).id, first.getSessionId());
  assert.equal((await open(second.getSessionId())).status, 200);
  assert.ok((await getState()).messages.some(message => message.text === 'Saved layout discussion.'));
  const fresh = await fetch(`${app.url}/api/new`, { method: 'POST', headers: { 'X-Haas-Request': '1' } });
  assert.equal(fresh.status, 200);
  state = await getState();
  assert.equal(state.messages.length, 0);
  assert.equal(state.conversations.filter(chat => chat.active).length, 1);
  assert.ok(state.conversations.some(chat => chat.id === first.getSessionId()));
});
