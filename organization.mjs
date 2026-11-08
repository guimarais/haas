import { cp, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { atomicJson, safePath } from './workspace.mjs';
import { documentConversation } from './rag-tools.mjs';

const execute = promisify(execFile);
const missing = message => Object.assign(new Error(message), { status: 404 });
async function exists(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Each chat or project owns its files and sessions. Runtime credentials stay outside these roots.
export class Organization {
  constructor(dataDir) { this.dataDir = dataDir; }

  async scope(kind, id) {
    if (!['chat', 'project'].includes(kind) || typeof id !== 'string' || !/^(?:[a-f0-9-]{36}|imported-workspace)$/.test(id)) throw missing('Chat or project not found.');
    const root = await safePath(this.dataDir, `${kind}s/${id}`);
    return { kind, id, root, workspace: path.join(root, 'workspace'), sessionDir: path.join(root, 'sessions') };
  }

  async get(kind, id) {
    const scope = await this.scope(kind, id);
    try { return { ...JSON.parse(await readFile(path.join(scope.root, 'haas.json'), 'utf8')), ...scope }; }
    catch (error) { if (error.code === 'ENOENT') throw missing('Chat or project not found.'); throw error; }
  }

  async create(kind, { name = '', description = '' } = {}, id = randomUUID()) {
    if (typeof name !== 'string' || name.trim().length > 120 || (kind === 'project' && !name.trim())) throw new Error('Project names must contain 1–120 characters.');
    if (typeof description !== 'string' || description.length > 4000) throw new Error('Descriptions must contain at most 4,000 characters.');
    const scope = await this.scope(kind, id);
    await mkdir(scope.workspace, { recursive: true, mode: 0o700 });
    await mkdir(scope.sessionDir, { recursive: true, mode: 0o700 });
    const metadata = { name: name.trim(), description: description.trim(), createdAt: new Date().toISOString() };
    await atomicJson(path.join(scope.root, 'haas.json'), metadata);
    return { ...metadata, ...scope };
  }

  async save(scope, changes) {
    const metadata = JSON.parse(await readFile(path.join(scope.root, 'haas.json'), 'utf8'));
    await atomicJson(path.join(scope.root, 'haas.json'), { ...metadata, ...changes });
  }

  async list(kind) {
    const directory = path.join(this.dataDir, `${kind}s`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory, { withFileTypes: true });
    const scopes = [];
    for (const entry of entries) if (entry.isDirectory()) scopes.push(await this.get(kind, entry.name));
    return scopes;
  }

  async sessions(scope) {
    return SessionManager.listAll(scope.sessionDir);
  }

  async git(scope, args) {
    // Never inherit a caller's GIT_DIR/worktree, or allow repository hooks to execute.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const { stdout } = await execute('git', ['-C', scope.root, '-c', 'core.hooksPath=/dev/null', ...args], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout;
  }

  async tracking(scope) {
    const git = await exists(path.join(scope.root, '.git'));
    if (git && (!git.isDirectory() || git.isSymbolicLink())) throw new Error('Expected an app-owned Git directory.');
    return !!git;
  }

  async snapshot(scope) {
    if (!await this.tracking(scope)) throw new Error('Enable Git tracking first.');
    await this.git(scope, ['add', '--all', '--', '.']);
    if ((await this.git(scope, ['diff', '--cached', '--name-only'])).trim()) {
      await this.git(scope, ['-c', 'user.name=Haas', '-c', 'user.email=haas@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Save work']);
    }
  }

  async setTracking(scope, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Git tracking must be true or false.');
    const archive = path.join(this.dataDir, 'git-history', `${scope.kind}-${scope.id}`);
    const active = await this.tracking(scope);
    if (enabled) {
      if (!active) {
        if (await exists(archive)) await rename(archive, path.join(scope.root, '.git'));
        else {
          await this.git(scope, ['-c', 'init.defaultBranch=main', 'init', '--template=']);
          await writeFile(path.join(scope.root, '.gitignore'), 'workspace/.tool-results/\n', { flag: 'a' });
        }
      }
      try { await this.snapshot(scope); }
      catch (error) {
        if (!active) {
          await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
          await rename(path.join(scope.root, '.git'), archive);
        }
        throw error;
      }
    } else if (active) {
      await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
      await rename(path.join(scope.root, '.git'), archive);
    }
  }

  async publicScope(scope) {
    return { kind: scope.kind, id: scope.id, name: scope.name, description: scope.description, createdAt: scope.createdAt, gitTracked: await this.tracking(scope) };
  }

  async migrate(legacyWorkspace) {
    const marker = path.join(this.dataDir, 'organization-migration.json');
    if (await exists(marker)) return;
    const sessions = await SessionManager.listAll(path.join(this.dataDir, 'sessions'));
    const files = await exists(legacyWorkspace) ? await readdir(legacyWorkspace) : [];
    if (sessions.length || files.length) {
      const scope = await this.create('project', { name: 'Imported workspace', description: 'Conversations and files from the original shared workspace.' }, 'imported-workspace');
      if (files.length) await cp(legacyWorkspace, scope.workspace, { recursive: true });
      for (const session of sessions) await cp(session.path, path.join(scope.sessionDir, path.basename(session.path)));
      if (sessions.some(session => documentConversation(SessionManager.open(session.path)))) {
        await atomicJson(path.join(scope.root, 'local-only.json'), { migrated: true });
      }
      let current;
      try { current = JSON.parse(await readFile(path.join(this.dataDir, 'current-session.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicJson(path.join(this.dataDir, 'current-session.json'), { kind: 'project', id: scope.id,
        sessionFile: current?.sessionFile ? path.join(scope.sessionDir, path.basename(current.sessionFile)) : sessions[0]?.path && path.join(scope.sessionDir, path.basename(sessions[0].path)) });
    }
    await atomicJson(marker, { version: 1 });
  }
}
