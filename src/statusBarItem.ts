import * as vscode from "vscode";
import { StoreState } from "./todo/todoTypes";

let _statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Creates a status bar item and adds it to the vscode extension context.
 *
 * @param {vscode.ExtensionContext} context - The vscode extension context.
 * @return {void} There is no return value.
 */
export function initStatusBarItem(context: vscode.ExtensionContext) {
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = "vsc-todo.openTodo";
	statusBarItem.text = "";
	statusBarItem.tooltip = "";
	statusBarItem.show();
	_statusBarItem = statusBarItem;
	return statusBarItem;
}

/**
 * Updates the status bar item with the current number of todos and notes.
 *
 * @param {Object} todoCount - An object containing the number of todos.
 */
export function updateStatusBarItem(state: StoreState) {
	if (!_statusBarItem) {return;}
	const currentFileTodos = `${state.currentFile.filePath === "" ? "-" : state.currentFile.numberOfTodos}`;
	const currentFileNotes = `${state.currentFile.filePath === "" ? "-" : state.currentFile.numberOfNotes}`;

	_statusBarItem.text = `☑️ ${state.user.numberOfTodos}/${state.workspace.numberOfTodos}/${currentFileTodos} | 📒 ${state.user.numberOfNotes}/${state.workspace.numberOfNotes}/${currentFileNotes}`;

	_statusBarItem.tooltip = new vscode.MarkdownString(
		`**Todo**☑️

- User: ${state.user.numberOfTodos}
- Workspace: ${state.workspace.numberOfTodos}
- Current File: ${currentFileTodos}

**Notes**📒

- User: ${state.user.numberOfNotes}
- Workspace: ${state.workspace.numberOfNotes}
- Current File: ${currentFileNotes}

View Todos and Notes
`
	);
}
