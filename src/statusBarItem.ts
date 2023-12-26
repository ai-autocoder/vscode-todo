import * as vscode from "vscode";
import { FullData } from "./todo/store";

let _statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Creates a status bar item and adds it to the vscode extension context.
 *
 * @param {vscode.ExtensionContext} context - The vscode extension context.
 * @return {void} There is no return value.
 */
export function createStatusBarItem(context: vscode.ExtensionContext) {
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = "vscode-tasks.openTodo";
	statusBarItem.text = "Todo";
	statusBarItem.tooltip = "Open Todos";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);
	_statusBarItem = statusBarItem;
}

/**
 * Updates the status bar item with the current number of todos in the workspace and for the user.
 *
 * @param {string} workspaceTodos - The number of todos in the workspace.
 * @param {string} userTodos - The number of todos for the user.
 */
export function updateStatusBarItem(state: FullData) {
	if (!_statusBarItem) return;

	const { workspace, user } = getNumberOfTodos(state);
	_statusBarItem.text = `Todo ${workspace} W / ${user} U`;
	_statusBarItem.tooltip = new vscode.MarkdownString(
		`Open Todos\n- Workspace: ${workspace}\n- User: ${user}`
	);
}

/**
 * Calculate the number of incomplete todos in the given state.
 *
 * @param {FullData} state - The state containing the todos.
 * @return {{workspace: number, user: number}} - An object containing the number of todos in the workspace and for the user.
 */
function getNumberOfTodos(state: FullData) {
	const workspace = state.workspaceTodos?.filter((todo) => !todo.completed).length ?? 0;
	const user = state.userTodos?.filter((todo) => !todo.completed).length ?? 0;
	return { workspace, user };
}
