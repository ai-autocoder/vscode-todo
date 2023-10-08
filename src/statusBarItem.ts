import * as vscode from "vscode";

export function createStatusBarItem (context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "vscode-tasks.openTodo";
  statusBarItem.text="Tasks";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
};
