# RAG capabilities

Checked items are implemented. Unchecked items are proposed follow-up work, in suggested priority order.

## Implemented

- [x] Persist passages, metadata and embeddings locally in LanceDB, outside Git.
- [x] Keep document IDs, titles, sources and themes in the Git-tracked `documents.json` catalogue.
- [x] Ingest PDF, HTML, Markdown and plain text from URLs, local files and frontend uploads.
- [x] Assign multiple themes per document and search selected themes without duplicate passages.
- [x] Combine semantic search and BM25 with reciprocal rank fusion.
- [x] Generate embeddings locally through Ollama; report BM25-only fallback when embeddings are unavailable.
- [x] Return passages with source citations, PDF page numbers, section headings and stale-version indicators.
- [x] Add, list, refresh, remove and assign document themes through chat tools and the CLI.
- [x] Rebuild from the catalogue, skip unchanged content during ordinary ingestion, and preserve previous versions after failed updates.
- [x] Stage embedding-model migrations and publish only complete migrations.
- [x] Enforce local-only document access across saved chats and project conversations.
- [x] Benchmark exact search and optionally create a persistent IVF_HNSW_SQ index.

## Next

- [x] **Evaluate retrieval quality.** Added an original, redistributable [fixture corpus](test/fixtures/rag/corpus.json) with 18 documents, 36 passages and 38 labelled questions. `npm run eval:rag` compares BM25, semantic and hybrid retrieval, reports quality and latency, and fails structural errors. Deterministic evaluator checks run through `npm test`; real-model reports are generated separately outside Git. Ranking misses and unsupported-question behaviour remain visible for subsequent improvements.
- [x] **Complete frontend document management.** The Documents panel shows IDs, edits titles/source URLs/themes under the existing ID, and removes documents with confirmation while preserving originals. Title/source edits re-ingest immediately; theme-only edits skip embeddings. Failed edits preserve the prior indexed version as stale.
- [x] **Retry failed ingestion from the frontend.** Failed and stale entries can retry their current catalogue source under the same ID. Local sources can be replaced by upload while preserving IDs, titles and themes. Progress and actionable source errors are shown, and failed attempts preserve any previous indexed version.
- [ ] **Add frontend search and passage inspection.** Search across selected themes, display ranked passages and citations, and clearly show fallback and stale-result warnings.
- [ ] **Verify recovery integrity.** Add a diagnostic command that checks catalogue entries against retained files, indexed passages and embedding configuration. Report missing data and the commands needed to recover it.
- [ ] **Back up local-only sources.** Export and restore the catalogue with retained originals, preserving IDs and checking content hashes. Verify rebuilding into an empty data directory from that backup.

## Follow-up improvements

- [ ] **Improve chunking and extraction.** Evaluate the model's tokenizer against the current character estimate. Preserve headings, code blocks, tables and PDF page spans; include multi-column PDFs in extraction checks.
- [ ] **Make indexed versions inspectable.** Link results to the retained version that produced the passage, alongside the current source URL, so changed webpages and stale results can be verified.
- [ ] **Support explicit batch ingestion.** Accept multiple files or URL lists with per-document progress, cancellation and retry of failed entries.
- [ ] **Measure real-corpus performance.** Include query embedding time and the actual hybrid retrieval path in latency measurements. Compare exact and approximate search for latency and recall before enabling ANN by default.
- [ ] **Expose storage and index health.** Report document/passage counts, disk usage, indexed versus unindexed rows, and retired embedding tables. Provide explicit maintenance for unused index data while preserving retained sources.

## Optional extensions

- [ ] Add local OCR for scanned PDFs and image-only pages when needed.
- [ ] Add Office document extraction when the collection requires those formats.
- [ ] Add authenticated source downloads with credentials stored outside the catalogue and Git.
- [ ] Evaluate a local reranking model only if retrieval-quality measurements demonstrate a benefit.

See the [README](README.md#local-document-collection) for current usage and recovery commands.
