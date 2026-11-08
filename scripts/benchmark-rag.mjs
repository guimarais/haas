import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import * as lance from '@lancedb/lancedb';

const { values } = parseArgs({ options: { rows: { type: 'string', default: '100000' }, dimensions: { type: 'string', default: '1024' }, ann: { type: 'boolean' } } });
const rows = Number(values.rows), dimensions = Number(values.dimensions);
if (!Number.isInteger(rows) || rows < 8 || rows > 1_000_000 || !Number.isInteger(dimensions) || dimensions < 2 || dimensions > 8192) throw new Error('Use 8–1,000,000 rows and 2–8192 dimensions.');
const directory = await mkdtemp(path.join(tmpdir(), 'haas-rag-benchmark-'));
let connection, table;
let seed = 42;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 - 0.5; };
const samples = [];
const started = performance.now();
const summary = measurements => {
  const sorted = measurements.toSorted((a, b) => a - b);
  return { medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)), p95Ms: Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(2)) };
};
async function diskBytes(dir) {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) bytes += entry.isDirectory() ? await diskBytes(path.join(dir, entry.name)) : (await stat(path.join(dir, entry.name))).size;
  return bytes;
}
try {
  connection = await lance.connect(directory);
  for (let start = 0; start < rows; start += 1000) {
    const batch = [];
    for (let i = start; i < Math.min(rows, start + 1000); i++) {
      const vector = Array.from({ length: dimensions }, random);
      const norm = Math.hypot(...vector);
      for (let j = 0; j < dimensions; j++) vector[j] /= norm;
      if (i % Math.max(1, Math.floor(rows / 12)) === 0 && samples.length < 12) samples.push({ id: i, vector });
      batch.push({ id: i, document_id: `doc-${Math.floor(i / 100)}`, vector, theme: i % 2 ? 'railway' : 'electronics',
        text: `${i % 2 ? 'Railway locomotive track geometry. ' : 'NE555 resistor voltage specification. '}`.repeat(50) });
    }
    if (!table) table = await connection.createTable('passages', batch);
    else await table.add(batch);
    if ((start + 1000) % 10000 === 0) console.error(`Stored ${Math.min(rows, start + 1000)} / ${rows} vectors`);
  }
  await table.createIndex('text', { config: lance.Index.fts({ baseTokenizer: 'icu', stem: false, removeStopWords: false }) });
  await table.optimize();
  const exact = [], filtered = [], keyword = [], exactIds = [];
  for (const sample of samples) {
    let start = performance.now();
    const nearest = await table.vectorSearch(sample.vector).distanceType('cosine').bypassVectorIndex().select(['id', 'text', '_distance']).limit(8).toArray();
    exact.push(performance.now() - start); exactIds.push(nearest.map(row => row.id));
    if (nearest[0].id !== sample.id) throw new Error('Exact vector search failed the known-nearest check.');
    start = performance.now();
    await table.vectorSearch(sample.vector).distanceType('cosine').where("theme = 'electronics'").select(['id', 'text', '_distance']).limit(40).toArray();
    filtered.push(performance.now() - start);
    start = performance.now();
    await table.search('NE555', 'fts', ['text']).select(['id', 'text', '_score']).limit(40).toArray();
    keyword.push(performance.now() - start);
  }
  const report = { rows, dimensions, vectors: 'seeded synthetic float32, normalised', passageCharacters: 'approximately 1,700',
    exact: summary(exact), filteredHalfCorpus: summary(filtered), bm25: summary(keyword), databaseMiB: Number((await diskBytes(directory) / 1024 ** 2).toFixed(1)) };
  if (values.ann) {
    console.error('Building cosine IVF_HNSW_SQ…');
    const start = performance.now();
    await table.createIndex('vector', { config: lance.Index.hnswSq({ distanceType: 'cosine', numPartitions: 1 }) });
    report.annBuildSeconds = Number(((performance.now() - start) / 1000).toFixed(2));
    const times = [];
    let overlap = 0;
    for (let i = 0; i < samples.length; i++) {
      const start = performance.now();
      const result = await table.vectorSearch(samples[i].vector).distanceType('cosine').select(['id', 'text', '_distance']).limit(8).toArray();
      times.push(performance.now() - start);
      overlap += result.filter(row => exactIds[i].includes(row.id)).length;
    }
    report.ann = summary(times);
    report.annRecallAt8 = overlap / (samples.length * 8);
  }
  report.totalSeconds = Number(((performance.now() - started) / 1000).toFixed(2));
  console.log(JSON.stringify(report, null, 2));
} finally { table?.close(); connection?.close(); await rm(directory, { recursive: true, force: true }); }
