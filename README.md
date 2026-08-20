# second-brain-visualizer

An Obsidian connector for a codebase. Whatever you do in this project shows up in
Obsidian's graph view — automatically, and without ever overwriting anything you
wrote by hand.

It has four parts:

| Part | What it does |
| --- | --- |
| **Mirror** | Turns every source file, folder, and dependency into a linked note. Imports become wikilinks, so Obsidian's graph *is* your dependency graph. |
| **Watcher** | Watches the project and updates the vault as you edit. |
| **MCP server** | Lets Claude write concepts, decisions, and session logs into the same graph. |
| **Visualizer** | A built-in live graph at `localhost:4141`, so you can see the graph without opening Obsidian. |

---

## Quick start

```bash
npm install
npm run build

node dist/cli.js init          # creates the vault + config, runs a first sync
node dist/cli.js open          # opens (and registers) the vault in Obsidian
node dist/cli.js serve --watch # live graph at http://127.0.0.1:4141
```

`init` writes `sbv.config.json` and builds a vault at `./vault`. The vault is a
normal Obsidian vault: a folder of markdown files plus an `.obsidian/` config
pre-tuned so the graph is legible on first open.

If `sbv open` does not work (Obsidian has never been launched), open Obsidian and
choose **Open folder as vault** → select the `vault/` directory.

---

## Commands

```
sbv init            Create the config + vault and run a first sync
sbv sync            Mirror the project into the vault once
sbv watch           Sync continuously as files change
sbv serve [--watch] Run the graph visualizer
sbv open [--note]   Open the vault (or one note) in Obsidian
sbv graph           Print graph statistics to the terminal
sbv doctor          Check the setup and report problems
sbv mcp             Run the MCP server over stdio
sbv install-mcp     Write .mcp.json so Claude Code picks up the server
```

Common flags: `--vault <path>`, `--cwd <path>`, `--port <n>`, `--config <path>`,
`--verbose`.

---

## What the vault looks like

```
vault/
├── _Meta/Dashboard.md          Start here: stats, hubs, largest files, TODOs
├── Codebase/
│   ├── Files/                  One note per source file
│   ├── Modules/                One note per folder
│   └── Packages/               One note per external dependency
├── Concepts/                   Your notes (and Claude's) about the code
├── Decisions/                  Architecture decision records
├── Sessions/                   What was worked on, and when
└── Journal/                    Daily notes linking to what changed that day
```

A generated file note carries the things a graph needs and a reader wants:

```markdown
---
sbv: file
source_path: src/mirror/sync.ts
language: typescript
lines: 242
dependents: 3
tags: [sbv/file, code/typescript, module/src-mirror]
---

<!-- sbv:begin -->
# src/mirror/sync.ts

## Depends on
- [[Codebase/Files/src.mirror.scanner.ts|src/mirror/scanner.ts]]
- [[Codebase/Packages/chokidar|chokidar]] _(package)_

## Used by
- [[Codebase/Files/src.cli.ts|src/cli.ts]]

## Symbols
| Name | Kind | Line | Exported |
...
<!-- sbv:end -->
```

### Your writing is never destroyed

This is the rule the whole design bends around:

- **Anything outside the `sbv:begin` / `sbv:end` markers is yours.** Syncs replace
  only the block between them.
- **Unknown frontmatter keys are preserved.** Add `status:` or `owner:` and it
  survives.
- **Deleting a source file does not delete your notes.** If the note contains
  prose you wrote, it is marked `sbv: orphaned` with a warning banner and kept.
  Only untouched, purely-generated notes are removed.
- **Unchanged notes are not rewritten**, so Obsidian Sync and your file watcher
  stay quiet. A second `sync` with no code changes writes zero bytes.

---

## Using it with Claude

`sbv install-mcp --write` creates `.mcp.json`; restart Claude Code in this
directory and twelve tools become available:

