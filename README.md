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
| `PORT` | `4317` | Local HTTP port |

Select OpenAI or Ollama and a model at the top of the page. Installed Ollama models are discovered from `/api/tags`; the app checks `/api/show` for tool support before starting a task. Local requests use `reasoning_effort: none` to avoid a hidden thinking phase delaying replies. For tool-heavy design work, configure a sufficiently large context in the Ollama model (for example, `PARAMETER num_ctx 32768` in its Modelfile) and set `OLLAMA_CONTEXT` to match. Changing that variable alone does not reconfigure Ollama. See [Ollama's compatibility documentation](https://docs.ollama.com/api/openai-compatibility).

**Web research always uses OpenAI's API**, even with Ollama selected. Local conversation inference does not make search local. Missing credentials and unavailable models are reported in the chat; no provider fallback runs silently.

## Use

- “Compare offers for 10 Texas Instruments NE555P timers delivered to Portugal. Include EUR prices, stock, VAT, shipping and links.”
- “Help me design a KiCad board using Konnect. Ask for my circuit requirements first.”
- “Build a Märklin C-track oval on a 2000 × 1200 mm board: six 24130, one 24188, six 24130, one 24188. Inspect it and return the XTrackCAD file and preview.”

The model reads the relevant `SKILL.md`, selects tools and continues until it has a result or needs information. Tool activity can be expanded in the chat. Markdown tables and source links render as sanitised HTML; external images and embedded content are disabled.

Use **Attach files** to import designs. Selecting sibling KiCad files together keeps them in the same imported project folder. Original bytes are preserved in `data/originals/`; the agent edits copies in `workspace/imports/`. Project files are downloadable from the sidebar or chat links. Imported KiCad projects can still reference external libraries or hierarchical sheets: include their dependencies with the working copy before editing them.

The sidebar's **Conversations** list shows saved chats, newest activity first. Select one to reopen its messages and tool results and continue chatting. On a narrow screen, use **History** to open the sidebar. Titles come from the first message; the current chat is highlighted. New conversation starts fresh context while retaining project files and saved chats.

**Stop** cancels the active run. Closing/reloading the page detaches the browser while the backend can finish the task. The selected chat is restored from Pi's JSONL sessions after a restart. Backend interruption stops unfinished work; it is never automatically replayed. Inspect saved progress before asking it to retry. Finish or stop an active task before switching conversations.

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

`npm test` uses a local scripted model server with the real Pi agent loop: automatic skill reading, tool execution, streaming and persisted history. It also checks traversal/symlink guards, nested MCP paths, global mutations, citation preservation, failed search and cancellation. No model API charges.

`check:mcp` requires the configured local MCP programs and KiCad CLI. It creates disposable native KiCad files, loads toolsets dynamically, runs ERC/DRC/exports, then generates and inspects a 14-piece XTrackCAD oval with an SVG preview. It removes its temporary files and makes no model API calls. It does not test live KiCad IPC editing or establish correctness of a real circuit.

The Pi packages are pinned together at 1.0.3: its published dependency ranges otherwise select newer subpackages with incompatible exports. The lockfile makes this installation reproducible.

API references: [Pi SDK](https://pi.dev/docs/latest/sdk), [Pi MCP](https://pi.dev/docs/latest/mcp), [Pi skills](https://pi.dev/docs/latest/skills), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).
