<h1 align="center">

<img src="https://github.com/ai-autocoder/vscode-todo/blob/e044e89bdf974a6c6cbc81717be9f44f944fe12f/icon.png?raw=true" width="200" alt="Logo">

VS Code Todo

</h1>

<h3 align="center">Todo lists, notes, markdown checklists, and reusable AI prompts for Visual Studio Code.</h3>

<p align="center">
  <!-- VS Code Marketplace -->
  <a href="https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo">
    <img
      alt="VS Marketplace Version"
      src="https://vsmarketplacebadges.dev/version-short/FrancescoAnzalone.vsc-todo.png"
    />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo">
    <img
      alt="VS Marketplace Installs"
      src="https://vsmarketplacebadges.dev/installs-short/FrancescoAnzalone.vsc-todo.png"
    />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo">
  <img
    alt="VS Marketplace Downloads"
    src="https://vsmarketplacebadges.dev/downloads-short/FrancescoAnzalone.vsc-todo.png"
  >
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo">
    <img
      alt="VS Marketplace Rating"
      src="https://vsmarketplacebadges.dev/rating-star/FrancescoAnzalone.vsc-todo.png"
    />
  </a>
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/FrancescoAnzalone/vsc-todo">
    <img
      src="https://img.shields.io/open-vsx/v/FrancescoAnzalone/vsc-todo"
      alt="Open VSX Version"
    >
  </a>
  <a href="https://open-vsx.org/extension/FrancescoAnzalone/vsc-todo">
    <img
      alt="Open VSX Downloads"
      src="https://img.shields.io/open-vsx/dt/FrancescoAnzalone/vsc-todo"
    >
  </a>
  <a href="https://open-vsx.org/extension/FrancescoAnzalone/vsc-todo">
    <img
      alt="Open VSX Rating"
      src="https://img.shields.io/open-vsx/stars/FrancescoAnzalone/vsc-todo"
    >
  </a>
</p>

  <!-- Project meta -->

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" />
  <a href="https://prettier.io/">
    <img
      alt="Code style: Prettier"
      src="https://img.shields.io/badge/code_style-Prettier-ff69b4.svg"
    />
  </a>
  <a href="https://eslint.org/">
    <img
      alt="Lint: ESLint"
      src="https://img.shields.io/badge/lint-ESLint-4B32C3.svg"
    />
  </a>

</p>

<p align="center">
  <a href="#getting-started">Getting started</a>
  ·
  <a href="https://github.com/ai-autocoder/vscode-todo/issues">Report an issue</a>
</p>

## Introduction

**VS Code Todo** is a todo list and note-taking extension for Visual Studio Code. Capture project tasks, checklists, and meeting notes in one panel with Markdown, Mermaid diagrams, KaTeX math, and syntax highlighting. Organize items by profile, workspace, or file scope, and open them instantly from the status bar or activity bar. Save reusable AI prompts, code review checklists, and meeting note templates alongside your tasks.

Whether you are managing sprint todos, drafting code documentation, or collecting research notes, everything stays searchable. Global (profile) items roam across devices via VS Code Settings Sync; Workspace and File items stay local.

## Getting Started

After installing **VS Code Todo**, follow these steps to begin using the extension:

1. **Open the Todo Panel**

   - Click the status bar icon at the bottom of VS Code, or
   - Use the activity bar button on the left.  
     This will open the main panel.

2. **Select a Tab**

   - Use the three tabs at the top to choose where to store your items:
     - **Global (per profile)**: tasks available across all workspaces in the current VS Code profile. The extension opts this data into Settings Sync, so it roams across devices when Settings Sync is enabled.
     - **Workspace**: tasks tied to the current project (default)
     - **File**: tasks associated with the active file

3. **Add a Todo**

   - Enter text in the input box at the bottom of the panel.
   - Press **Enter** to create the item.
   - The new todo will appear in the selected tab, either at the top or bottom of the list depending on your configuration.

4. **Manage Items**

   - Each item includes a menu button with the following options:
     - Change type between **Todo** and **Note**
     - Toggle rendering between plain text and markdown
     - Delete the item
   - Items can also be **reordered** by dragging and dropping them within the list.
   - Use **multi-item selection** for batch actions:
     - `Ctrl`/`Cmd`-click toggles individual items; hold `Shift` to select a range.
     - When a selection is active, the toolbar at the bottom lets you **Select all**, **Delete**, or **Clear**; press `Esc` to exit.

5. **Use the Toolbar**

   - The toolbar above the tabs provides options to:
     - Toggle wide view
     - Export or import data (JSON / Markdown)
     - Delete all items in the current tab
     - Delete completed todos

This covers the essentials; the sections below explore markdown previews, diagrams, automation, and more.

## Key Features

- **Todo and note scopes (profile, workspace, file)** keep personal, project, and file-linked checklists organised.
- **Markdown note-taking** with syntax highlighting, Mermaid diagrams, and KaTeX math for rich technical docs.
- **Keyboard-first capture** with quick add, drag-and-drop ordering, and multi-select bulk actions.
- **Status bar & activity bar access** keeps your task list one click away anywhere in VS Code.
- **Search, filters, and auto-cleanup** surface the next task and archive completed work automatically.
- **Import / export (JSON & Markdown)** to back up, share, or move your todos and notes.

