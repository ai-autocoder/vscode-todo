import * as vscode from "vscode";
import { StoreState } from "./todo/todoTypes";
import { SyncStatus, GlobalSyncMode, WorkspaceSyncMode } from "./sync/syncTypes";

let _statusBarItem: vscode.StatusBarItem | undefined;
let _userSyncStatus: SyncStatus = SyncStatus.Offline;
let _workspaceSyncStatus: SyncStatus = SyncStatus.Offline;
let _context: vscode.ExtensionContext | undefined;

/**
 * Creates a status bar item and adds it to the vscode extension context.
 *
 * @param {vscode.ExtensionContext} context - The vscode extension context.
 * @return {void} There is no return value.
 */
export function initStatusBarItem(context: vscode.ExtensionContext) {
	_context = context;
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

	// Get sync mode from internal storage
	const userSyncMode = _context?.globalState.get<string>("syncMode", "profile-local") || "profile-local";
	const workspaceSyncMode = _context?.workspaceState.get<string>("syncMode", "local") || "local";
	const isGitHubEnabled = userSyncMode === "github" || workspaceSyncMode === "github";

	// Show only actionable status indicators (no mode icons, no "synced" check)
	let statusIndicator = "";

	if (isGitHubEnabled) {
		// Only show icon when user attention is needed - prioritize most important status
		if (_userSyncStatus === SyncStatus.Error || _workspaceSyncStatus === SyncStatus.Error) {
			statusIndicator = "$(error) "; // Error (highest priority)
		} else if (_userSyncStatus === SyncStatus.Syncing || _workspaceSyncStatus === SyncStatus.Syncing) {
			statusIndicator = "$(sync~spin) "; // Syncing (second priority)
		} else if (_userSyncStatus === SyncStatus.Dirty || _workspaceSyncStatus === SyncStatus.Dirty) {
			statusIndicator = "$(warning) "; // Unsaved changes
		}
		// No icon for synced state - this is the normal/expected state
	}

	_statusBarItem.text = `${statusIndicator}☑️ ${state.user.numberOfTodos}/${state.workspace.numberOfTodos}/${currentFileTodos} | 📒 ${state.user.numberOfNotes}/${state.workspace.numberOfNotes}/${currentFileNotes}`;

	// Build tooltip with sync info
	// Helper function to get icon + label for sync mode (using emoji for tooltip compatibility)
	const getUserSyncModeDisplay = (mode: string) => {
		if (mode === "github") return "☁️ GitHub";
		if (mode === "profile-sync") return "🔄 Profile Sync";
		return "📁 Local (Profile)";
	};
	const getWorkspaceSyncModeDisplay = (mode: string) => {
		if (mode === "github") return "☁️ GitHub";
		return "📁 Local (Workspace)";
	};

	const userSyncModeDisplay = getUserSyncModeDisplay(userSyncMode);
	const workspaceSyncModeDisplay = getWorkspaceSyncModeDisplay(workspaceSyncMode);

	// Show both sync modes clearly with header, icons, and text labels
	let syncInfo = `**Sync Modes**\n\n`;
	syncInfo += `**User:** ${userSyncModeDisplay}`;
	if (userSyncMode === "github") {
		const globalStatusText = getSyncStatusText(_userSyncStatus);
		syncInfo += ` ${globalStatusText}`;
	}
	syncInfo += `\n\n**Workspace:** ${workspaceSyncModeDisplay}`;
	if (workspaceSyncMode === "github") {
		const workspaceStatusText = getSyncStatusText(_workspaceSyncStatus);
		syncInfo += ` ${workspaceStatusText}`;
	}
	syncInfo += `\n\n---\n\n`;

	_statusBarItem.tooltip = new vscode.MarkdownString(
		`${syncInfo}**Todo**☑️

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

/**
 * Update sync status for status bar display
 */
export function updateSyncStatus(scope: "user" | "workspace", status: SyncStatus) {
	if (scope === "user") {
		_userSyncStatus = status;
	} else {
		_workspaceSyncStatus = status;
	}
}

/**
 * Get human-readable sync status text
 */
function getSyncStatusText(status: SyncStatus): string {
	switch (status) {
		case SyncStatus.Synced:
			return "✓ Synced";
		case SyncStatus.Dirty:
			return "⚠️ Unsaved changes";
		case SyncStatus.Syncing:
			return "⟳ Syncing...";
		case SyncStatus.Error:
			return "❌ Error";
		case SyncStatus.Offline:
			return "○ Offline";
		default:
			return "○ Unknown";
	}
}
