import * as vscode from "vscode";
import { TodoCount } from "./todo/todoUtils";

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
 * Updates the status bar item with the current number of todos.
 *
 * @param {Object} todoCount - An object containing the number of todos.
 */
export function updateStatusBarItem({ workspace, user }: TodoCount) {
	if (!_statusBarItem) return;

	_statusBarItem.text = `Todo ${workspace} W / ${user} U`;
	_statusBarItem.tooltip = new vscode.MarkdownString(
		`Open Todos\n- Workspace: ${workspace}\n- User: ${user}`
	);
}
