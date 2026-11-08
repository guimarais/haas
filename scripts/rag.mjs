import { parseArgs } from 'node:util';
import path from 'node:path';
import { Rag } from '../rag.mjs';

const help = `Local document catalogue and hybrid search

  npm run rag -- add <URL|file> --theme <name> [--theme <name>] [--title <title>] [--source-url <URL>]
  npm run rag -- ingest <document-id>
  npm run rag -- list
  npm run rag -- search <query> [--theme <name>] [--limit 8] [--exact]
  npm run rag -- themes <document-id> --theme <name> [--theme <name>]
  npm run rag -- remove <document-id>
  npm run rag -- rebuild
  npm run rag -- optimize [--ann]
  npm run rag -- unlock

Optional: --manifest <JSON file> --data-dir <directory>
Rebuild fetches current URLs and requires retained files for local-only sources.
--ann creates a cosine IVF_HNSW_SQ vector index; benchmark exact search first.
unlock removes only a lock whose recorded writer process is no longer running.`;

try {
  const { values, positionals: [command, argument] } = parseArgs({ allowPositionals: true, options: {
    theme: { type: 'string', multiple: true }, title: { type: 'string' }, 'source-url': { type: 'string' },
    manifest: { type: 'string' }, 'data-dir': { type: 'string' }, limit: { type: 'string' },
    ann: { type: 'boolean' }, exact: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!command || values.help) console.log(help);
  else {
    const rag = new Rag({ ...(values.manifest ? { manifest: path.resolve(values.manifest) } : {}), ...(values['data-dir'] ? { dataDir: path.resolve(values['data-dir']) } : {}) });
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const progress = event => console.error(JSON.stringify(event));
    let output;
    switch (command) {
      case 'add':
        if (!argument) throw new Error('Supply a URL or local file.');
        output = await rag.ingest({ ...(/^https?:\/\//i.test(argument) ? { url: argument } : { path: path.resolve(argument), url: values['source-url'] }),
          title: values.title, themes: values.theme }, { signal: controller.signal, onProgress: progress });
        break;
      case 'ingest': output = await rag.ingest({ id: argument }, { signal: controller.signal, onProgress: progress }); break;
      case 'list': output = await rag.list(); break;
      case 'search': output = await rag.search(argument, { themes: values.theme, limit: Number(values.limit || 8), exact: values.exact, signal: controller.signal }); break;
      case 'themes': output = await rag.assignThemes(argument, values.theme); break;
      case 'remove': output = await rag.remove(argument); break;
      case 'rebuild': output = await rag.rebuild({ signal: controller.signal, onProgress: progress }); if (output.failed) process.exitCode = 1; break;
      case 'optimize': output = await rag.optimize({ ann: values.ann }); break;
      case 'unlock': output = await rag.unlock(); break;
      default: throw new Error(help);
    }
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
