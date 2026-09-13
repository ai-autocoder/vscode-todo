# Repository Guidelines

## Project Structure & Module Organization
- Root VS Code extension (TypeScript) in `src/`; compiled output in `out/src/`.
- Webview UI (Angular) in `webview-ui/` with its own `package.json` and tests.
- Tests for the extension in `src/test/` (Mocha via @vscode/test).
- Assets in `assets/`, docs in `docs/`, configuration in `.eslintrc.json`, `.prettierrc`, and `tsconfig.json`.

### `packages/core` is compiled into the extension, not installed

The extension compiles `packages/core/src/**` alongside `src/**` and imports it through the one
re-export in **`src/core.ts`**. Import shared code from there (`import { … } from "../core"`),
never as `"@vsc-todo/core"`: the package is ESM with bundler-style resolution, so a `paths`
mapping would type-check and then fail to `require` at runtime. The webview keeps using the
package name — its bundler resolves it via `webview-ui/tsconfig.json`.

Because there are two source roots, tsc's inferred root is the repo root, so output lands at
`out/src/**` and `out/packages/core/src/**`. That is why `main` is `./out/src/extension.js` and
the test glob is `out/src/test/**`.

## Build, Test, and Development Commands
- Install all deps: `npm run install:all` (root + webview + core + worker).
- Build extension: `npm run compile` (emits to `out/src/`). Watch: `npm run watch`.
- Lint extension: `npm run lint`.
- Test extension: `npm test`.
- Webview dev server: `npm run start:webview` (equivalent to `npm --prefix webview-ui run start`).
- **PWA** dev server: `npm run start:webview:pwa`. Use this — not `start:webview` — for any mobile
  or touch work. Only the `pwa` configuration prepends `src/pwa/vscode-theme.css`, and every
  mobile rule (`@media (pointer: coarse)`: 48px touch targets, larger body text, the two-row item
  layout, always-visible row actions) lives in that one file. Under plain `start:webview` none of
  it is in the page, so no amount of device emulation will show the mobile layout.
  - Quick check for which configuration a running server is serving — in the browser console,
    `getComputedStyle(document.documentElement).getPropertyValue('--touch-target-size')`.
    Empty means non-PWA; `48px` means the `pwa` config is live.
  - DevTools must be in **device emulation** (pick a device preset). Merely narrowing the window
    leaves `pointer: fine`, so the coarse-pointer rules stay inactive.
  - Angular fails with `Port 4200 is already in use` if another dev server is up, and prints it
    below the build output where it is easy to miss — the browser then keeps talking to the old
    server. Stop the previous one, or pass a port:
    `npm --prefix webview-ui run start:pwa -- --port 4300`. Extra flags must go through the
    `--prefix` form; they do not survive the root wrapper's `npm run`.
- Webview build: `npm run build:webview` (Angular build, no output hashing). PWA: `npm run build:webview:pwa`.

## Coding Style & Naming Conventions
- Linting: ESLint for `src/**` (webview is ignored by root ESLint). Fix lint warnings before PR.
- Formatting: Prettier (tabs, `tabWidth: 1`, `semi: true`, `printWidth: 100`). Run your editor’s Prettier on save.
- TypeScript: camelCase for vars/functions, PascalCase for classes/types, UPPER_CASE for constants.
- Tests: extension tests `*.test.ts` in `src/test/`; Angular tests follow `*.spec.ts`.

## Testing Guidelines

Three suites, three runners. All three run in CI (`.github/workflows/ci.yml`) on every pull
request and again on pushes to `master`/`main`.

| Suite | Location | Run it with |
| --- | --- | --- |
| Extension (Mocha, real VS Code) | `src/test/**/*.test.ts` | `npm test` |
| Webview + PWA (Karma/Jasmine) | `webview-ui/src/**/*.spec.ts` | `npm run test:webview` |
| Core sync engine (Vitest) | `packages/core/test/*.test.ts` | `npm run test:core` |

- `packages/core` holds the sync engine, three-way merge, tag rules and IndexedDB stores. It
  installs separately (`npm run install:all` covers it) and has no runtime deps. **Both** peers
  run it — the extension compiles it in (see above), the PWA bundles it — so a change here
  changes how the extension syncs too, and `npm run test:core` is not optional.
- Specs under `webview-ui/src/app/pwa/**` are PWA-only but run in the same Karma pass as the
  shared ones — there is no separate PWA test command.
- The extension runner picks up `out/src/test/**/*.test.js`, so a suite anywhere under
  `src/test/` is collected; it does not have to sit in `src/test/suite/`.
- CI also builds **both** Angular targets (`build` and `build:pwa`). The PWA-only files
  (`bootstrap.pwa.ts`, `data.providers.pwa.ts`, `app/pwa/**`) are type-checked by nothing
  else, so a change that breaks only the PWA is caught there and not by the extension build.
