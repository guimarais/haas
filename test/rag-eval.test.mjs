import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateQueries, loadCorpus, scoreQuery } from '../scripts/eval-rag.mjs';

test('retrieval metrics score passage rank, multi-source recall, cutoffs and unsupported questions', () => {
  const relevant = [{ documentId: 'one', section: 'A', anchor: 'evidence one' }, { documentId: 'two', section: 'B', anchor: 'evidence two' }];
  const rows = [
    { documentId: 'other', section: 'A', text: 'Unrelated.' },
    { documentId: 'one', section: 'A', text: 'EVIDENCE\n ONE is here.' },
    { documentId: 'two', section: 'B', text: 'Evidence two is here.' },
  ];
  assert.deepEqual(scoreQuery({ relevant }, rows, 2), { hitAtK: true, documentRecallAtK: 0.5, passageRecallAtK: 0.5, reciprocalRankAtK: 0.5 });
  assert.equal(scoreQuery({ relevant }, rows, 3).passageRecallAtK, 1);
  assert.deepEqual(scoreQuery({ relevant }, rows, 1), { hitAtK: false, documentRecallAtK: 0, passageRecallAtK: 0, reciprocalRankAtK: 0 });
  assert.deepEqual(scoreQuery({ relevant: [] }, rows), { unsupportedReturnedResults: true });
  assert.deepEqual(scoreQuery({ relevant: [] }, []), { unsupportedReturnedResults: false });
});

test('fixture labels refer to real source passages and invalid labels or theme scopes fail validation', async t => {
  const corpus = await loadCorpus();
  assert.ok(corpus.documents.some(doc => doc.themes.includes('electronics')));
  assert.ok(corpus.documents.some(doc => doc.themes.includes('railway')));
  for (const tag of ['exact-part', 'cross-language', 'portuguese', 'multi-theme', 'unsupported']) assert.ok(corpus.queries.some(query => query.tags.includes(tag)));
  const root = await mkdtemp(path.join(tmpdir(), 'haas-eval-labels-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(new URL('./fixtures/rag/corpus.json', import.meta.url), 'utf8'));
  const file = path.join(root, 'corpus.json');
  const invalid = structuredClone(original);
  invalid.queries[0].relevant[0].anchor = 'This passage is absent from the source.';
  await writeFile(file, JSON.stringify(invalid));
  await assert.rejects(loadCorpus(file), /Expected passage does not exist/);
  invalid.queries[0] = { ...original.queries[0], themes: ['railway'] };
  await writeFile(file, JSON.stringify(invalid));
  await assert.rejects(loadCorpus(file), /outside selected themes/);
});

test('evaluation fails structural errors while preserving per-mode diagnostics', async () => {
  const corpus = { documents: [{ id: 'one', themes: ['electronics'], passages: [{ section: 'A', page: 0, text: 'Evidence.' }] }],
    queries: [{ id: 'scoped', text: 'Evidence', tags: ['theme-filter'], themes: ['railway'], relevant: [] }] };
  const rag = { search: async (_query, { mode }) => ({ mode, results: [
    { id: 'one:0', documentId: 'one', section: 'A', page: 0, text: 'Evidence.', citation: '' },
  ] }) };
  const report = await evaluateQueries(rag, corpus);
  assert.equal(report.passed, false);
  assert.equal(report.structuralFailures.length, 3);
  assert.match(JSON.stringify(report.structuralFailures), /Theme leak/);
  assert.match(JSON.stringify(report.structuralFailures), /source reference/);
  assert.equal(report.modes.hybrid.evaluated, 0);
  assert.equal(report.modes.hybrid.mrrAtK, null);
  const fallback = await evaluateQueries({ search: async () => ({ mode: 'bm25', warning: 'Embeddings unavailable.', results: [] }) }, corpus);
  assert.equal(fallback.passed, false);
  assert.match(JSON.stringify(fallback.structuralFailures), /Requested semantic, received bm25/);
});
