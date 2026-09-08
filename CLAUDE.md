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
- `core.ts` — the single re-export of `packages/core`; import shared code from here
- `todo/store.ts` — Redux store and slices
- `todo/todoTypes.ts` — re-exports the shared data model, plus the Redux-only types
- `todo/todoUtils.ts` — sorting, filtering, auto-delete
- `todo/exporter.ts` / `todo/importer.ts` — JSON/Markdown export & import
- `sync/SyncManager.ts` — schedules sync (polling, debounce, status); the reconcile itself is
  `packages/core`'s `GistSyncEngine`
- `sync/MementoCacheStore.ts` — the engine's cache, over VS Code mementos
- `sync/ConflictResolutionUI.ts` — the engine's `ConflictResolver` for this host (quick picks)
- `panels/TodoViewProvider.ts` — main webview (activity bar)
- `storage/` — `StorageSyncManager` persistence layer
- `editorHandler.ts` — active-editor tracking
- `statusBarItem.ts` — status bar integration
- `utilities/` — config, theme, logging

### Gist sync is shared code, and that is load-bearing

The extension and the PWA are two peers writing one gist, so they must agree on what changed and
how a conflict settles. All of that logic — three-way merge, the canonical `isEqual`, the
key-sorted `serialize`, the verified write, the cache baseline — lives once, in
`packages/core`, and both sides run it. Do **not** reintroduce a host-local copy of any of it:
the extension used to keep its own, and the two drifted into a key-order-sensitive `isEqual` and
an unsorted `filesData`, which made identical content read as modified and raised conflicts whose
"remote" side was the unchanged local value.

Conflicts are resolved through the engine's optional `ConflictResolver`. The extension supplies
one (blocking quick picks); the PWA supplies none and takes the `prefer-local` policy, recording
what happened for after-the-fact review. A conflict the resolver leaves undecided falls back to
the policy — it is never treated as a deletion.

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
