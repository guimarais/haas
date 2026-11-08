import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Rag, chunkDocument, extractDocument, themes } from '../rag.mjs';
import { atomicJson } from '../workspace.mjs';

const CORPUS = new URL('../test/fixtures/rag/corpus.json', import.meta.url);
const MODES = ['bm25', 'semantic', 'hybrid'];
const normalise = text => text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const matches = (row, target) => row.documentId === target.documentId && row.section === target.section && normalise(row.text).includes(normalise(target.anchor));

export async function loadCorpus(file = CORPUS) {
  const bytes = await readFile(file);
  const corpus = JSON.parse(bytes);
  if (corpus.version !== 1 || !corpus.documents?.length || !corpus.queries?.length) throw new Error('Evaluation corpus requires version 1, documents and queries.');
  const documents = new Map();
  for (const doc of corpus.documents) {
    if (typeof doc.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(doc.id) || documents.has(doc.id) || typeof doc.title !== 'string' || !doc.title.trim() || typeof doc.text !== 'string' || !doc.text.trim()) {
      throw new Error(`Invalid or duplicate fixture document: ${doc.id}`);
    }
    themes(doc.themes);
    const extracted = await extractDocument(Buffer.from(doc.text), `${doc.id}.md`);
    documents.set(doc.id, { ...doc, passages: chunkDocument(extracted.sections) });
  }
  const ids = new Set();
  for (const query of corpus.queries) {
    if (typeof query.id !== 'string' || !query.id || ids.has(query.id) || typeof query.text !== 'string' || !query.text.trim() || query.text.length > 6000 ||
        !Array.isArray(query.relevant) || !Array.isArray(query.tags) || !query.tags.length || query.tags.some(tag => typeof tag !== 'string' || !tag)) throw new Error(`Invalid or duplicate evaluation query: ${query.id}`);
    ids.add(query.id);
    if (query.themes !== undefined && (!Array.isArray(query.themes) || query.themes.length)) themes(query.themes);
    const targets = new Set();
    for (const target of query.relevant) {
      const doc = documents.get(target.documentId);
      if (!doc || typeof target.section !== 'string' || typeof target.anchor !== 'string' || !target.anchor.trim() || targets.has(JSON.stringify(target))) throw new Error(`Invalid relevance label in ${query.id}`);
      targets.add(JSON.stringify(target));
      if (query.themes?.length && !doc.themes.some(theme => themes(query.themes).includes(theme))) throw new Error(`Relevance label outside selected themes in ${query.id}`);
      if (!doc.passages.some(passage => matches({ ...passage, documentId: doc.id }, target))) throw new Error(`Expected passage does not exist in ${query.id}: ${target.documentId} / ${target.section}`);
    }
  }
  return { ...corpus, sha256: createHash('sha256').update(bytes).digest('hex'), documents: [...documents.values()] };
}

export function scoreQuery(query, results, limit = 8) {
  const rows = results.slice(0, limit);
  if (!query.relevant.length) return { unsupportedReturnedResults: rows.length > 0 };
  const expectedDocs = new Set(query.relevant.map(target => target.documentId));
  const foundDocs = new Set(rows.filter(row => expectedDocs.has(row.documentId)).map(row => row.documentId));
  const relevantRank = rows.findIndex(row => query.relevant.some(target => matches(row, target)));
  return {
    hitAtK: relevantRank >= 0,
    documentRecallAtK: foundDocs.size / expectedDocs.size,
    passageRecallAtK: query.relevant.filter(target => rows.some(row => matches(row, target))).length / query.relevant.length,
    reciprocalRankAtK: relevantRank < 0 ? 0 : 1 / (relevantRank + 1),
  };
}

