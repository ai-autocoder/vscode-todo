# VS Code Todo - Developer Guide

## Project Overview

VS Code Todo is a VS Code extension providing comprehensive todo list, notes, and task management.
Published on VS Code Marketplace and Open VSX. Version 1.17.1.

Key Technologies:
- Frontend: Angular 20.x with Material, Mermaid, KaTeX
- Backend: TypeScript, Node.js, Redux Toolkit
- Testing: Mocha (extension), Karma/Jasmine (webview)
- Code Quality: ESLint, Prettier, strict TypeScript

---

## Common Commands

### Setup
npm run install:all          # Install both extension and webview deps
npm install                  # Root extension only
cd webview-ui && npm install # Webview only

### Build
npm run compile              # TypeScript to out/
npm run watch                # Watch mode
npm run build:webview        # Angular build to build/
npm run start:webview        # Dev server localhost:4200

### Linting & Testing
npm run lint                 # ESLint on src/
npm run pretest              # compile + lint
npm test                     # Mocha extension tests
cd webview-ui && npm test    # Karma tests

### Publishing
npm run vscode:prepublish    # Prep for publishing

---

## Architecture Overview

VS Code Extension Structure:
- Extension Host (src/) - TypeScript, Redux store, VS Code APIs
- Webview UI (webview-ui/) - Angular app communicating via messaging

### Core Extension Modules

extension.ts            - Entry point, store init, command registration
todo/store.ts           - Redux store with slices
todo/todoTypes.ts       - Interfaces: Todo, TodoScope, Slices
todo/todoUtils.ts       - Utilities: sorting, filtering, auto-delete
todo/exporter.ts        - Export to JSON/Markdown
todo/importer.ts        - Import from JSON/Markdown
panels/TodoViewProvider.ts - Main webview (activity bar)
panels/HelloWorldPanel.ts   - Legacy webview panel
storage/StorageSyncManager  - Persistence layer
editorHandler.ts        - Active editor tracking
statusBarItem.ts        - Status bar integration
utilities/              - Config, theme, logging, helpers

### Redux Store Slices

user            - User-scope todos (per profile, synced via profile-sync or GitHub)
workspace       - Workspace-scoped todos
currentFile     - File-specific todos (auto-updates)
editorFocusAndRecords - Internal tracking
actionTracker   - Middleware for change tracking

### Webview Architecture

Angular 20.x SPA with components:
- app.component.ts - Root, messaging handler
- header/ - Toolbar buttons
- todo/ - Main list, items, new todo input, file list
- shared/ - Reusable components
- pipes/ - file-name, safe-html

Features:
- ngx-markdown rendering with PrismJS syntax highlighting
- Mermaid diagram support
- KaTeX math expressions
- Drag-drop reordering (CDK)
- Angular Material UI
- Clipboard integration

### Data Structure

interface Todo {
  id: number
  text: string
  completed: boolean
  creationDate: string
  completionDate?: string
  isMarkdown: boolean
  isNote: boolean
  collapsed?: boolean
}

TodoScope enum: user, workspace, currentFile

---

## Coding Conventions

Naming:
- Variables/Functions: camelCase
- Classes/Enums/Interfaces: PascalCase
- Constants: UPPER_CASE
- Redux actions: slice/actionName

TypeScript:
- Strict mode enabled
- ES6 target
- CommonJS modules

Prettier:
- Tab width: 1 (tabs)
- Print width: 100
- Semicolons: enabled
- Trailing commas: ES5

---

## Important Directories

src/                    - Extension source
src/panels/             - Webview providers
src/storage/            - Persistence
src/todo/               - Core logic
src/utilities/          - Helpers
src/test/               - Extension tests
webview-ui/             - Angular app
webview-ui/src/app/     - Components/services
out/                    - Compiled JS (generated)
webview-ui/build/       - Built webview (generated)

---

## VS Code Settings

All settings under vscodeTodo.*:

sync.github.gistId             - GitHub gist ID (32-char hex string)
sync.github.userFile           - User file in gist (default: user-todos.json)
sync.github.workspaceFile      - Workspace file in gist (auto-derived if not set)
sync.github.pollInterval       - Poll interval in seconds (30-600)
taskSortingOptions             - sortType1, sortType2, disabled
createMarkdownByDefault         - boolean
createPosition                 - top or bottom
enableLineNumbers              - boolean
enableMarkdownDiagrams         - boolean
enableMarkdownKaTeX            - boolean
enableWideView                 - boolean
autoDeleteCompletedAfterDays   - number (0 = disabled)
collapsedPreviewLines          - number (min 1)
webviewFontFamily              - string
webviewFontSize                - number

Note: User and workspace sync modes are stored in extension internal storage, not settings.
Access via commands: "Todo: Select User Sync Mode" / "Todo: Select Workspace Sync Mode"

---

## Development Workflow

Setup:
1. npm run install:all
2. Open in VS Code

Running:
1. Extension: F5 to launch (opens new window)
2. Webview: npm run start:webview (localhost:4200)

Testing:
- Extension: npm test (Mocha)
- Webview: cd webview-ui && npm test (Karma)

Before commit:
npm run lint
npm run compile
npm run build:webview
npm test

Commit format (Conventional Commits):
feat(extension): add feature
fix(webview): fix bug
docs: update
chore(deps): upgrade

---

## Deployment

Build:
npm run vscode:prepublish
npm run build:webview

Published to:
- VS Code Marketplace: FrancescoAnzalone.vsc-todo
- Open VSX Registry

---

## Security

Webview:
- Strict CSP
- Use getNonce() for inline scripts
- Use getUri() for resources
- Avoid eval()

Storage:
- No sensitive data unencrypted
- Validate imports
- Handle file path differences

---

## Useful Resources

VS Code Extension API: https://code.visualstudio.com/api
Redux Toolkit: https://redux-toolkit.js.org/
Angular: https://angular.io/docs
ngx-markdown: https://github.com/jfcere/ngx-markdown
Mermaid: https://mermaid-js.github.io/mermaid/
KaTeX: https://katex.org/
PrismJS: https://prismjs.com/

Repository Files:
- AGENTS.md - AI development guidelines
- README.md - User documentation
- CHANGELOG.md - Release history
- docs/sync-modes-prd.md - Sync feature spec

---

## Troubleshooting

Extension not loading:
- npm run compile
- Check console for errors
- Verify .vscodeignore

Webview not appearing:
- npm run build:webview
- Check webview-ui/build/
- Verify asset paths

Tests failing:
- npm run compile
- cd webview-ui && npm install
- Check Node.js version (18+)

Store not persisting:
- Verify StorageSyncManager init
- Check storage keys
- Ensure context.workspaceState accessible

---

## Key Files

package.json                    - Metadata, commands, settings
src/extension.ts                - Entry point
src/todo/store.ts               - Redux store
src/panels/TodoViewProvider.ts  - Main webview
webview-ui/src/app/app.component.ts - Angular root
AGENTS.md                       - AI guidelines
.eslintrc.json                  - Linting
.prettierrc                     - Formatting
tsconfig.json                   - TypeScript config
