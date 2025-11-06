/**
 * Sync Commands
 * VS Code commands for GitHub Gist sync features
 */

import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { GitHubAuthManager } from "./GitHubAuthManager";
import { GitHubApiClient } from "./GitHubApiClient";
import { SyncManager } from "./SyncManager";
import { GlobalSyncMode, WorkspaceSyncMode, GIST_ID_REGEX, SyncErrorType } from "./syncTypes";
import { StoreState, TodoScope } from "../todo/todoTypes";
import { userActions, workspaceActions, editorFocusAndRecordsActions, currentFileActions } from "../todo/store";
import StorageSyncManager from "../storage/StorageSyncManager";
import { getWorkspaceFilesWithRecords } from "../todo/todoUtils";
import { reloadScopeData, clearWorkspaceOverride, notifyGitHubStatusChange } from "../utilities/syncUtils";
import { WebviewVisibilityCoordinator } from "./WebviewVisibilityCoordinator";

export class SyncCommands {
	private authManager: GitHubAuthManager;
	private apiClient: GitHubApiClient;
	private syncManager: SyncManager;
	private context: vscode.ExtensionContext;
	private store: EnhancedStore<StoreState>;
	private storageSyncManager: StorageSyncManager;
	private visibilityCoordinator: WebviewVisibilityCoordinator | undefined;

	constructor(
		context: vscode.ExtensionContext,
		authManager: GitHubAuthManager,
		apiClient: GitHubApiClient,
		syncManager: SyncManager,
		store: EnhancedStore<StoreState>,
		storageSyncManager: StorageSyncManager
	) {
		this.context = context;
		this.authManager = authManager;
		this.apiClient = apiClient;
		this.syncManager = syncManager;
		this.store = store;
		this.storageSyncManager = storageSyncManager;
	}

	/**
	 * Set the visibility coordinator (called after coordinator is created in extension.ts)
	 */
	public setVisibilityCoordinator(coordinator: WebviewVisibilityCoordinator): void {
		this.visibilityCoordinator = coordinator;
	}

	/**
	 * Reload store data from current sync mode
	 */
	private async reloadStoreData(scope: "user" | "workspace"): Promise<void> {
		await reloadScopeData(scope, this.store, this.storageSyncManager);
	}