function structuralErrors(response, query, corpus, mode, limit) {
  const errors = [];
  if (response.mode !== mode || response.warning) errors.push(`Requested ${mode}, received ${response.mode}${response.warning ? `: ${response.warning}` : ''}`);
  if (!Array.isArray(response.results)) return [...errors, 'Search results are not an array.'];
  if (response.results.length > limit) errors.push('Search returned more passages than requested.');
  const seen = new Set();
  for (const row of response.results) {
    const doc = corpus.documents.find(doc => doc.id === row.documentId);
    if (!doc) { errors.push(`Unknown source document: ${row.documentId}`); continue; }
    if (!row.id || seen.has(row.id)) errors.push(`Missing or duplicate passage ID: ${row.id}`);
    seen.add(row.id);
    if (query.themes?.length && !doc.themes.some(theme => themes(query.themes).includes(theme))) errors.push(`Theme leak: ${doc.id}`);
    const citation = `/documents/${doc.id}/download${row.page ? `#page=${row.page}` : ''}`;
    if (row.citation !== citation) errors.push(`Missing or incorrect source reference: ${row.id}`);
    if (typeof row.text !== 'string' || !doc.passages.some(passage => passage.section === row.section && passage.page === row.page && normalise(passage.text) === normalise(row.text))) {
      errors.push(`Returned passage does not match its source: ${row.id}`);
    }
  }
  return errors;
}

function summarise(cases) {
  const valid = cases.filter(row => !row.errors.length);
  const positive = valid.filter(row => row.expected.length);
  const unsupported = valid.filter(row => !row.expected.length);
  const latencies = valid.map(row => row.latencyMs).toSorted((a, b) => a - b);
  return {
    queries: cases.length, evaluated: valid.length, structuralFailures: cases.length - valid.length,
    answerable: positive.length,
    hitRateAtK: mean(positive.map(row => Number(row.metrics.hitAtK))),
    documentRecallAtK: mean(positive.map(row => row.metrics.documentRecallAtK)),
    passageRecallAtK: mean(positive.map(row => row.metrics.passageRecallAtK)),
    mrrAtK: mean(positive.map(row => row.metrics.reciprocalRankAtK)),
    unsupported: { queries: unsupported.length, queriesWithResults: unsupported.filter(row => row.metrics.unsupportedReturnedResults).length,
      returnedResultRate: mean(unsupported.map(row => Number(row.metrics.unsupportedReturnedResults))) },
    latency: { medianMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      p95Ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null },
  };
}

export async function evaluateQueries(rag, corpus, { limit = 8, signal, onProgress = () => {} } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Evaluation limit must be between 1 and 50.');
  const cases = [];
  for (const [index, query] of corpus.queries.entries()) {
    for (const mode of MODES) {
      signal?.throwIfAborted();
      const started = performance.now();
      let response = { mode, results: [] }, errors = [], latencyMs;
      try {
        response = await rag.search(query.text, { mode, themes: query.themes, limit, exact: true, signal });
        latencyMs = performance.now() - started;
        errors = structuralErrors(response, query, corpus, mode, limit);
      } catch (error) {
        if (signal?.aborted) throw error;
        errors = [error.message];
      }
      latencyMs ??= performance.now() - started;
      const results = Array.isArray(response.results) ? response.results : [];
      cases.push({ queryId: query.id, query: query.text, tags: query.tags, themes: query.themes || [], mode, actualMode: response.mode,
        expected: query.relevant, latencyMs, errors, metrics: errors.length ? null : scoreQuery(query, results, limit),
        results: results.map(row => ({ id: row.id, documentId: row.documentId, section: row.section, citation: row.citation,
          relevant: query.relevant.some(target => typeof row.text === 'string' && matches(row, target)) })) });
      onProgress({ stage: 'query', query: index + 1, total: corpus.queries.length, mode, id: query.id });
    }
  }
  const modes = Object.fromEntries(MODES.map(mode => {
    const rows = cases.filter(row => row.mode === mode);
    const tags = [...new Set(rows.flatMap(row => row.tags))].sort();
    return [mode, { ...summarise(rows), byTag: Object.fromEntries(tags.map(tag => [tag, summarise(rows.filter(row => row.tags.includes(tag)))])) }];
  }));
  const failures = cases.filter(row => row.errors.length).map(row => ({ queryId: row.queryId, mode: row.mode, errors: row.errors }));
  return { passed: !failures.length, limit, modes, structuralFailures: failures, queries: cases };
}

