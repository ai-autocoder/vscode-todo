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

