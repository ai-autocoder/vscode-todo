# @vsc-todo/core

Shared, framework-agnostic core for **VS Code Todo**. No VS Code, Angular, or Node-only
dependencies — it runs in the extension host, a browser/PWA, and a worker alike.

It exists so the **mobile/PWA companion** and the **VS Code extension** speak the exact same
GitHub Gist sync protocol and share one copy of the correctness-critical three-way merge,
which can therefore never drift between the two surfaces.

## What's inside

| Module | Responsibility |
| --- | --- |
| `todoTypes` | The `Todo` data model and import/export types. |
| `tagUtils` | Tag validation/normalization rules (`normalizeTags`, `tagsInclude`). |
| `pure` | Dependency-free helpers: `isEqual`, `generateUniqueId`, path normalization, display sort. |
| `syncTypes` | On-gist data shapes (`GlobalGistData`, `WorkspaceGistData`), `GistCache`, API endpoints, file naming. |
| `threeWayMerge` | The content-based three-way merge (`threeWayMerge`, `threeWayMergeWorkspace`, …). |
| `gistClient` | GitHub Gist REST client driven by a token provider (CORS-safe for browsers). |
| `deviceFlow` | GitHub OAuth Device Flow client (via a CORS proxy). |
| `gistSyncEngine` | Reconcile-one-file sync loop: cache + remote read + merge + write. |

## The gist contract

One **secret** gist, description `"VS Code Todo Sync"`, pretty-printed JSON files:

- `user-todos.json` (and any `user-*.json`): `{ "userTodos": Todo[] }`
- `workspace-<name>.json`: `{ "workspaceTodos": Todo[], "filesData": {…}, "filesDataPaths"?: {…} }`

## Build & test

```bash
npm install      # in packages/core
npm run build    # tsc -> dist/ (ESM + d.ts)
npm test         # vitest
```

> **The VS Code extension imports this package.** It is not installed as a dependency — the
> extension compiles `packages/core/src/**` into its own `tsc` build and imports it through the
> single re-export at `src/core.ts` (see AGENTS.md). So the merge, equality, serialization and
> sync-engine code here is the *only* copy, and a change to it changes how the extension syncs
> as well as the PWA: `npm run test:core` is not optional.
>
> The extension previously kept a parallel copy in `src/sync/ThreeWayMerge.ts`. The two drifted
> — into a key-order-sensitive `isEqual` and an unsorted `filesData` — which made identical
> content read as modified and raised conflicts whose "remote" side was the unchanged local
> value. Do not reintroduce a host-local copy.
>
> Still duplicated, and worth consolidating next: `importExport.ts` (peer of the extension's
> `src/todo/exporter.ts` / `importer.ts`).
