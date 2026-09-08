import * as vscode from "vscode";
import {
	StorageKeys,
	GistCache,
	GlobalGistData,
	WorkspaceGistData,
	SyncStatus,
} from "../sync/syncTypes";
import {
	GitHubSyncInfo,
	SyncScopeStatus,
	SyncStatusInfo,
	SyncStatusValue,
	UserSyncMode,
	WorkspaceSyncMode,
} from "../panels/message";

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
	const userSyncMode = context.globalState.get<UserSyncMode>("syncMode", "profile-local");
	const workspaceSyncMode = context.workspaceState.get<WorkspaceSyncMode>("syncMode", "local");
	const userSyncEnabled = userSyncMode === "github";
	const workspaceSyncEnabled = workspaceSyncMode === "github";
	const isWorkspaceOpen = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
	const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
	const userFile = config.get<string>("github.userFile", "user-todos.json");
	const workspaceName = vscode.workspace.name || "default";
	const workspaceFile =
		config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;

	return {
		isGitHubSyncEnabled: userSyncEnabled || workspaceSyncEnabled,
		userSyncEnabled,
		workspaceSyncEnabled,
		userSyncMode,
		workspaceSyncMode,
		userFile,
		workspaceFile,
		isWorkspaceOpen,
		userLastSynced: userSyncEnabled ? getUserLastSynced(context, config) : undefined,
		workspaceLastSynced: workspaceSyncEnabled ? getWorkspaceLastSynced(context, config) : undefined,
	};
}

/**
 * The last per-scope sync state the extension announced. Module-level, like the status bar's
 * own copy in statusBarItem.ts, because a webview that is created or reloaded has to be given
 * the current state — `SyncManager` only *emits* changes, and between two of them a fresh
 * webview would otherwise render the default until the next sync happened to fire.
 */
let lastSyncStatusInfo: SyncStatusInfo = {
	isSyncing: false,
	user: { status: "offline", canRetry: false },
	workspace: { status: "offline", canRetry: false },
};

/** Records the current per-scope statuses and returns the payload to send. */
export function recordSyncStatusInfo(
	userStatus: SyncStatus,
	workspaceStatus: SyncStatus
): SyncStatusInfo {
	const user = toScopeStatus(userStatus);
	const workspace = toScopeStatus(workspaceStatus);
	lastSyncStatusInfo = {
		isSyncing: user.status === "syncing" || workspace.status === "syncing",
		user,
		workspace,
	};
	return lastSyncStatusInfo;
}

/**
 * The extension cannot classify a failure the way the PWA's gateway does — `SyncManager` keeps
 * one enum per scope and no reason alongside it — so a retry is offered for both states a sync
 * can move. That is the same affordance the Sync menu already offers unconditionally, and
 * `vsc-todo.syncNow` surfaces its own error when the retry cannot help.
 */
function toScopeStatus(status: SyncStatus): SyncScopeStatus {
	const value = toSyncStatusValue(status);
	return { status: value, canRetry: value === "dirty" || value === "error" };
}

/** The state to hand a webview that has just (re)loaded. */
export function getSyncStatusInfo(): SyncStatusInfo {
	return lastSyncStatusInfo;
}

/**
 * The webview contract is a string union rather than this enum (see message.ts), and a string
 * enum member is not assignable to its own literal type in TypeScript — hence the explicit map
 * rather than a cast, which would also silently accept a future enum member.
 */
function toSyncStatusValue(status: SyncStatus): SyncStatusValue {
	switch (status) {
		case SyncStatus.Synced:
			return "synced";
		case SyncStatus.Dirty:
			return "dirty";
		case SyncStatus.Syncing:
			return "syncing";
		case SyncStatus.Error:
			return "error";
		case SyncStatus.Offline:
			return "offline";
	}
}
