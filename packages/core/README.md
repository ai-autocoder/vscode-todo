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

> The VS Code extension does not yet import this package; that migration is a deliberate
> follow-up (the extension ships an unbundled `tsc` build, so wiring a workspace dependency
> needs packaging validation). The merge logic here is a faithful copy of the extension's
> `src/sync/ThreeWayMerge.ts` (only import paths differ) and `tagUtils.ts` is copied
> verbatim, so until the migration removes the duplication, changes to either side must be
> mirrored. The migration is what makes that drift structurally impossible.