export async function runEvaluation({ limit = 8, model, ollamaUrl, fetchImpl, signal, onProgress = () => {} } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Evaluation limit must be between 1 and 50.');
  const corpus = await loadCorpus();
  const root = await mkdtemp(path.join(tmpdir(), 'haas-rag-eval-'));
  try {
    const rag = new Rag({ projectDir: root, dataDir: path.join(root, 'data'), manifest: path.join(root, 'documents.json'),
      ...(model ? { model } : {}), ...(ollamaUrl ? { ollamaUrl } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
    const embedding = await rag.modelInfo(signal);
    const documents = [];
    for (const doc of corpus.documents) {
      const file = path.join(root, `${doc.id}.md`);
      await writeFile(file, doc.text);
      documents.push({ id: doc.id, title: doc.title, themes: doc.themes, source: { path: `${doc.id}.md` } });
    }
    await atomicJson(rag.manifest, { version: 1, documents });
    const indexingStarted = performance.now();
    for (const [index, doc] of documents.entries()) {
      signal?.throwIfAborted();
      onProgress({ stage: 'ingest', document: index + 1, total: documents.length, id: doc.id });
      await rag.ingest({ id: doc.id }, { signal });
    }
    await rag.optimize();
    const indexingMs = performance.now() - indexingStarted;
    const report = await evaluateQueries(rag, corpus, { limit, signal, onProgress });
    if (JSON.stringify(await rag.modelInfo(signal)) !== JSON.stringify(embedding)) {
      report.structuralFailures.push({ errors: ['Embedding model changed during evaluation.'] });
      report.passed = false;
    }
    const lancePackage = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@lancedb/lancedb')), 'utf8'));
    return { ...report, generatedAt: new Date().toISOString(), runtime: { node: process.version, lancedb: lancePackage.version, platform: process.platform, arch: process.arch }, embedding, indexingMs,
      corpus: { version: corpus.version, sha256: corpus.sha256, documents: documents.length,
        passages: corpus.documents.reduce((sum, doc) => sum + doc.passages.length, 0), queries: corpus.queries.length, provenance: corpus.provenance, license: corpus.license },
      notes: [
        'Quality metrics are a baseline, not pass/fail thresholds. Only structural failures fail this evaluation.',
        'Unsupported questions have no relevant passage within their selected themes. Returned passages are reported; no abstention threshold is applied.',
        'Latency includes query embedding, model inspection and database search. Indexing is reported separately. Modes run sequentially in bm25, semantic, hybrid order.',
        'The small authored corpus measures retrieval behaviour, not performance or extraction quality on a representative production collection.',
      ] };
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { limit: { type: 'string', default: '8' }, output: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('npm run eval:rag -- [--limit 8] [--output report.json]\nUses local Ollama and disposable fixture data. RAG_EMBEDDING_MODEL and OLLAMA_URL select the local model.\nRanking misses are reported; structural errors and unavailable embeddings fail the command.');
    else {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      const report = await runEvaluation({ limit: Number(values.limit), signal: controller.signal, onProgress: event => {
        if (event.stage === 'ingest') console.error(`Indexing fixture ${event.document}/${event.total}: ${event.id}`);
        else if (event.mode === 'hybrid' && (event.query % 10 === 0 || event.query === event.total)) console.error(`Evaluated ${event.query}/${event.total} questions across all three modes`);
      } });
      if (values.output) {
        await atomicJson(path.resolve(values.output), report);
        console.log(JSON.stringify({ passed: report.passed, corpus: report.corpus, embedding: report.embedding, limit: report.limit,
          modes: Object.fromEntries(MODES.map(mode => [mode, { ...report.modes[mode], byTag: undefined }])), structuralFailures: report.structuralFailures,
          rankingMisses: report.queries.filter(row => row.metrics?.hitAtK === false).map(row => ({ queryId: row.queryId, mode: row.mode })),
          report: path.resolve(values.output) }, null, 2));
      } else console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
