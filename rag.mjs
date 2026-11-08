import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lance from '@lancedb/lancedb';
import { convert } from 'html-to-text';
import { atomicJson } from './workspace.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const PIPELINE = 1;
const hash = value => createHash('sha256').update(value).digest('hex');
const sql = value => `'${String(value).replaceAll("'", "''")}'`;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function localOllamaUrl(value = process.env.OLLAMA_URL || 'http://127.0.0.1:11434') {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw failure('Document inference requires Ollama on localhost, 127.0.0.1, or ::1.');
  }
  return url.href.replace(/\/$/, '');
}

export function sourceUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('Use an HTTP(S) download URL without credentials.');
  url.hash = '';
  return url.href;
}

export function themes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw failure('Supply between 1 and 30 themes.');
  const result = value.map(name => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f]/.test(name)) throw failure('Theme names must contain 1–80 printable characters.');
    return name.trim().toLowerCase();
  });
  return [...new Set(result)];
}

function validateDocument(doc) {
  if (!doc || typeof doc.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(doc.id)) throw failure('Document IDs must contain 1–80 letters, digits, underscores or hyphens.');
  if (typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 500) throw failure('Document titles must contain 1–500 characters.');
  if (!doc.source || (!doc.source.url && !doc.source.path)) throw failure(`Document ${doc.id} needs a source URL or local path.`);
  if (doc.source.url) doc.source.url = sourceUrl(doc.source.url);
  if (doc.source.path && (typeof doc.source.path !== 'string' || doc.source.path.includes('\0'))) throw failure('Invalid local source path.');
  return { id: doc.id, title: doc.title.trim(), source: { ...doc.source }, themes: themes(doc.themes) };
}

