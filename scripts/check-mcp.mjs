import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeChat, createChat, messageText } from '../agent.mjs';
import { isWithin } from '../workspace.mjs';

// Fixed-argument integration check: exercises the real servers without model/API charges.
const temporary = await mkdtemp(path.join(tmpdir(), 'haas-mcp-'));
const workspace = path.join(temporary, 'workspace');
let chat;
try {
  chat = await createChat({ fresh: true, workspace, dataDir: path.join(temporary, 'data'), onWarning: console.error });
  async function tool(name) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const definition = chat.session.getToolDefinition(name);
      if (definition) return definition;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`MCP tool was not registered: ${name}`);
  }
  async function call(name, args) {
    const result = await (await tool(name)).execute(randomUUID(), args, AbortSignal.timeout(30_000));
    if (result.isError || result.details?.isError) throw new Error(messageText(result));
    return messageText(result.structuredContent || result);
  }
  await call('mcp__konnect__list_toolboxes', {});
  const project = path.join(workspace, 'connection-check');
  await call('mcp__konnect__create_project', { path: project, name: 'check' });
  assert.match(await readFile(path.join(project, 'check.kicad_sch'), 'utf8'), /kicad_sch/);
  assert.match(await readFile(path.join(project, 'check.kicad_pcb'), 'utf8'), /kicad_pcb/);
  await call('mcp__konnect__load_toolset', { name: ['sch_export', 'verification'] });
  await call('mcp__konnect__run_erc', { schematic: path.join(project, 'check.kicad_sch'), output: path.join(project, 'erc.json') });
  await call('mcp__konnect__run_drc', { board: path.join(project, 'check.kicad_pcb'), output: path.join(project, 'drc.json') });
  await call('mcp__konnect__export_schematic_svg', { schematic: path.join(project, 'check.kicad_sch'), output: path.join(project, 'schematic.svg') });
  console.log('PASS Konnect: native files, dynamic tool-list updates, ERC, DRC and SVG export.');
  const parts = [...Array(6).fill('24130'), '24188', ...Array(6).fill('24130'), '24188'];
  const layout = JSON.parse(await call('mcp__turnout__build_layout', { parts, width_mm: 2000, height_mm: 1200 }));
  assert.equal(layout.ok, true, JSON.stringify(layout.errors));
  assert.ok(isWithin(workspace, layout.path));
  const inspected = JSON.parse(await call('mcp__turnout__inspect_layout', { path: layout.path }));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.piece_count, 14);
  assert.equal(inspected.open_endpoint_count, 0);
  assert.ok(isWithin(workspace, inspected.preview_path));
  assert.match(await readFile(inspected.preview_path, 'utf8'), /<svg/);
  console.log('PASS Turnout: closed 14-piece XTrackCAD layout, inspection and SVG preview, all inside the workspace.');
} finally {
  if (chat) await closeChat(chat);
  await rm(temporary, { recursive: true, force: true });
}
