import { lstat, mkdir, readdir, realpath, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve existing ancestors too: a symlink must not turn an allowed write into an escape.
export async function safePath(root, input = '.') {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.startsWith('~')) {
    throw new Error('Use a project path inside the workspace.');
  }
  const target = path.resolve(root, input);
  if (!isWithin(root, target)) throw new Error('Path is outside the project workspace.');
  let ancestor = target;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (!isWithin(root, resolved)) throw new Error('Path follows a symlink outside the workspace.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return target;
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export async function listFiles(root, dir = root, results = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(root, file, results);
    else if (entry.isFile()) results.push({ path: path.relative(root, file), size: (await lstat(file)).size });
    if (results.length >= 300) break;
  }
  return results;
}

const pathKey = /(^|_)(path|file|filename|dir|directory|schematic|pcb|board|project|output|input|source|destination|target)(_|$)/i;

// Konnect takes explicit design paths. Inspect nested arguments as well as top-level ones.
export async function confineArguments(root, args, schema = {}, key = '') {
  if (typeof args === 'string') {
    const description = schema.description || '';
    if (pathKey.test(key) || /path to|file path|directory path|output directory/i.test(description)) {
      return safePath(root, args);
    }
    if (['name', 'new_name', 'output_name'].includes(key) && /[\\/]/.test(args)) throw new Error('Names must not contain path separators.');
    return args;
  }
  if (Array.isArray(args)) return Promise.all(args.map(value => confineArguments(root, value, schema.items, key)));
  if (args && typeof args === 'object') {
    for (const [name, value] of Object.entries(args)) {
      args[name] = await confineArguments(root, value, schema.properties?.[name], name);
    }
  }
  return args;
}