async function boundedBytes(response, signal) {
  if (!response.ok) throw failure(`Download failed (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > MAX_DOCUMENT_BYTES) { await response.body?.cancel(); throw failure('Document exceeds 25 MiB.'); }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > MAX_DOCUMENT_BYTES) throw failure('Document exceeds 25 MiB.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export async function extractDocument(bytes, name = '', contentType = '') {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw failure('Documents must contain between 1 byte and 25 MiB.');
  const extension = path.extname(name.split('?')[0]).toLowerCase();
  if (bytes.subarray(0, 5).toString() === '%PDF-') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      cMapUrl: fileURLToPath(new URL('cmaps/', pdfRoot)), cMapPacked: true,
      standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', pdfRoot)) });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 10_000) throw failure('PDFs above 10,000 pages are not supported.');
      const sections = [];
      let size = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        const contents = await (await pdf.getPage(page)).getTextContent();
        const text = contents.items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('');
        size += text.length;
        if (size > 10_000_000) throw failure('Extracted document exceeds 10 million characters.');
        sections.push({ page, text });
      }
      return { format: 'pdf', sections };
    } finally { await task.destroy(); }
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.length > 10_000_000 || text.includes('\0')) throw failure('Document is too large or is not supported text.');
  if (/text\/html/i.test(contentType) || ['.html', '.htm'].includes(extension) || /^\s*(?:<!doctype html|<html)/i.test(text)) {
    return { format: 'html', sections: [{ page: 0, text: convert(text, {
      wordwrap: false, selectors: [
        ...['script', 'style', 'nav', 'footer', 'header', 'aside', 'form'].map(selector => ({ selector, format: 'skip' })),
        ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(selector => ({ selector, format: 'ragHeading' })),
        { selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' },
      ],
      formatters: { ragHeading(elem, walk, builder) { builder.openBlock({ leadingLineBreaks: 2 }); builder.addInline('# '); walk(elem.children, builder); builder.closeBlock({ trailingLineBreaks: 2 }); } },
    }) }] };
  }
  if (extension && !['.md', '.markdown', '.txt', '.text'].includes(extension) && !/^text\/(plain|markdown)/i.test(contentType)) {
    throw failure('Supported formats are PDF, HTML, Markdown and UTF-8 plain text.');
  }
  return { format: ['.md', '.markdown'].includes(extension) ? 'md' : 'txt', sections: [{ page: 0, text }] };
}

export function chunkDocument(sections) {
  const chunks = [];
  let heading = '';
  for (const { text, page = 0 } of sections) {
    let buffer = '';
    const flush = () => { if (buffer.trim()) chunks.push({ text: buffer.trim(), page, section: heading }); buffer = ''; };
    // ponytail: ~4 characters per token; a model tokenizer is warranted if exact token budgets become necessary.
    for (const paragraph of text.replaceAll('\r\n', '\n').split(/\n\s*\n|(?=^#{1,6}\s)/m)) {
      const match = /^#{1,6}\s+([^\n]+)/.exec(paragraph);
      if (match) { flush(); heading = match[1].trim(); }
      if (buffer.length + paragraph.length > 2000) flush();
      let remainder = paragraph.trim();
      while (remainder.length > 2000) {
        const boundary = Math.max(remainder.lastIndexOf(' ', 2000), remainder.lastIndexOf('\n', 2000));
        const end = boundary > 1500 ? boundary : 2000;
        chunks.push({ text: remainder.slice(0, end).trim(), page, section: heading });
        remainder = remainder.slice(end).trimStart();
      }
      buffer += `${buffer ? '\n\n' : ''}${remainder}`;
    }
    flush();
  }
  if (!chunks.length) throw failure('No searchable text found. Scanned PDFs require OCR, which is not supported.');
  // Add a small overlap between adjacent passages within the same page and section.
  return chunks.map((chunk, i) => ({ ...chunk, text: i && chunks[i - 1].page === chunk.page && chunks[i - 1].section === chunk.section
    ? `${chunks[i - 1].text.slice(-250)}\n\n${chunk.text}` : chunk.text }));
}

export class Rag {
  constructor({ dataDir = path.join(ROOT, 'data'), manifest = path.join(ROOT, 'documents.json'), projectDir = ROOT,
    ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model = process.env.RAG_EMBEDDING_MODEL || 'qwen3-embedding:0.6b', fetchImpl = fetch } = {}) {
    this.directory = path.join(dataDir, 'rag');
    this.manifest = manifest;
    this.projectDir = projectDir;
    this.ollamaUrl = ollamaUrl;
    this.model = model;
    this.fetch = fetchImpl;
  }

  async catalogue() {
    const catalogue = await readJson(this.manifest, { version: 1, documents: [] });
    if (catalogue.version !== 1 || !Array.isArray(catalogue.documents)) throw failure('Invalid documents.json: expected version 1 and a documents array.');
    const docs = catalogue.documents.map(validateDocument);
    if (new Set(docs.map(doc => doc.id)).size !== docs.length) throw failure('Document IDs in the catalogue must be unique.');
    return { version: 1, documents: docs };
  }

  async state() { return readJson(path.join(this.directory, 'state.json'), { documents: {} }); }
  async saveState(state) { await atomicJson(path.join(this.directory, 'state.json'), state); }

  async write(operation) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, 'writer.lock');
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw failure('Another ingestion writer is active. After a crashed process, run npm run rag -- unlock.', 409); throw error; }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, started: now() })); return await operation(); }
    finally { await handle.close(); await unlink(lock); }
  }

  async unlock() {
    const lock = path.join(this.directory, 'writer.lock');
    const owner = await readJson(lock, null);
    if (!owner) return { unlocked: false };
    if (!Number.isInteger(owner.pid)) throw failure('Unrecognised writer lock; inspect it before removing it.');
    try { process.kill(owner.pid, 0); throw failure(`Writer process ${owner.pid} is still running.`, 409); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(lock);
    return { unlocked: true };
  }

  async table(name, rows) {
    if (!name) return null;
    const connection = await lance.connect(path.join(this.directory, 'lancedb'));
    try {
      if ((await connection.tableNames()).includes(name)) return await connection.openTable(name);
      if (!rows) return null;
      const table = await connection.createTable(name, rows);
      try {
        await table.createIndex('search_text', { config: lance.Index.fts({ baseTokenizer: 'icu', stem: false, removeStopWords: false, maxTokenLength: 200, withPosition: true }) });
        await table.createIndex('themes', { config: lance.Index.labelList() });
        return table;
      } catch (error) { table.close(); await connection.dropTable(name); throw error; }
    } finally { connection.close(); }
  }

  async list() {
    const [{ documents }, state] = await Promise.all([this.catalogue(), this.state()]);
    return documents.map(doc => ({ ...doc, rebuildable: !!doc.source.url, status: state.documents[doc.id] || { status: 'pending' } }));
  }

  async modelInfo(signal) {
    const base = localOllamaUrl(this.ollamaUrl);
    if (/:cloud(?:$|[-:])/i.test(this.model)) throw failure('Use a locally installed embedding model, not an Ollama cloud model.');
    const response = await this.fetch(`${base}/api/show`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw failure(`Embedding model unavailable (HTTP ${response.status}). Run ollama pull ${this.model}.`);
    const info = await response.json();
    if (info.remote_model || info.remote_host || info.capabilities?.includes('cloud')) throw failure('Cloud embedding models are disabled.');
    if (!info.capabilities?.includes('embedding')) throw failure('The configured model does not support embeddings.');
    const tags = await this.fetch(`${base}/api/tags`, { redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) });
    if (!tags.ok) throw failure('Could not inspect the local embedding model digest.');
    const installed = (await tags.json()).models?.find(item => item.name === this.model || item.name === `${this.model}:latest`);
    if (!installed?.digest) throw failure('Embedding model must be installed locally and have a model digest.');
    const dimensionKey = Object.keys(info.model_info || {}).find(key => key.endsWith('.embedding_length'));
    const dimensions = info.model_info?.[dimensionKey];
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) throw failure('Could not determine the embedding model dimensions.');
    return { model: this.model, digest: installed.digest, dimensions, pipeline: PIPELINE };
  }

  async embed(inputs, identity, signal, query = false) {
    const response = await this.fetch(`${localOllamaUrl(this.ollamaUrl)}/api/embed`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
      body: JSON.stringify({ model: this.model, truncate: false, input: query && this.model.startsWith('qwen3-embedding')
        ? inputs.map(input => `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${input}`) : inputs }),
    });
    if (!response.ok) throw failure(`Local embedding failed (HTTP ${response.status}). Check Ollama and the configured model.`);
    const { embeddings } = await response.json();
    if (!Array.isArray(embeddings) || embeddings.length !== inputs.length || embeddings.some(vector => !Array.isArray(vector) || vector.length !== identity.dimensions || vector.some(n => !Number.isFinite(n)) || !vector.some(n => n !== 0))) {
      throw failure('Ollama returned invalid or incompatible embeddings.');
    }
    return embeddings;
  }

  async source(doc, signal, suppliedBytes) {
    if (suppliedBytes) return { bytes: suppliedBytes, name: doc.source.path || doc.source.url, contentType: '' };
    if (doc.source.url) {
      const response = await this.fetch(doc.source.url, { redirect: 'follow', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]) });
      return { bytes: await boundedBytes(response, signal), name: new URL(response.url || doc.source.url).pathname, contentType: response.headers.get('content-type') || '' };
    }
    const file = path.resolve(this.projectDir, doc.source.path);
    if ((await stat(file)).size > MAX_DOCUMENT_BYTES) throw failure('Document exceeds 25 MiB.');
    return { bytes: await readFile(file), name: file, contentType: '' };
  }

  async ingestDocument(doc, state, { force = false, signal, onProgress = () => {}, bytes, identity } = {}) {
    signal?.throwIfAborted();
    onProgress({ id: doc.id, stage: 'reading', title: doc.title });
    const source = await this.source(doc, signal, bytes);
    const digest = hash(source.bytes);
    identity ||= await this.modelInfo(signal);
    if (state.embedding && JSON.stringify(identity) !== JSON.stringify(state.embedding)) throw failure('Embedding model or chunking configuration changed. Run rebuild to re-embed the whole collection.');
    const tableName = state.table || `chunks_${hash(JSON.stringify(identity)).slice(0, 16)}`;
    let table = await this.table(tableName);
    try {
      const previous = state.documents[doc.id];
      if (!force && table && previous?.hash === digest && previous?.pipeline === PIPELINE && previous?.catalogueHash === hash(JSON.stringify(doc))) {
        state.documents[doc.id] = { ...previous, status: 'ready', error: undefined, checkedAt: now() };
        return { id: doc.id, skipped: true, chunks: previous.chunks };
      }
      onProgress({ id: doc.id, stage: 'extracting', title: doc.title });
      const extracted = await extractDocument(source.bytes, source.name, source.contentType);
      const passages = chunkDocument(extracted.sections);
      const rows = [];
      for (let start = 0; start < passages.length; start += 16) {
        signal?.throwIfAborted();
        onProgress({ id: doc.id, stage: 'embedding', completed: start, total: passages.length, title: doc.title });
        const batch = passages.slice(start, start + 16);
        const vectors = await this.embed(batch.map(chunk => `${doc.title}\n${chunk.section}\n${chunk.text}`), identity, signal);
        rows.push(...batch.map((chunk, i) => ({ ...chunk, chunk_id: `${doc.id}:${start + i}`, document_id: doc.id,
          title: doc.title, source_url: doc.source.url || '', themes: doc.themes, vector: vectors[i], search_text: `${doc.title}\n${chunk.section}\n${chunk.text}` })));
      }
      signal?.throwIfAborted();
      onProgress({ id: doc.id, stage: 'saving', title: doc.title });
      await mkdir(path.join(this.directory, 'originals'), { recursive: true });
      const original = path.join(this.directory, 'originals', `${doc.id}-${digest}.${extracted.format}`);
      await writeFile(`${original}.tmp`, source.bytes, { mode: 0o600 });
      // Publish the cache only with a successfully indexed version.
      if (table) await table.mergeInsert('chunk_id').whenMatchedUpdateAll().whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where: `document_id = ${sql(doc.id)}` }).execute(rows);
      else table = await this.table(tableName, rows);
      const { rename } = await import('node:fs/promises');
      await rename(`${original}.tmp`, original);
      state.embedding = identity;
      state.table = tableName;
      state.documents[doc.id] = { status: 'ready', hash: digest, catalogueHash: hash(JSON.stringify(doc)), pipeline: PIPELINE,
        chunks: rows.length, original: path.relative(this.directory, original), indexedAt: now(), checkedAt: now() };
      return { id: doc.id, skipped: false, chunks: rows.length };
    } finally { table?.close(); }
  }

  async ingest(input, { bytes, signal, onProgress } = {}) {
    return this.write(async () => {
      const catalogue = await this.catalogue();
      const state = await this.state();
      const url = input.url ? sourceUrl(input.url) : undefined;
      const suppliedPath = input.path ? path.resolve(input.path) : undefined;
      const existing = input.id ? catalogue.documents.find(doc => doc.id === input.id)
        : catalogue.documents.find(doc => url ? doc.source.url === url : suppliedPath && path.resolve(this.projectDir, doc.source.path || '') === suppliedPath);
      if (input.id && !existing) throw failure('Document not found.', 404);
      const id = existing?.id || randomUUID();
      let localPath = suppliedPath ? path.relative(this.projectDir, suppliedPath) : undefined;
      if (bytes) {
        const name = path.basename(input.name || 'upload.txt');
        if (name.length > 180 || /[\x00-\x1f]/.test(name)) throw failure('Invalid upload filename.');
        const original = path.join(this.directory, 'uploads', id, name);
        if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw failure('Documents must contain between 1 byte and 25 MiB.');
        await mkdir(path.dirname(original), { recursive: true });
        await writeFile(original, bytes, { mode: 0o600 });
        localPath = path.relative(this.projectDir, original);
      }
      const doc = validateDocument({ id, title: input.title || existing?.title || input.name || (url ? decodeURIComponent(new URL(url).pathname.split('/').pop()) || new URL(url).hostname : path.basename(localPath || '')),
        themes: input.themes || existing?.themes, source: { ...(existing?.source || {}), ...(url ? { url } : {}), ...(localPath ? { path: localPath } : {}) } });
      if (existing) catalogue.documents[catalogue.documents.indexOf(existing)] = doc;
      else catalogue.documents.push(doc);
      await atomicJson(this.manifest, catalogue);
      try {
        const result = await this.ingestDocument(doc, state, { bytes, signal, onProgress });
        await this.saveState(state);
        return result;
      } catch (error) {
        state.documents[id] = { ...state.documents[id], status: state.documents[id]?.indexedAt ? 'stale' : 'failed', error: error.message, checkedAt: now() };
        await this.saveState(state);
        throw error;
      }
    });
  }

  async rebuild({ signal, onProgress = () => {} } = {}) {
    return this.write(async () => {
      const { documents } = await this.catalogue();
      const previous = await this.state();
      const identity = documents.length ? await this.modelInfo(signal) : previous.embedding;
      const changed = previous.embedding && JSON.stringify(previous.embedding) !== JSON.stringify(identity);
      // A new embedding space is staged separately; publish only a complete rebuild.
      const state = changed ? { documents: {}, table: `chunks_${randomUUID().replaceAll('-', '')}`, embedding: identity } : previous;
      const results = [];
      let published = false;
      try {
        for (const doc of documents) {
          signal?.throwIfAborted();
          try { results.push(await this.ingestDocument(doc, state, { force: true, signal, onProgress, identity })); }
          catch (error) {
            if (signal?.aborted) throw error;
            state.documents[doc.id] = { ...state.documents[doc.id], status: state.documents[doc.id]?.indexedAt ? 'stale' : 'failed', error: error.message, checkedAt: now() };
            results.push({ id: doc.id, error: error.message });
            onProgress({ id: doc.id, stage: 'failed', error: error.message });
          }
          if (!changed) await this.saveState(state);
        }
        const failed = results.filter(result => result.error).length;
        if (changed && failed) {
          for (const result of results.filter(result => result.error)) previous.documents[result.id] = {
            ...previous.documents[result.id], status: previous.documents[result.id]?.indexedAt ? 'stale' : 'failed', error: result.error, checkedAt: now(),
          };
          await this.saveState(previous);
          return { results, failed, published: false, error: 'Embedding migration incomplete; the previous collection remains active. Retry rebuild.' };
        }
        const ids = new Set(documents.map(doc => doc.id));
        const table = await this.table(state.table);
        try {
          if (table) {
            await table.delete(documents.length ? `document_id NOT IN (${documents.map(doc => sql(doc.id)).join(',')})` : 'true');
            await table.optimize();
          }
        } finally { table?.close(); }
        for (const id of Object.keys(state.documents)) if (!ids.has(id)) delete state.documents[id];
        await this.saveState(state);
        published = true;
        return { results, failed, published: true };
      } finally {
        if (changed && !published) {
          const connection = await lance.connect(path.join(this.directory, 'lancedb'));
          try { if ((await connection.tableNames()).includes(state.table)) await connection.dropTable(state.table); }
          finally { connection.close(); }
        }
      }
    });
  }

  async remove(id) {
    return this.write(async () => {
      const catalogue = await this.catalogue();
      if (!catalogue.documents.some(doc => doc.id === id)) throw failure('Document not found.', 404);
      // Remove from the catalogue first: readers filter against it, even after a crash.
      catalogue.documents = catalogue.documents.filter(doc => doc.id !== id);
      await atomicJson(this.manifest, catalogue);
      const state = await this.state();
      const table = await this.table(state.table);
      try { if (table) await table.delete(`document_id = ${sql(id)}`); }
      finally { table?.close(); }
      delete state.documents[id];
      await this.saveState(state);
      return { removed: id };
    });
  }

  async assignThemes(id, names) {
    return this.write(async () => {
      const catalogue = await this.catalogue();
      const doc = catalogue.documents.find(doc => doc.id === id);
      if (!doc) throw failure('Document not found.', 404);
      doc.themes = themes(names);
      const state = await this.state();
      const table = await this.table(state.table);
      try { if (table) await table.update({ where: `document_id = ${sql(id)}`, values: { themes: doc.themes } }); }
      finally { table?.close(); }
      await atomicJson(this.manifest, catalogue);
      if (state.documents[id]) state.documents[id].catalogueHash = hash(JSON.stringify(doc));
      await this.saveState(state);
      return doc;
    });
  }

  async search(query, { themes: selectedThemes = [], limit = 8, signal, exact = false } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 6000) throw failure('Search queries must contain 1–6000 characters.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw failure('Result count must be between 1 and 50.');
    if (!Array.isArray(selectedThemes)) throw failure('Themes must be an array.');
    const selected = selectedThemes.length ? themes(selectedThemes) : [];
    const [{ documents }, state] = await Promise.all([this.catalogue(), this.state()]);
    const eligible = documents.filter(doc => !selected.length || doc.themes.some(theme => selected.includes(theme)));
    if (!eligible.length) return { mode: 'hybrid', results: [] };
    const table = await this.table(state.table);
    if (!table) return { mode: 'bm25', warning: 'No indexed documents. Run ingestion or rebuild.', results: [] };
    try {
      const filter = `document_id IN (${eligible.map(doc => sql(doc.id)).join(',')})`;
      const columns = ['chunk_id', 'document_id', 'text', 'page', 'section'];
      let vector, warning;
      try {
        const identity = await this.modelInfo(signal);
        if (JSON.stringify(identity) !== JSON.stringify(state.embedding)) throw failure('Embedding model changed; run rebuild before semantic search.');
        [vector] = await this.embed([query], identity, signal, true);
      } catch (error) { if (signal?.aborted) throw error; warning = `Semantic search skipped: ${error.message}`; }
      signal?.throwIfAborted();
      const count = Math.max(40, limit * 5);
      const keyword = await table.search(query, 'fts', ['search_text']).where(filter).select([...columns, '_score']).limit(count).toArray();
      let semantic = [];
      if (vector) {
        let search = table.vectorSearch(vector).distanceType('cosine').where(filter).select([...columns, '_distance']).limit(count);
        if (exact) search = search.bypassVectorIndex();
        semantic = await search.toArray();
      }
      // Equal RRF weights keep incompatible BM25/cosine score scales out of the fusion.
      const scores = new Map();
      for (const ranking of [keyword, semantic]) ranking.forEach((row, rank) => {
        const previous = scores.get(row.chunk_id);
        scores.set(row.chunk_id, { row, score: (previous?.score || 0) + 1 / (60 + rank + 1) });
      });
      const byId = new Map(eligible.map(doc => [doc.id, doc]));
      const semanticRank = new Map(semantic.map((row, rank) => [row.chunk_id, rank]));
      return { mode: vector ? 'hybrid' : 'bm25', ...(warning ? { warning } : {}),
        results: [...scores.values()].sort((a, b) => b.score - a.score || (semanticRank.get(a.row.chunk_id) ?? Infinity) - (semanticRank.get(b.row.chunk_id) ?? Infinity))
          .slice(0, limit).map(({ row, score }) => {
          const doc = byId.get(row.document_id);
          return { id: row.chunk_id, documentId: doc.id, title: doc.title, text: row.text, page: row.page, section: row.section,
            themes: doc.themes, stale: state.documents[doc.id]?.status === 'stale', score,
            citation: `${doc.source.url || `/documents/${doc.id}/download`}${row.page ? `#page=${row.page}` : ''}` };
        }) };
    } finally { table.close(); }
  }

  async original(id) {
    if (!(await this.catalogue()).documents.some(doc => doc.id === id)) throw failure('Document not found.', 404);
    const original = (await this.state()).documents[id]?.original;
    if (!original) throw failure('No retained indexed original is available.', 404);
    const { safePath } = await import('./workspace.mjs');
    return safePath(this.directory, original);
  }

  async optimize({ ann = false } = {}) {
    return this.write(async () => {
      const table = await this.table((await this.state()).table);
      if (!table) throw failure('Ingest documents before creating indexes.');
      try {
        if (ann) await table.createIndex('vector', { config: lance.Index.hnswSq({ distanceType: 'cosine', numPartitions: 1 }), replace: true });
        const result = await table.optimize();
        return { ann, rows: await table.countRows(), indexes: await table.listIndices(), result };
      } finally { table.close(); }
    });
  }
}
