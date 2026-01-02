import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import StorageSyncManager from "../storage/StorageSyncManager";
import {
	currentFileActions,
	editorFocusAndRecordsActions,
	userActions,
	workspaceActions,
} from "../todo/store";
import { TodoScope } from "../todo/todoTypes";
import { getWorkspaceFilesWithRecords } from "../todo/todoUtils";
import LogChannel from "./LogChannel";
import { HelloWorldPanel } from "../panels/HelloWorldPanel";
import { TodoViewProvider } from "../panels/TodoViewProvider";

/**
 * Reload store data from storage for a specific scope
 * @param scope - The scope to reload ("user" or "workspace")
 * @param store - The Redux store
 * @param storageSyncManager - The storage sync manager
 */
export async function reloadScopeData(
	scope: "user" | "workspace",
	store: EnhancedStore,
	storageSyncManager: StorageSyncManager
): Promise<void> {
	if (scope === "user") {
		// Reload user todos
		const userTodos = await storageSyncManager.getUserTodos();
		storageSyncManager.suppressNextPersistForScope(TodoScope.user);
		store.dispatch(userActions.loadData({ data: userTodos }));
	} else {
		// Reload workspace todos
		const workspaceTodos = await storageSyncManager.getWorkspaceTodos();
		storageSyncManager.suppressNextPersistForScope(TodoScope.workspace);
		store.dispatch(workspaceActions.loadData({ data: workspaceTodos }));

		// Reload workspace files data
		const filesData = await storageSyncManager.getWorkspaceFilesData();
		store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
				getWorkspaceFilesWithRecords(filesData)
			)
		);

		// Reload current file if any
		const currentState = store.getState();
		const targetFilePath =
			currentState.currentFile.filePath ||
			currentState.editorFocusAndRecords.editorFocusedFilePath;

		if (targetFilePath) {
			const todos = filesData[targetFilePath] ?? [];
			storageSyncManager.suppressNextPersistForScope(TodoScope.currentFile);
			store.dispatch(
				currentFileActions.loadData({
					filePath: targetFilePath,
					data: todos,
				})
			);
		}
	}
}

/**
 * Clear workspace override for a specific setting
 * @param setting - The setting name (e.g., "github.userFile")
 */
export async function clearWorkspaceOverride(setting: string): Promise<void> {
	const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
	const workspaceOverride = config.inspect<string>(setting)?.workspaceValue;
	if (workspaceOverride !== undefined) {
		await config.update(setting, undefined, vscode.ConfigurationTarget.Workspace);
		LogChannel.log(`[SyncUtils] Cleared workspace override for ${setting}`);
	}

	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of workspaceFolders) {
		const folderConfig = vscode.workspace.getConfiguration("vscodeTodo.sync", folder.uri);
		const folderOverride = folderConfig.inspect<string>(setting)?.workspaceFolderValue;
		if (folderOverride !== undefined) {
			await folderConfig.update(setting, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			LogChannel.log(`[SyncUtils] Cleared workspace folder override for ${setting} (${folder.name})`);
		}
	}
}

/**
 * Notify webviews about GitHub connection status change
 * @param isConnected - Whether GitHub is connected
 */
export function notifyGitHubStatusChange(isConnected: boolean): void {
	const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
	const gistId = (config.get<string>("github.gistId") || "").trim();
	const hasGistId = gistId.length > 0;

	HelloWorldPanel.currentPanel?.updateGitHubStatus(isConnected, hasGistId);
	TodoViewProvider.currentProvider?.updateGitHubStatus(isConnected, hasGistId);
	LogChannel.log(`[SyncUtils] Notified webviews of GitHub status: ${isConnected}`);
}