![VS Code Todo UI with markdown checklist](./assets/screenshots/UI-overview.gif)

### User, Workspace & File-specific Management

Tasks and notes are organized across three different scopes, each with its respective tab:

1. **User Tab**: Data available across all workspaces in the current VS Code profile. This data is isolated per profile. It roams across devices when Settings Sync is enabled because the extension opts the data into Settings Sync.
2. **Workspace Tab**: Data tied to the current workspace.
3. **File-specific Tab**: Data associated with a **specific file** within the current workspace. The file displayed in this tab is **automatically updated** to reflect the **most recently focused file** in the editor. However, you can **pin** the tab to a specific file, preventing it from changing when you switch focus to other files.
Additionally, you can **manually select** and display data for any file that already has an associated record from the list on the left-hand side.

### Markdown Support for Todos and Notes

Create todos and notes with rich markdown formatting, allowing for more organized and readable content.

It is possible to individually switch rendering between **text** and **markdown** in the options menu of each item in the list.

![Image for enable markdown](./assets/screenshots/enable-markdown.gif)

### Syntax highlight

When rendering in markdown, you can include code snippets with syntax highlighting.

 This is supported by ngx-markdown and the underlying [PrismJS](https://prismjs.com/#supported-languages) library, which supports hundreds of programming languages.

To create a note with code highlighting, use the standard markdown syntax.

For example, to highlight TypeScript code:

````markdown
```typescript
    const myProp: string = 'value';
    console.log(myProp);
​```
````

<details>
<summary>Supported Syntax Highlighting Languages (click to expand)</summary>

| Markup & SGML         | Programming Languages | Scripting & Markup     | Data Format & DB | Systems & Config         | Miscellaneous       |
| --------------------- | --------------------- | ---------------------- | ---------------- | ------------------------ | ------------------- |
| HTML, XML             | C, C++, C#            | JavaScript, TypeScript | JSON, JSON5      | Bash, Shell              | Markdown, YAML      |
| SVG, MathML           | Java, Kotlin          | Python, Ruby           | SQL, GraphQL     | Apache Configuration     | Docker, Dockerfile  |
| SSML, Atom, RSS       | Go, Rust              | PHP, ASP.NET           | CSV, TOML        | nginx, Systemd           | Git, Regex          |
| Ada, Agda             | Swift, Scala          | Perl, Lua              | Protocol Buffers | HTTP, HPKP               | LaTeX, Tex, Context |
| ABAP, ActionScript    | Haskell, Clojure      | R, MATLAB              | GraphQL          | .ignore (gitignore)      | WebAssembly, WebGL  |
| ANTLR4, G4            | Objective-C, Dart     | Elixir, Erlang         |                  | EditorConfig             | ASN.1, CSP          |
| Apex, APL             | F#, Ocaml             | PowerShell             |                  | INI, DNS Zone File       | VHDL, Verilog       |
| AppleScript, AQL      | Groovy, Ruby          | Shell Session          |                  | Robot Framework          | Mermaid, PlantUML   |
| Arduino, ARM Assembly | Fortran, COBOL        | AutoHotkey, AutoIt     |                  | Puppet, Bicep            | GameMaker Language  |
| Arturo, AsciiDoc      | Haskell, TypeScript   | Lua, MoonScript        |                  | AWS, Google Cloud Config | Gherkin, GraphQL    |
| ASP.NET (C#)          | Julia, Rust           | Tcl, Terraform         |                  | Ansible, Terraform       | Diff, Patch         |
| Assembly (Various)    | Nim, Crystal          | Scheme, Lisp           |                  | Kubernetes, Docker       | UML, DOT (Graphviz) |
| AWK, GAWK             | Perl, PHP             | Swift, VB.Net          |                  | Prometheus, Grafana      | XMPP, IRC           |
| Bison, BNF, RBNF      | Prolog, Python        | TypeScript             |                  | Nagios, Zabbix           | LaTeX, SAS, R       |

_Note: This table represents a subset of the languages supported by PrismJS. For a full list, please refer to the [PrismJS supported languages page](https://prismjs.com/#supported-languages)._

</details>

### Mermaid Diagram Support

You can create diagrams and charts using [Mermaid](https://mermaid-js.github.io/mermaid/#/) syntax. To render a Mermaid diagram, ensure that the "View as Markdown" option is selected for the item, and then wrap your Mermaid code in a `mermaid` block:

````markdown
```mermaid
graph TD;
    A-->B;
    A-->C;
    B-->D;
    C-->D;
```
````

#### Toggle Diagram Rendering

If you prefer to see Mermaid code with syntax highlighting instead of rendered diagrams, set the following setting in your VS Code settings:

```json
"vscodeTodo.enableMarkdownDiagrams": false
```

When disabled, Mermaid code blocks render as regular code with Prism highlighting; when enabled (default), they render as diagrams.

### KaTeX Math Support

Render mathematical expressions using [KaTeX](https://katex.org/) in Markdown items. Enable "View as Markdown" for the item, then use KaTeX delimiters. Math is not rendered inside fenced code blocks (```), so do not wrap math in triple backticks.

- Inline math: `$a^2 + b^2 = c^2$`
- Block math (put on separate lines, no backticks):

  $$
  \int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
  $$

Supported delimiters include `$...$`, `$$...$$`, `\( ... \)`, and `\[ ... \]`.

#### Toggle Math Rendering

To disable KaTeX rendering and show math delimiters as plain text with syntax highlighting instead, set the following setting in VS Code:

```json
"vscodeTodo.enableMarkdownKatex": false
```

When enabled (default), inline `$...$` and block `$$...$$` expressions render as KaTeX. If you see a code block instead, remove surrounding triple backticks—KaTeX does not render inside code fences.

### Customizable Sorting

You can personalize how the completed tasks are sorted, with two sorting options and the ability to disable sorting as needed.

To define the sorting options:

- **sortType1**: Moves completed todos to the bottom, just on top of the first completed todo.
- **sortType2**: Similar to Type 1, but groups completed todos with notes, useful for maintaining contextual relationships.
- **disabled**: Completed todos remain in place, allowing full manual control of the order.

The default sorting option is **sortType1**.

```json
"vscodeTodo.taskSortingOptions": "sortType1"
```

### Auto delete completed todos after a specified number of days

You can configure the extension to automatically delete completed todos after a specified number of days. This feature helps keep your task list clean and manageable.
To enable this feature, set the `vscodeTodo.autoDeleteCompletedAfterDays` configuration option to the desired number of days. Set it to `0` to disable auto-deletion.

```json
"vscodeTodo.autoDeleteCompletedAfterDays": 7
```

### Collapsed item preview lines

Control how many lines are shown when an item is collapsed. Set `vscodeTodo.collapsedPreviewLines` to the desired number of lines (minimum 1). Default is 1.

```json
"vscodeTodo.collapsedPreviewLines": 2
```

### Webview Font Settings

Control the webview's typography with two settings:

- `vscodeTodo.webviewFontFamily`: CSS font-family string. Leave empty to inherit VS Code's font.
- `vscodeTodo.webviewFontSize`: Number in pixels. Set `0` to inherit VS Code's editor font size.

Example:

```json
"vscodeTodo.webviewFontFamily": "'Fira Code', Consolas, 'Courier New', monospace",
"vscodeTodo.webviewFontSize": 18
```

### Status Bar Integration

View and access your task and note count from the status bar, with a hover tooltip providing a detailed breakdown.

![UI status bar](./assets/screenshots/statusBar.png)

### Import from JSON / Markdown

Use **Command palette**:

- `Import data from JSON` or
- `Import data from Markdown`

**Requirements:**

- The file to import must be in the workspace root folder.

**Behavior:**

#### JSON

- If an `id` matches an existing record, the provided values will override the existing ones. Otherwise, a new record will be added.
- `text` is the only required property (and the `file path` for file-specific records).

<details>
<summary>JSON example (click to expand)</summary>

```json
{
  "user": [
    { /* if the id matches an existing record, the provided values will override the existing ones. */
      "id": 1234567890123456,
      "text": "Complete the project documentation",
      "completed": false,
      "isMarkdown": true,
      "isNote": false,
      "creationDate": "2024-05-19T12:34:56.789Z"
    },
    { 
      /* if the id is not provided or does not match an existing record, a new record is added. */
      "text": "Review pull requests",
    }
  ],
  "workspace": [
    {
      "id": 3456789012345678,
      "text": "Set up new workspace",
      "completed": false,
      "isMarkdown": false,
      "isNote": true,
      "creationDate": "2024-05-20T10:00:00.789Z"
    }
  ],
  "files": {
    "c:\\Users\\username\\Documents\\project\\README.md": [
      {
        "id": 4567890123456789,
        "text": "Add installation instructions",
        "completed": false,
        "isMarkdown": true,
        "isNote": false,
        "creationDate": "2024-05-18T14:22:33.456Z"
      }
    ],
    "c:\\Users\\username\\Documents\\project\\src\\main.js": [
      {
        "id": 5678901234567890,
        "text": "Refactor main function",
        "completed": true,
        "isMarkdown": false,
        "isNote": false,
        "creationDate": "2024-05-17T16:00:00.789Z",
        "completionDate": "2024-05-17T18:30:00.123Z"
      }
    ]
  }
}
```

</details>

#### Markdown

- Imported records will be added to the existing ones.

### Export to JSON / Markdown

You can export data by using the **Command palette**:

- Select  `Export data to JSON` or
- Select  `Export data to Markdown`

The exported file will be saved in the root folder of your workspace.

## Contributing

Contributions are welcome! Please submit pull requests, report bugs, or suggest enhancements via the [GitHub repository](https://github.com/ai-autocoder/vscode-todo).

## License

Distributed under the MIT License. See `LICENSE` for more information.

## Support

For support, feature requests, or bug reporting, please visit the [GitHub issues page](https://github.com/ai-autocoder/vscode-todo/issues).
