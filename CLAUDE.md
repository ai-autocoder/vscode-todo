@AGENTS.md

# VS Code Todo — Claude Code guide

The import above pulls in **AGENTS.md** (project structure, build/test commands, coding
style, commit conventions, security rules, and the VS Code Todo MCP task-tracking
workflow). This file adds only the architecture map and a couple of non-obvious notes.

VS Code extension for todo lists, notes, and task management. Published on the VS Code
Marketplace (`FrancescoAnzalone.vsc-todo`) and Open VSX. Angular 20.x (Material, Mermaid,
KaTeX) webview + TypeScript/Node extension host with Redux Toolkit.

---

## Architecture

Two halves communicating over VS Code's webview messaging:
- **Extension host** (`src/`) — TypeScript, Redux store, VS Code APIs
- **Webview UI** (`webview-ui/`) — Angular SPA

### Extension modules (`src/`)
- `extension.ts` — entry point: store init, command registration
- `todo/store.ts` — Redux store and slices
- `todo/todoTypes.ts` — core interfaces (`Todo`, `TodoScope`, slices)
- `todo/todoUtils.ts` — sorting, filtering, auto-delete
- `todo/exporter.ts` / `todo/importer.ts` — JSON/Markdown export & import
- `panels/TodoViewProvider.ts` — main webview (activity bar)
- `storage/` — `StorageSyncManager` persistence layer
- `editorHandler.ts` — active-editor tracking
- `statusBarItem.ts` — status bar integration
- `utilities/` — config, theme, logging

### Redux slices
`user` (per-profile, synced via profile-sync or GitHub gist), `workspace`,
`currentFile` (auto-updates with the active editor), plus internal
`editorFocusAndRecords` and `actionTracker` (change-tracking middleware).

### Webview (`webview-ui/src/app/`)
Angular 20 + Material root `app.component.ts` handles messaging. Components under
`header/`, `todo/`, `shared/`; markdown via ngx-markdown/PrismJS, Mermaid diagrams,
KaTeX math, CDK drag-drop.

---

## Settings

All settings live under `vscodeTodo.*` — see the `contributes.configuration` block in
`package.json` for the authoritative list. Non-obvious: user/workspace **sync modes** are
not settings; they're stored in extension internal storage and set via the
"Todo: Select User/Workspace Sync Mode" commands.