| Tool | Purpose |
| --- | --- |
| `sbv_sync` | Push the current code state into the vault |
| `sbv_capture_note` | Write a concept note, linked to the files it explains |
| `sbv_record_decision` | Write an ADR, linked to the code it affects |
| `sbv_log_session` | Record what was worked on, linked to today's journal |
| `sbv_search` | Full-text search across the vault |
| `sbv_read_note` / `sbv_list_notes` | Read and enumerate notes |
| `sbv_graph_stats` | Hubs, orphans, clusters, PageRank |
| `sbv_related` | What links to and from a note or source path |
| `sbv_link_notes` | Connect two notes |
| `sbv_note_for_file` | Map `src/foo.ts` → its note |
| `sbv_open_in_obsidian` | Get an `obsidian://` deep link |

Links accept source paths, note ids, or note names — `"src/cli.ts"` and
`"Codebase/Files/src.cli.ts"` both work.

The point of the MCP half: the mirror can only see what the parser can derive.
*Why* something was built a certain way has to be written down, and these tools
put that in the same graph as the code it describes.

---

## The visualizer

`sbv serve --watch` serves a live force-directed graph:

- Colour-coded by note type, sized by PageRank
- Click a node to read the note; click through its connections
- Search, filter by type, toggle orphans and missing link targets
- Live updates over SSE — edit a file and the graph moves
- **Open in Obsidian** button on every note

It binds to `127.0.0.1` deliberately: it serves your note contents with no
authentication, so it should not be exposed to a network.

---

## Configuration

`sbv.config.json`, created by `init`:

```jsonc
{
  "projectName": "second-brain-visualizer",
  "source": {
    "root": ".",
    "exclude": [],            // extra ignore patterns (gitignore syntax)
    "extensions": [".ts", ".py", "..."],
    "maxFileSizeKb": 512,     // larger files are indexed by metadata only
    "respectGitignore": true,
    "includeDotfiles": false
  },
  "vault": {
    "path": "./vault",        // anywhere: "~/Documents/MyVault" works
    "manageObsidianConfig": true
  },
  "mirror": {
    "folder": "Codebase",
    "emitModules": true,
    "emitPackages": true,
    "pruneOrphans": true
  },
  "server": { "port": 4141, "host": "127.0.0.1" },
  "watch": { "debounceMs": 400, "journal": true }
}
```

Environment overrides: `SBV_VAULT_PATH`, `SBV_PROJECT_DIR`, `SBV_PORT`,
`SBV_PROJECT_NAME`.

### Pointing at an existing vault

Set `vault.path` to it and set `manageObsidianConfig: false` so your Obsidian
settings are left alone. Everything generated stays inside the `Codebase/`
folder, so it will not collide with existing notes.

---

## How it works

```
scan ──> analyze ──> resolve ──> model ──> render ──> reconcile
 │         │            │          │         │           │
 │         │            │          │         │           └─ write changed notes,
 │         │            │          │         │              prune vanished ones
 │         │            │          │         └─ markdown with wikilinks
 │         │            │          └─ files + modules + packages, with backlinks
 │         │            └─ specifiers to real paths (or external packages)
 │         └─ imports, symbols, TODOs, summaries (comments blanked first)
 └─ walk the tree, honouring .gitignore
```

Notable details:

- **`.gitignore` is honoured properly** — negation, anchoring, `**`, directory-only
  rules, and nested ignore files, implemented in `src/util/ignore.ts`.
- **Comments are blanked before parsing**, so a commented-out import never becomes
  a graph edge.
- **Analysis is cached** by size + mtime, so watch-mode syncs are incremental.
- **Syncs never overlap.** Events arriving mid-sync schedule exactly one
  follow-up pass.
- **The vault can't mirror itself** — it is excluded from scanning and watching.

Languages with import and symbol extraction: TypeScript, JavaScript, JSX/TSX,
Vue, Svelte, Python, Go, Rust, Java, Kotlin, Scala, C#, C/C++, Ruby, PHP, Elixir,
Shell, SQL, GraphQL, Protobuf, CSS/SCSS, and Markdown.

---

## Development

```bash
npm run build     # compile + copy UI assets
npm test          # 41 unit tests
npm run dev       # tsc --watch
```

Tests cover the parts that fail silently: gitignore semantics, frontmatter
round-tripping, managed-region preservation, import resolution across languages,
and graph metrics.
