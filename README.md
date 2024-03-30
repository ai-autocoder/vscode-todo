# VSCode Todo Extension

## Introduction

**VSCode Todo** elevates your productivity by integrating an advanced to-do list manager within Visual Studio Code, now featuring **Markdown Support**, **Notes**, and **Code Highlighting**. This extension allows for managing tasks and notes—whether tied to your workspace, the current file, or stored globally—all accessible directly from the VSCode status bar.

## Key Features

- **Markdown Support for Todos and Notes**: Create todos and notes with rich markdown formatting, allowing for more organized and readable content.
- **Syntax Highlighting**: When rendering in markdown, you can include code snippets with syntax highlighting, supported by ngx-markdown for a wide range of programming languages.
- **Workspace, Global, & File-specific Management**: Keep your tasks and notes organized across different scopes — whether tied to your current workspace, a specific file, or available globally.
- **Status Bar Integration**: Instantly view and access your task and note count from the status bar, with a hover tooltip providing a detailed breakdown.
- **Customizable Sorting**: Tailor the sorting logic for your completed tasks to suit your workflow, with options to sort or disable sorting as needed.
- **Drag-and-Drop Functionality**: Prioritize your tasks and notes with an easy-to-use drag-and-drop interface.

## Installation

Find **VSCode Todo** in the VSCode Marketplace. Install with a single click to boost your productivity straight away.

## How to Use

A new icon appears in your status bar post-installation, displaying the number of active to-dos. Click it to open the to-do list panel where you can manage your tasks and notes.

To create a note with code highlighting, select markdown and use the following syntax:
```
```language
// your code here
```

//Replace `language` with the appropriate language identifier.


## Configuration Options
Define how your completed tasks are organized with these sorting options:

- **sortType1**: Moves completed todos to the bottom, just on top of the first completed todo.
- **sortType2**: Similar to Type 1, but groups completed todos with notes, useful for maintaining contextual relationships.
- **disabled**: Completed todos remain in place, allowing for manual organization.
  
The default sorting option is **sortType1**.

```
"vscodeTodo.taskSortingOptions": "sortType1"
```

## Screenshots

<!-- [Interface screenshots] -->

## Contributing

Contributions are welcome! Please submit pull requests, report bugs, or suggest enhancements via the [GitHub repository](#).

## License

Distributed under the MIT License. See `LICENSE` for more information.

## Support

For support, feature requests, or bug reporting, please visit the [GitHub issues page](#).

