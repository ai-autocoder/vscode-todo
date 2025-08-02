<h1 align="center">

<img src="https://github.com/ai-autocoder/vscode-todo/blob/e044e89bdf974a6c6cbc81717be9f44f944fe12f/icon.png?raw=true" width="200" alt="Logo">

VS Code Todo

</h1>

<h3 align="center">The to-do and note manager for VS Code.</h3>

<p align="center">
 <a href="https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo">
 <img src="https://vsmarketplacebadges.dev/version/FrancescoAnzalone.vsc-todo.png?label=VS%20Code%20Todo" alt="Marketplace bagde"></a>
</p>

## Introduction

**VS Code Todo** is an advanced to-do list and note manager within Visual Studio Code, now featuring **Markdown Support**, **Notes**, and **Code Highlighting**. This extension allows for managing tasks and notes—whether tied to your workspace, the current file, or stored globally—all accessible directly from the VS Code status bar.

## Key Features

- **Global, Workspace, and File-specific Scopes Management**
- **Markdown Support**
- **Code Syntax Highlighting**
- **Customizable Sorting**
- **Drag-and-Drop Functionality**
- **Status Bar Integration**
- **Built-in search** (Ctrl+F on Windows, ⌘F on macOS)
- **Import and Export** (JSON / Markdown format)
- **Auto delete completed todos after a specified number of days**

![Image of UI overview](./assets/screenshots/UI-overview.gif)

### Global, Workspace & File-specific Management

Tasks and notes are organized across three different scopes, each with its respective tab:

1. **Global Tab**: Data accessible for the user across workspaces.
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

```markdown
```typescript
    const myProp: string = 'value';
    console.log(myProp);
​```
```

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