- Add regression tests for bugs. Keep test names descriptive (e.g., "should persist todo on save").

## Commit & Pull Request Guidelines
- Prefer Conventional Commits (e.g., `feat(extension): add status bar item`, `fix(webview): prevent drag in edit mode`).
- Include scope `extension` or `webview` where applicable.
- Before opening a PR: run `npm run lint`, `npm test`, and (if changed) `npm run build:webview`.
- PRs should include: clear description, linked issues, and screenshots/GIFs for UI changes.

## Deployment

Three targets. Match the command to what you changed — deploying the wrong one looks like it
succeeded while shipping nothing.

| Change | Target | Command |
| --- | --- | --- |
| `webview-ui/**`, `packages/**` | Cloudflare **Pages** → https://plans-app.pages.dev | `npm run deploy:pwa` |
| `worker/**` (GitHub device-flow CORS proxy) | Cloudflare **Workers** | `npm run deploy:worker` |
| `src/**`, **or any shared `webview-ui` file** | VS Code Marketplace / Open VSX | `vsce publish` (maintainer only) |

### `webview-ui/` is shared — most edits hit both surfaces

The extension webview and the PWA are **two builds of one Angular app**, not separate UIs.
`npm run build:webview` and `build:pwa` differ by:

- `index.html` → `index.pwa.html`
- three `fileReplacements`: `environments/environment.ts`, `bootstrap.ts`,
  `app/data/data.providers.ts` → their `.pwa` variants
- one extra prepended stylesheet, `src/pwa/vscode-theme.css`
- a separate output directory: `build/browser` vs `build-pwa/browser`

Plus the service worker, web manifest, app icons, the Cloudflare Pages `_headers` and
`_redirects` files, and hashed filenames the `pwa` configuration adds. The table in
ARCHITECTURE.md §7 is the complete list.

**PWA-only** paths (safe to change without touching the extension): `src/pwa/**`,
`src/app/pwa/**`, `src/*.pwa.*`, `src/environments/environment.pwa.ts`.

Everything else — `src/app/**`, `src/styles.css` — is **shared**. Editing it changes the
extension webview too, and that half only ships on the next Marketplace release, so a
"PWA fix" can quietly alter the extension for weeks before anyone sees it. When touching
shared files, sanity-check both: the PWA against a `dvh`/mobile viewport, the extension
webview against VS Code's own injected styles (it already sets `body { margin: 0 }` and
supplies the `--vscode-*` theme vars that `vscode-theme.css` only *polyfills* for the PWA).

- Nothing deploys the PWA automatically — the Pages project has no Git provider connected,
  so a release means running `npm run deploy:pwa` yourself.
- The PWA is a **static Pages site**; `wrangler deploy` (no `pages`) publishes the *worker*
  and never touches the UI.
- **The two targets have separate output directories**, so neither build clobbers the other:
  the extension build emits to `webview-ui/build/browser`, the PWA build to
  `webview-ui/build-pwa/browser` (set by `outputPath` on the `pwa` configuration in
  `angular.json`). Note the nested `browser/` — that inner dir is what gets uploaded, not
  `build-pwa/` itself. They shared one directory until then, and since the Angular builder
  clears its output path, a PWA build left `webview-ui/build` full of hashed PWA output that
  `vsce package` would ship as the extension webview. Packaging no longer depends on what
  happens to be on disk either: `vscode:prepublish` runs `build:webview` itself.
- Pages routes the apex domain to its **production branch, `main`**. Deploying with any
  other `--branch` lands as a preview on a hash subdomain and leaves `plans-app.pages.dev`
  untouched, so always pass `--branch main` for a real release.
- Verify a release against the apex, not the deployment URL wrangler prints — the latter can
  serve the new build while the apex still serves the old one.

## Security & Configuration Tips
- Webview: keep strict CSP; use the provided `getNonce`/`getUri` helpers; avoid `eval`/inline scripts.
- Settings keys are under `vscodeTodo.*` (see `package.json`). Validate and document new settings.
- Avoid network calls from the webview; prefer messaging via VS Code APIs.

## Task tracking (VS Code Todo MCP)

When the `todo_*` tools are connected, the MCP is this project's task tracker. Reach for it
when the task at hand actually involves tracked work — don't call it on every turn:

- **When the user refers to tasks, todos, plans, or "what's next"** (or you need to find
  existing tracked work), read with `todo_list_items` / `todo_count_items` (`workspace` scope)
  before searching the repo — the MCP is the source of truth for outstanding work.
- **When you produce a multi-step plan worth keeping**, save it with `todo_add_items`
  (`workspace`) and tag every step with one shared plan tag via `todo_set_tags`; re-read it
  with the `tag` filter.
- **When you finish a tracked step**, mark it with `todo_set_completed` (don't delete).

Skip it for quick questions or one-off edits that aren't about tracked work. Each tool's
description covers scopes, notes, filtering, and read-only behavior.

