# Repository Guidelines

## Project Structure & Module Organization
- Root VS Code extension (TypeScript) in `src/`; compiled output in `out/`.
- Webview UI (Angular) in `webview-ui/` with its own `package.json` and tests.
- Tests for the extension in `src/test/` (Mocha via @vscode/test).
- Assets in `assets/`, docs in `docs/`, configuration in `.eslintrc.json`, `.prettierrc`, and `tsconfig.json`.

## Build, Test, and Development Commands
- Install all deps: `npm run install:all` (root + webview).
- Build extension: `npm run compile` (emits to `out/`). Watch: `npm run watch`.
- Lint extension: `npm run lint`.
- Test extension: `npm test`.
- Webview dev server: `npm run start:webview` (equivalent to `cd webview-ui && ng serve`).
- Webview build: `npm run build:webview` (Angular build, no output hashing).

## Coding Style & Naming Conventions
- Linting: ESLint for `src/**` (webview is ignored by root ESLint). Fix lint warnings before PR.
- Formatting: Prettier (tabs, `tabWidth: 1`, `semi: true`, `printWidth: 100`). Run your editor’s Prettier on save.
- TypeScript: camelCase for vars/functions, PascalCase for classes/types, UPPER_CASE for constants.
- Tests: extension tests `*.test.ts` in `src/test/`; Angular tests follow `*.spec.ts`.

## Testing Guidelines
- Extension: write Mocha tests in `src/test/` and run `npm test`.
- Webview (Angular): run `cd webview-ui && npm test` (Karma/Jasmine). Prefer small, focused specs per component/service.
- Add regression tests for bugs. Keep test names descriptive (e.g., "should persist todo on save").

## Commit & Pull Request Guidelines
- Prefer Conventional Commits (e.g., `feat(extension): add status bar item`, `fix(webview): prevent drag in edit mode`).
- Include scope `extension` or `webview` where applicable.
- Before opening a PR: run `npm run lint`, `npm test`, and (if changed) `npm run build:webview`.
- PRs should include: clear description, linked issues, and screenshots/GIFs for UI changes.

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

