# Haas

A small local chat app backed by **Pi**, with automatic skill/tool selection for electronic component research, KiCad through **Konnect MCP**, and XTrackCAD through **Turnout MCP**.

## Run

Requires Node 24+, an OpenAI API key for OpenAI chat/web search, and the local MCP programs configured in [mcp.json](mcp.json).

```sh
npm ci --ignore-scripts
npm start
```

Open **http://127.0.0.1:4317**. The server binds only to loopback. An exported `OPENAI_API_KEY` is used automatically. Otherwise copy `.env.example` to `.env`, enter your key there, and restart. Credentials stay on the backend; `.env`, conversations and project files are ignored by Git.

Optional backend settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-5.4` | Initial OpenAI chat model |
| `SEARCH_MODEL` | `gpt-5.4` | OpenAI model used by the web-search tool |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama service |
| `OLLAMA_CONTEXT` | Model's `num_ctx`, otherwise 4096 | Context budget; must match the context configured in Ollama |
| `RAG_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Locally installed Ollama embedding model; changing it requires rebuilding |
| `PORT` | `4317` | Local HTTP port |

Select OpenAI or Ollama and a model at the top of the page. Installed Ollama models are discovered from `/api/tags`; the app checks `/api/show` for tool support before starting a task. Local requests use `reasoning_effort: none` to avoid a hidden thinking phase delaying replies. For tool-heavy design work, configure a sufficiently large context in the Ollama model (for example, `PARAMETER num_ctx 32768` in its Modelfile) and set `OLLAMA_CONTEXT` to match. Changing that variable alone does not reconfigure Ollama. See [Ollama's compatibility documentation](https://docs.ollama.com/api/openai-compatibility).

**Web research uses OpenAI's API**, even with Ollama selected. It is disabled after a conversation accesses the local document collection. Local conversation inference otherwise does not make web search local. Missing credentials and unavailable models are reported in the chat; no provider fallback runs silently.

## Use

- “Compare offers for 10 Texas Instruments NE555P timers delivered to Portugal. Include EUR prices, stock, VAT, shipping and links.”
- “Help me design a KiCad board using Konnect. Ask for my circuit requirements first.”
- “Build a Märklin C-track oval on a 2000 × 1200 mm board: six 24130, one 24188, six 24130, one 24188. Inspect it and return the XTrackCAD file and preview.”

The model reads the relevant `SKILL.md`, selects tools and continues until it has a result or needs information. Tool activity can be expanded in the chat. Markdown tables and source links render as sanitised HTML; external images and embedded content are disabled.

Use **Attach files** to import designs. Selecting sibling KiCad files together keeps them in the same imported project folder. Original bytes are preserved in `data/originals/`; the agent edits copies in `workspace/imports/`. Project files are downloadable from the sidebar or chat links. Imported KiCad projects can still reference external libraries or hierarchical sheets: include their dependencies with the working copy before editing them.

The sidebar's **Conversations** list shows saved chats, newest activity first. Select one to reopen its messages and tool results and continue chatting. On a narrow screen, use **History** to open the sidebar. Titles come from the first message; the current chat is highlighted. New conversation starts fresh context while retaining project files and saved chats.

**Stop** cancels the active run. Closing/reloading the page detaches the browser while the backend can finish the task. The selected chat is restored from Pi's JSONL sessions after a restart. Backend interruption stops unfinished work; it is never automatically replayed. Inspect saved progress before asking it to retry. Finish or stop an active task before switching conversations.

## Local document collection

The collection uses **LanceDB Embedded** on local disk, **BM25** full-text search, and local Ollama embeddings. It needs no database service or cloud embedding API. Install the embedding model if necessary:

```sh
ollama pull qwen3-embedding:0.6b
```

Open **Documents** beside **Attach files** to ingest one file or URL. Supported formats are text PDFs, HTML, Markdown and UTF-8 plain text, up to 25 MiB each. Choose existing themes or enter new comma-separated themes; a document can belong to several. Uploaded files may include an optional download URL for recovery. Progress and failures appear in the panel, alongside the collection's ingestion status. Ingestion runs independently of chat, with a shared writer lock across the frontend, chat and CLI.

Select a **local, tool-capable Ollama conversation model** and ask, for example:

- “List my documents and themes.”
- “Search electronics and components for NE555 supply voltage. Cite the passages.”
- “Add `imports/my-document.pdf` to the electronics theme.”
- “Move document `<id>` to the reference and electronics themes.”
- “Remove document `<id>` from the collection.”

The tools are `rag_list`, `rag_search`, `rag_add`, `rag_themes` and `rag_remove`. Chat ingestion can read workspace files or registered sources; new URLs must appear explicitly in your current request, preventing generated URLs from forwarding document text. The CLI can also ingest other paths you explicitly supply. Frontend ingestion does not require a conversation model.

Search combines the top BM25 and cosine-similarity results using equal-weight reciprocal rank fusion, preferring semantic rank when fusion scores tie. A search with several themes uses their union and deduplicates passages; omitted themes search everything. The default is eight passages, including titles, source links, page/section references, and stale-version markers. Passages target approximately 500 tokens plus overlap, using a character estimate rather than the model's tokenizer. Scanned PDF OCR, authenticated websites and Office formats are not supported. Extracted text is capped at 10 million characters per document.

**Privacy:** document tools require a local Ollama chat model. Access permanently marks that saved conversation as local-only, including after restart and context compaction. Switching it to OpenAI or an Ollama cloud model is blocked; web search and MCP tools are blocked in that conversation. Start a new conversation for external tools. `OLLAMA_URL` must use `localhost`, `127.0.0.1` or `::1` for document inference. When the embedding service is unavailable or its model changed, search returns explicitly labelled BM25-only results; ingestion requires successful embeddings before publishing. No cloud fallback is used.

### Catalogue and recovery

[`documents.json`](documents.json) is the git-tracked, editable source catalogue. Document tools and frontend ingestion update it automatically; commit those changes normally. Generated data is kept outside git:

| Location | Contents |
| --- | --- |
| `documents.json` | Versioned catalogue: stable IDs, titles, sources and theme memberships |
| `data/rag/lancedb/` | Persistent passages, vectors, metadata, BM25 and optional vector indexes |
| `data/rag/uploads/` | Retained uploaded source files |
| `data/rag/originals/` | Content-addressed copies of successfully indexed source versions |
| `data/rag/state.json` | Local hashes, model digest, active table and ingestion status |

A catalogue entry has this shape:

```json
{
  "id": "sqlite-fts5",
  "title": "SQLite FTS5 documentation",
  "source": { "url": "https://www.sqlite.org/fts5.html" },
  "themes": ["databases", "search"]
}
```

The top-level file has `"version": 1` and a `"documents"` array. `source.path` records a local path relative to the repository (absolute paths also work). A source can contain both `url` and `path`; rebuild prefers the URL. Local-only entries need their files restored on another machine. A git clone alone cannot recover those bytes. Source URLs must be directly downloadable HTTP(S) URLs without credentials.

```sh
npm run rag -- add https://www.sqlite.org/fts5.html --theme databases --theme search
npm run rag -- add ./manual.pdf --theme electronics --title "Component manual"
npm run rag -- list
npm run rag -- search "supply voltage" --theme electronics --limit 8
npm run rag -- ingest <document-id>
npm run rag -- themes <document-id> --theme reference --theme electronics
npm run rag -- remove <document-id>
npm run rag -- rebuild
```

Ordinary ingestion checks source hashes and skips unchanged documents. **Rebuild downloads current URL content and processes every catalogue entry**, so it restores the collection rather than reproducing historical website bytes. Failures are reported individually and give the CLI a nonzero exit status. Existing versions survive failed updates and are marked stale. A successful update replaces all of that document's chunks in one database transaction. Removing a document deletes its catalogue entry and searchable passages, while preserving local source files and cached originals.

Changing the embedding model, its digest or the chunking pipeline requires re-embedding. Such rebuilds stage a separate table and publish it only when every document succeeds; an incomplete migration leaves the previous collection active. The catalogue, cached files and database are separate writes: interruption can leave pending entries, which the next ingestion/rebuild reconciles. After a crashed writer, `npm run rag -- unlock` clears its lock only if the recorded process is no longer running.

### Index maintenance and performance

Exact cosine search is the initial default. New rows remain searchable before index maintenance. To compact storage and incorporate new rows into existing indexes:

```sh
npm run rag -- optimize
```

Use `npm run bench:rag` for a disposable, offline 100,000-vector benchmark. It creates seeded synthetic 1,024-dimensional vectors with passage text, measures exact and BM25 queries, and removes its temporary database. On this machine (Node 24.14, Linux x64, LanceDB 0.41.0), the initial run measured **211 ms median / 252 ms p95 exact vector search**, and **2.4 ms median / 10.2 ms p95 BM25**, across 12 queries. These measure database work, excluding embedding generation, and do not establish relevance or latency for a real corpus.

If corpus measurements justify approximate search, create a persistent cosine **IVF_HNSW_SQ** index with `npm run rag -- optimize --ann`. Re-run that command after major corpus changes to retrain it. `npm run bench:rag -- --ann` compares approximate latency and recall against exact search; `rag search --exact` bypasses an existing vector index. The initial design target is approximately 1,000 documents / 100,000 passages. See [LanceDB indexing](https://docs.lancedb.com/indexing/vector-index) and [BM25](https://docs.lancedb.com/search/full-text-search).

## MCP connections

`mcp.json` uses the existing local installations and is ignored by Git because it contains machine-specific paths and may contain credentials. For a new checkout, copy `mcp.example.json` to `mcp.json` and set the Konnect executable, Turnout Python executable and `PYTHONPATH` to your installations. `${APP}`, `${DATA}` and `${WORKSPACE}` are expanded by the app. Restart after changing MCP configuration or skills.

**Konnect** runs as its own stdio process. Its app-owned configuration sets the default project directory to `workspace/`. Tools are discovered lazily, and Pi honours tool-list changes after `load_toolset`. Native schematic editing, ERC/DRC and exports use files and `kicad-cli`. Live board operations require **KiCad 10**, IPC enabled, and the **workspace board** open. Targeted `run_drc` with `sync_live_board=true` saves/verifies that board before checking it. The unscoped `save_project` and global preference mutations are disabled.

**Turnout** runs through `scripts/run_turnout.py` using its existing virtualenv. The launcher redirects its layout/preview output into this app's workspace and leaves the Turnout checkout unchanged. Its current catalogue, geometry checks and editing capabilities define what layouts are supported. Review the native `.xtc` in XTrackCAD; track-centreline checks do not establish vehicle clearances.

Add a vetted server to `mcp.json` to extend the toolset. Add a skill directory containing `SKILL.md` under `skills/` to extend the workflows. Skill descriptions must describe their triggers; omit `disable-model-invocation: true` for automatic selection. Discovery is automatic, but tool/skill selection still depends on the selected model's capabilities.

File tools and explicit MCP path arguments are checked against the workspace, including symlink escapes. Large MCP results are copied into `workspace/.tool-results/` so the agent can read them through the same boundary. These are application checks, **not an operating-system sandbox**: configured MCP servers are trusted local programs, and their own side effects must be understood before adding them. General shell and codemode execution are disabled.

## Checks

```sh
npm test
npm run check:mcp
```

`npm test` uses a local scripted model server with the real Pi agent loop: automatic skill reading, tool execution, streaming and persisted history. It also checks traversal/symlink guards, nested MCP paths, global mutations, citation preservation, failed search and cancellation. RAG checks use a real temporary LanceDB and a local scripted embedding service: hybrid retrieval, themes, atomic replacement, recovery, model migrations, PDF/HTML extraction, frontend ingestion and durable privacy guards. No model API charges.

`check:mcp` requires the configured local MCP programs and KiCad CLI. It creates disposable native KiCad files, loads toolsets dynamically, runs ERC/DRC/exports, then generates and inspects a 14-piece XTrackCAD oval with an SVG preview. It removes its temporary files and makes no model API calls. It does not test live KiCad IPC editing or establish correctness of a real circuit.

The Pi packages are pinned together at 1.0.3: its published dependency ranges otherwise select newer subpackages with incompatible exports. The lockfile makes this installation reproducible.

LanceDB's unused optional Transformers integration brings an older Sharp dependency; its version is overridden to 0.35.5 to avoid adding the affected native image libraries. Embeddings use Ollama directly.

API references: [Pi SDK](https://pi.dev/docs/latest/sdk), [Pi MCP](https://pi.dev/docs/latest/mcp), [Pi skills](https://pi.dev/docs/latest/skills), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).
