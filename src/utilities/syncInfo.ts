import * as vscode from "vscode";
import { StorageKeys, GistCache, GlobalGistData, WorkspaceGistData } from "../sync/syncTypes";
import { GitHubSyncInfo } from "../panels/message";

function getUserLastSynced(
	context: vscode.ExtensionContext,
	config: vscode.WorkspaceConfiguration
): string | undefined {
	const fileName = config.get<string>("github.userFile", "user-todos.json");
	const cacheKey = StorageKeys.globalGistCache(fileName);
	const cache = context.globalState.get<GistCache<GlobalGistData>>(cacheKey);
	return cache?.lastSynced;
}

function getWorkspaceLastSynced(
	context: vscode.ExtensionContext,
	config: vscode.WorkspaceConfiguration
): string | undefined {
	const workspaceName = vscode.workspace.name || "default";
	const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
	const cacheKey = StorageKeys.workspaceGistCache(fileName);
	const cache = context.workspaceState.get<GistCache<WorkspaceGistData>>(cacheKey);
	return cache?.lastSynced;
}

export function getGitHubSyncInfo(context: vscode.ExtensionContext): GitHubSyncInfo {
	const userSyncMode = context.globalState.get<string>("syncMode", "profile-local");
	const workspaceSyncMode = context.workspaceState.get<string>("syncMode", "local");
	const userSyncEnabled = userSyncMode === "github";
	const workspaceSyncEnabled = workspaceSyncMode === "github";
	const config = vscode.workspace.getConfiguration("vscodeTodo.sync");

	return {
		isGitHubSyncEnabled: userSyncEnabled || workspaceSyncEnabled,
		userSyncEnabled,
		workspaceSyncEnabled,
		userLastSynced: userSyncEnabled ? getUserLastSynced(context, config) : undefined,
		workspaceLastSynced: workspaceSyncEnabled ? getWorkspaceLastSynced(context, config) : undefined,
	};
}