	/**
	 * Register all sync commands
	 */
	public registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand("vsc-todo.connectGitHub", () => this.connectGitHub()),
			vscode.commands.registerCommand("vsc-todo.disconnectGitHub", () => this.disconnectGitHub()),
			vscode.commands.registerCommand("vsc-todo.setGistId", () => this.setGistId()),
			vscode.commands.registerCommand("vsc-todo.viewGistOnGitHub", () => this.viewGistOnGitHub()),
			vscode.commands.registerCommand("vsc-todo.selectUserSyncMode", () => this.selectUserSyncMode()),
			vscode.commands.registerCommand("vsc-todo.selectWorkspaceSyncMode", () => this.selectWorkspaceSyncMode()),
			vscode.commands.registerCommand("vsc-todo.setUserFile", () => this.setUserFile()),
			vscode.commands.registerCommand("vsc-todo.setWorkspaceFile", () => this.setWorkspaceFile()),
			vscode.commands.registerCommand("vsc-todo.syncNow", () => this.syncNow()),
		];
	}

	/**
	 * Command: Connect GitHub
	 */
	private async connectGitHub(): Promise<void> {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Connecting to GitHub...",
				cancellable: false,
			},
			async () => {
				const success = await this.authManager.connect();
				if (success) {
					notifyGitHubStatusChange(true);
				}
			}
		);
	}

	/**
	 * Command: Disconnect GitHub
	 */
	private async disconnectGitHub(): Promise<void> {
		const confirm = await vscode.window.showWarningMessage(
			"Are you sure you want to disconnect GitHub? Your gists will remain on GitHub.",
			{ modal: true },
			"Disconnect",
			"Cancel"
		);

		if (confirm === "Disconnect") {
			await this.authManager.disconnect();

			// Revert sync modes to local/profile-local
			await this.context.globalState.update("syncMode", "profile-local");
			await this.context.workspaceState.update("syncMode", "local");

			// Stop polling
			this.syncManager.stopPolling("user");
			this.syncManager.stopPolling("workspace");

			// Notify webviews
			notifyGitHubStatusChange(false);
		}
	}

	/**
	 * Command: Set Gist ID
	 */
	private async setGistId(): Promise<void> {
		const gistId = await vscode.window.showInputBox({
			prompt: "Enter your GitHub Gist ID (32-character hex string)",
			placeHolder: "abc123def456...",
			validateInput: (value) => {
				if (!value) {
					return "Gist ID is required";
				}
				if (!GIST_ID_REGEX.test(value)) {
					return "Invalid gist ID format. Must be 32-character hex string.";
				}
				return null;
			},
		});

		if (!gistId) {
			return;
		}

		// Verify gist exists and is accessible
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Verifying gist...",
				cancellable: false,
			},
			async () => {
				const result = await this.apiClient.verifyGist(gistId);
				if (!result.success) {
					vscode.window.showErrorMessage(
						`Failed to verify gist: ${result.error?.message || "Unknown error"}`
					);
					return;
				}

				// Ask where to save
				const scope = await vscode.window.showQuickPick(
					[
						{
							label: "User Settings",
							description: "All workspaces will use this gist ID by default",
							target: vscode.ConfigurationTarget.Global,
						},
						{
							label: "Workspace Settings",
							description: "Only this workspace will use this gist ID",
							target: vscode.ConfigurationTarget.Workspace,
						},
					],
					{
						placeHolder: "Where do you want to save the gist ID?",
					}
				);

				if (!scope) {
					return;
				}

				const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
				await config.update("github.gistId", gistId, scope.target);

				vscode.window.showInformationMessage(
					"Gist ID saved. Use sync mode commands to enable GitHub sync."
				);
			}
		);
	}

	/**
	 * Command: View Gist on GitHub
	 */
	private async viewGistOnGitHub(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const gistId = config.get<string>("github.gistId");

		if (!gistId) {
			vscode.window.showErrorMessage("Gist ID not configured. Use 'Set Gist ID' command first.");
			return;
		}

		const url = this.apiClient.getGistUrl(gistId);
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	/**
	 * Command: Select User Sync Mode
	 */
	private async selectUserSyncMode(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const currentMode = this.context.globalState.get<string>("syncMode", "profile-local");

		const items = [
			{
				label: "$(archive) Local",
				description: "This device only",
				detail: currentMode === "profile-local" ? "✓ Currently selected" : undefined,
				mode: GlobalSyncMode.Local,
			},
			{
				label: "$(sync) Profile Sync",
				description: "Syncs via VS Code Settings Sync",
				detail: currentMode === "profile-sync" ? "✓ Currently selected" : undefined,
				mode: GlobalSyncMode.ProfileSync,
			},
			{
				label: "$(github) GitHub Gist",
				description: "Syncs via manually-created gist",
				detail: currentMode === "github" ? "✓ Currently selected" : "[Requires gist ID configuration]",
				mode: GlobalSyncMode.GitHub,
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select sync mode for user lists",
		});

		if (!selected) {
			return;
		}

		if (selected.mode === GlobalSyncMode.GitHub) {
			// Ensure authenticated
			const isAuth = await this.authManager.ensureAuthenticated();
			if (!isAuth) {
				return;
			}

			// Ensure gist ID is configured
			const gistId = config.get<string>("github.gistId");
			if (!gistId) {
				const setup = await vscode.window.showInformationMessage(
					"Gist ID not configured. Would you like to set it now?",
					"Set Gist ID",
					"Cancel"
				);
				if (setup === "Set Gist ID") {
					await this.setGistId();
				}
				return;
			}

			// Enable GitHub sync via internal storage
			await this.context.globalState.update("syncMode", "github");

			// Reload store data from GitHub cache
			await this.reloadStoreData("user");

			// Show security warning
			vscode.window.showWarningMessage(
				"Security Notice: Todos synced to GitHub are stored in plaintext. " +
					"Never store passwords, API keys, or sensitive information in synced todos."
			);

			// Start polling
			const pollInterval = config.get<number>("github.pollInterval", 180);
			this.syncManager.startPolling("user", pollInterval);

			// Notify visibility coordinator
			this.visibilityCoordinator?.updateSyncModes();

			vscode.window.showInformationMessage("GitHub sync enabled for user lists.");
		} else {
			// Switch to local or profile sync
			const newMode = selected.mode === GlobalSyncMode.Local ? "profile-local" : "profile-sync";
			await this.context.globalState.update("syncMode", newMode);

			// Reload store data from local storage
			await this.reloadStoreData("user");

			// Stop polling
			this.syncManager.stopPolling("user");

			// Notify visibility coordinator
			this.visibilityCoordinator?.updateSyncModes();

			vscode.window.showInformationMessage(`Switched to ${selected.label} mode for user lists.`);
		}
	}

	/**
	 * Command: Select Workspace Sync Mode
	 */
	private async selectWorkspaceSyncMode(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const currentMode = this.context.workspaceState.get<string>("syncMode", "local");

		const items = [
			{
				label: "$(archive) Local",
				description: "This workspace only",
				detail: currentMode === "local" ? "✓ Currently selected" : undefined,
				mode: WorkspaceSyncMode.Local,
			},
			{
				label: "$(github) GitHub Gist",
				description: "Syncs via manually-created gist",
				detail: currentMode === "github" ? "✓ Currently selected" : "[Requires gist ID configuration]",
				mode: WorkspaceSyncMode.GitHub,
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select sync mode for workspace lists",
		});

		if (!selected) {
			return;
		}

		if (selected.mode === WorkspaceSyncMode.GitHub) {
			// Ensure authenticated
			const isAuth = await this.authManager.ensureAuthenticated();
			if (!isAuth) {
				return;
			}

			// Ensure gist ID is configured
			const gistId = config.get<string>("github.gistId");
			if (!gistId) {
				const setup = await vscode.window.showInformationMessage(
					"Gist ID not configured. Would you like to set it now?",
					"Set Gist ID",
					"Cancel"
				);
				if (setup === "Set Gist ID") {
					await this.setGistId();
				}
				return;
			}

			// Enable GitHub sync for workspace via internal storage
			await this.context.workspaceState.update("syncMode", "github");

			// Reload store data from GitHub cache
			await this.reloadStoreData("workspace");

			// Start polling
			const pollInterval = config.get<number>("github.pollInterval", 180);
			this.syncManager.startPolling("workspace", pollInterval);

			// Notify visibility coordinator
			this.visibilityCoordinator?.updateSyncModes();

			vscode.window.showInformationMessage("GitHub sync enabled for workspace lists.");
		} else {
			// Switch to local
			await this.context.workspaceState.update("syncMode", "local");

			// Reload store data from local storage
			await this.reloadStoreData("workspace");

			// Stop polling
			this.syncManager.stopPolling("workspace");

			// Notify visibility coordinator
			this.visibilityCoordinator?.updateSyncModes();

			vscode.window.showInformationMessage("Switched to Local mode for workspace lists.");
		}
	}

	/**
	 * Command: Set User File
	 */
	private async setUserFile(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const syncMode = this.context.globalState.get<string>("syncMode", "profile-local");

		if (syncMode !== "github") {
			vscode.window.showErrorMessage("GitHub sync is not enabled. Enable it first using 'Select User Sync Mode'.");
			return;
		}

		const gistId = config.get<string>("github.gistId");
		if (!gistId) {
			vscode.window.showErrorMessage("Gist ID not configured.");
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Loading files from gist...",
				cancellable: false,
			},
			async () => {
				const filesResult = await this.apiClient.listFiles(gistId, "user");
				if (!filesResult.success || !filesResult.data) {
					vscode.window.showErrorMessage(`Failed to load files: ${filesResult.error?.message}`);
					return;
				}

				if (filesResult.data.length === 0) {
					// No files found - prompt to create new file
					const fileName = await vscode.window.showInputBox({
						prompt: "No user files found in gist. Enter a name for your new user list",
						placeHolder: "todos",
						validateInput: (value) => {
							if (!value || value.trim().length === 0) {
								return "File name cannot be empty";
							}
							if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
								return "File name can only contain letters, numbers, hyphens, and underscores";
							}
							return null;
						},
					});

					if (!fileName) {
						return;
					}

					const fullPath = `user-${fileName}.json`;
					await config.update("github.userFile", fullPath, vscode.ConfigurationTarget.Global);

					// Clear any workspace override that might exist
					await clearWorkspaceOverride("github.userFile");

					vscode.window.showInformationMessage(
						`User file set to: ${fileName}. Empty list created.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("user");

					// Reload store data from new file
					await this.reloadStoreData("user");
					return;
				}

				const currentFile = config.get<string>("github.userFile", "user-todos.json");
				const items: Array<
					| { label: string; description: string; isNew: true; file?: never }
					| { label: string; description?: string; isNew: false; file: typeof filesResult.data[number] }
				> = [
					{
						label: "$(add) Create New File",
						description: "Create a new user list file",
						isNew: true,
					},
					...filesResult.data.map((file) => ({
						label: `$(file) ${file.displayName}`,
						description: file.fullPath === currentFile ? "✓ Currently selected" : undefined,
						file,
						isNew: false as const,
					})),
				];

				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: "Select user list from gist or create new",
				});

				if (!selected) {
					return;
				}

				if (selected.isNew) {
					// Create new file
					const fileName = await vscode.window.showInputBox({
						prompt: "Enter a name for your new user list",
						placeHolder: "todos",
						validateInput: (value) => {
							if (!value || value.trim().length === 0) {
								return "File name cannot be empty";
							}
							if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
								return "File name can only contain letters, numbers, hyphens, and underscores";
							}
							// Check if file already exists
							const exists = filesResult.data?.some(f => f.displayName === value);
							if (exists) {
								return "A file with this name already exists";
							}
							return null;
						},
					});

					if (!fileName) {
						return;
					}

					const fullPath = `user-${fileName}.json`;
					await config.update("github.userFile", fullPath, vscode.ConfigurationTarget.Global);

					// Clear any workspace override that might exist
					await clearWorkspaceOverride("github.userFile");

					vscode.window.showInformationMessage(
						`User file set to: ${fileName}. Empty list created.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("user");

					// Reload store data from new file
					await this.reloadStoreData("user");
				} else {
					// Select existing file
					await config.update("github.userFile", selected.file.fullPath, vscode.ConfigurationTarget.Global);

					// Clear any workspace override that might exist
					await clearWorkspaceOverride("github.userFile");

					vscode.window.showInformationMessage(`User file set to: ${selected.file.displayName}`);

					// Trigger immediate sync
					await this.syncManager.sync("user");

					// Reload store data from new file
					await this.reloadStoreData("user");
				}
			}
		);
	}

	/**
	 * Command: Set Workspace File
	 */
	private async setWorkspaceFile(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const syncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (syncMode !== "github") {
			vscode.window.showErrorMessage(
				"GitHub sync is not enabled. Enable it first using 'Select Workspace Sync Mode'."
			);
			return;
		}

		const gistId = config.get<string>("github.gistId");
		if (!gistId) {
			vscode.window.showErrorMessage("Gist ID not configured.");
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Loading files from gist...",
				cancellable: false,
			},
			async () => {
				const filesResult = await this.apiClient.listFiles(gistId, "workspace");
				if (!filesResult.success || !filesResult.data) {
					vscode.window.showErrorMessage(`Failed to load files: ${filesResult.error?.message}`);
					return;
				}

				const workspaceName = vscode.workspace.name || "default";

				if (filesResult.data.length === 0) {
					// No files found - prompt to create new file with workspace name prefilled
					const fileName = await vscode.window.showInputBox({
						prompt: "No workspace files found in gist. Enter a name for your new workspace list",
						value: workspaceName, // Prefill with workspace name
						validateInput: (value) => {
							if (!value || value.trim().length === 0) {
								return "File name cannot be empty";
							}
							if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
								return "File name can only contain letters, numbers, hyphens, and underscores";
							}
							return null;
						},
					});

					if (!fileName) {
						return;
					}

					const fullPath = `workspace-${fileName}.json`;
					await config.update("github.workspaceFile", fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(
						`Workspace file set to: ${fileName}. Empty list created.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("workspace");

					// Reload store data from new file
					await this.reloadStoreData("workspace");
					return;
				}

				const currentFile = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
				const items: Array<
					| { label: string; description: string; isNew: true; file?: never }
					| { label: string; description?: string; isNew: false; file: typeof filesResult.data[number] }
				> = [
					{
						label: "$(add) Create New File",
						description: "Create a new workspace list file",
						isNew: true,
					},
					...filesResult.data.map((file) => ({
						label: `$(file) ${file.displayName}`,
						description: file.fullPath === currentFile ? "✓ Currently selected" : undefined,
						file,
						isNew: false as const,
					})),
				];

				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: "Select workspace list from gist or create new",
				});

				if (!selected) {
					return;
				}

				if (selected.isNew) {
					// Create new file with workspace name prefilled
					const fileName = await vscode.window.showInputBox({
						prompt: "Enter a name for your new workspace list",
						value: workspaceName, // Prefill with workspace name
						validateInput: (value) => {
							if (!value || value.trim().length === 0) {
								return "File name cannot be empty";
							}
							if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
								return "File name can only contain letters, numbers, hyphens, and underscores";
							}
							// Check if file already exists
							const exists = filesResult.data?.some(f => f.displayName === value);
							if (exists) {
								return "A file with this name already exists";
							}
							return null;
						},
					});

					if (!fileName) {
						return;
					}

					const fullPath = `workspace-${fileName}.json`;
					await config.update("github.workspaceFile", fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(
						`Workspace file set to: ${fileName}. Empty list created.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("workspace");

					// Reload store data from new file
					await this.reloadStoreData("workspace");
				} else {
					// Select existing file
					await config.update("github.workspaceFile", selected.file.fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(`Workspace file set to: ${selected.file.displayName}`);

					// Trigger immediate sync
					await this.syncManager.sync("workspace");

					// Reload store data from new file
					await this.reloadStoreData("workspace");
				}
			}
		);
	}

	/**
	 * Command: Sync Now
	 */
	private async syncNow(): Promise<void> {
		const userMode = this.context.globalState.get<string>("syncMode", "profile-local");
		const workspaceMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (userMode !== "github" && workspaceMode !== "github") {
			vscode.window.showInformationMessage("GitHub sync is not enabled for any scope.");
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Syncing with GitHub...",
				cancellable: false,
			},
			async () => {
				// Sync both scopes if enabled
				const userResult = userMode === "github"
					? await this.syncManager.sync("user")
					: { success: true };
				const workspaceResult = workspaceMode === "github"
					? await this.syncManager.sync("workspace")
					: { success: true };

				if (userResult.success && workspaceResult.success) {
					vscode.window.showInformationMessage("Synced successfully.");
				} else if (!userResult.success) {
					this.showSyncError("User", userResult.error);
				} else if (!workspaceResult.success) {
					this.showSyncError("Workspace", workspaceResult.error);
				}
			}
		);
	}

	/**
	 * Show sync error with helpful guidance
	 */
	private showSyncError(scope: string, error?: { type: SyncErrorType; message: string }): void {
		if (!error) {
			vscode.window.showErrorMessage(`${scope} sync failed: Unknown error`);
			return;
		}

		let message = `${scope} sync failed: ${error.message}`;
		let actions: string[] = [];

		switch (error.type) {
			case SyncErrorType.ValidationError:
				// Show the actual error message, not a generic one
				message = `${scope} sync failed: ${error.message}`;
				actions = ["View Gist", "Retry Sync"];
				break;
			case SyncErrorType.AuthError:
				message = `${scope} sync failed: Authentication error. Please reconnect GitHub.`;
				actions = ["Connect GitHub"];
				break;
			case SyncErrorType.NotFoundError:
				message = `${scope} sync failed: Gist not found. Please check your gist ID.`;
				actions = ["Set Gist ID"];
				break;
			case SyncErrorType.RateLimitError:
				message = `${scope} sync failed: GitHub rate limit exceeded. Please try again later.`;
				break;
			case SyncErrorType.NetworkError:
				message = `${scope} sync failed: Network error. Please check your connection.`;
				actions = ["Retry Sync"];
				break;
			default:
				actions = ["Retry Sync", "View Gist"];
		}

		if (actions.length > 0) {
			vscode.window.showErrorMessage(message, ...actions).then(async (action) => {
				switch (action) {
					case "Connect GitHub":
						await this.connectGitHub();
						break;
					case "Set Gist ID":
						await this.setGistId();
						break;
					case "View Gist":
						await this.viewGistOnGitHub();
						break;
					case "Retry Sync":
						await this.syncNow();
						break;
				}
			});
		} else {
			vscode.window.showErrorMessage(message);
		}
	}
}
