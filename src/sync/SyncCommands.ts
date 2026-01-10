/**
 * Sync Commands
 * VS Code commands for GitHub Gist sync features
 */

import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { GitHubAuthManager } from "./GitHubAuthManager";
import { GitHubApiClient } from "./GitHubApiClient";
import { SyncManager } from "./SyncManager";
import {
	DefaultFileNames,
	GlobalGistData,
	GistSummary,
	WorkspaceGistData,
	SyncErrorType,
} from "./syncTypes";
import { StoreState, TodoScope } from "../todo/todoTypes";
import { userActions, workspaceActions, editorFocusAndRecordsActions, currentFileActions } from "../todo/store";
import StorageSyncManager from "../storage/StorageSyncManager";
import { getWorkspaceFilesWithRecords } from "../todo/todoUtils";
import { reloadScopeData, clearWorkspaceOverride, notifyGitHubStatusChange, notifyGitHubSyncInfo } from "../utilities/syncUtils";
import { getGistId } from "../utilities/syncConfig";
import { WebviewVisibilityCoordinator } from "./WebviewVisibilityCoordinator";

type UserSyncModeValue = "profile-local" | "profile-sync" | "github";
type WorkspaceSyncModeValue = "local" | "github";

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
			vscode.commands.registerCommand("vsc-todo.viewGistOnGitHub", () => this.viewGistOnGitHub()),
			vscode.commands.registerCommand("vsc-todo.selectUserSyncMode", (mode?: UserSyncModeValue) =>
				this.selectUserSyncMode(mode)
			),
			vscode.commands.registerCommand(
				"vsc-todo.selectWorkspaceSyncMode",
				(mode?: WorkspaceSyncModeValue) => this.selectWorkspaceSyncMode(mode)
			),
			vscode.commands.registerCommand("vsc-todo.setupGistId", () => this.setupGistId()),
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
			notifyGitHubSyncInfo(this.context);
		}
	}

	/**
	 * Open settings for gist ID configuration
	 */
	private async openGistIdSettings(): Promise<void> {
		await vscode.commands.executeCommand("workbench.action.openSettings", "vscodeTodo.sync.github.gistId");
	}

	/**
	 * Command: Set Gist ID (guided setup)
	 */
	private async setupGistId(): Promise<void> {
		const isAuth = await this.authManager.ensureAuthenticated();
		if (!isAuth) {
			return;
		}
		await this.ensureGistIdConfigured("any", { forcePrompt: true });
	}

	/**
	 * Ensure gist ID is configured, with guided setup if needed
	 */
	private async ensureGistIdConfigured(
		scope: "user" | "workspace" | "any",
		options?: { forcePrompt?: boolean }
	): Promise<string | undefined> {
		const existing = getGistId();
		if (existing && !options?.forcePrompt) {
			return existing;
		}

		type SetupChoice = {
			label: string;
			description: string;
			value: "create" | "existing" | "settings";
		};

		const items: SetupChoice[] = [
			{
				label: "$(add) Create new secret gist (recommended)",
				description: "Creates a private gist with empty Todo files",
				value: "create",
			},
		];

		items.push(
			{
				label: "$(list-selection) Use existing gist...",
				description: "Pick from your GitHub account",
				value: "existing",
			},
			{
				label: "$(settings) Open Settings...",
				description: "Paste or edit a gist ID manually",
				value: "settings",
			}
		);

		const choice = await vscode.window.showQuickPick<SetupChoice>(items, {
			placeHolder: "Set up GitHub Gist sync",
		});

		if (!choice) {
			return;
		}

		if (choice.value === "settings") {
			await this.openGistIdSettings();
			return;
		}

		const isAuthenticated = await this.authManager.isAuthenticated();
		const isAuth = isAuthenticated || (await this.authManager.ensureAuthenticated());
		if (!isAuth) {
			return;
		}

		if (choice.value === "existing") {
			const selectedGist = await this.pickExistingGist();
			if (!selectedGist) {
				return;
			}
			await this.updateGistId(selectedGist.id);
			await this.showGistSelectedMessage(selectedGist);
			return selectedGist.id;
		}

		const createdGistId = await this.createGistForSync();
		if (!createdGistId) {
			return;
		}
		await this.updateGistId(createdGistId);
		await this.showGistCreatedMessage(createdGistId);
		return createdGistId;
	}

	private async updateGistId(gistId: string): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		await config.update("github.gistId", gistId.trim(), vscode.ConfigurationTarget.Global);
		notifyGitHubStatusChange(true);
	}

	private async createGistForSync(): Promise<string | undefined> {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Creating GitHub gist...",
				cancellable: false,
			},
			async () => {
				const files = this.buildSeedFiles();
				const result = await this.apiClient.createGist("VS Code Todo Sync", files, false);

				if (!result.success || !result.data) {
					vscode.window.showErrorMessage(
						`Failed to create gist: ${result.error?.message ?? "Unknown error"}`
					);
					return;
				}

				return result.data.id;
			}
		);
	}

	private buildSeedFiles(): Record<string, string> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const userFileName = config.get<string>("github.userFile", DefaultFileNames.user);
		const workspaceName = vscode.workspace.name || "default";
		const workspaceFileName =
			config.get<string>("github.workspaceFile") || DefaultFileNames.workspace(workspaceName);
		const userData: GlobalGistData = {
			userTodos: [],
		};
		const workspaceData: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: {},
		};

		return {
			[userFileName]: JSON.stringify(userData, null, 2),
			[workspaceFileName]: JSON.stringify(workspaceData, null, 2),
		};
	}

	private async pickExistingGist(): Promise<GistSummary | undefined> {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Loading GitHub gists...",
				cancellable: false,
			},
			async () => {
				const listResult = await this.apiClient.listGists();
				if (!listResult.success || !listResult.data) {
					vscode.window.showErrorMessage(
						`Failed to load gists: ${listResult.error?.message ?? "Unknown error"}`
					);
					return;
				}

				if (listResult.data.length === 0) {
					vscode.window.showInformationMessage("No gists found in your GitHub account.");
					return;
				}

				const sorted = [...listResult.data].sort((a, b) => {
					return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
				});

				const items = sorted.map((gist) => {
					const description = gist.description?.trim()
						? gist.description.trim()
						: `Gist ${gist.id}`;
					const visibility = gist.isPublic ? "Public" : "Secret";
					const filesLabel = gist.filesCount === 1 ? "1 file" : `${gist.filesCount} files`;
					const updatedAt = this.formatGistDate(gist.updatedAt);
					return {
						label: description,
						description: `${visibility} | ${filesLabel}`,
						detail: `ID: ${gist.id} | Updated ${updatedAt}`,
						gist,
					};
				});

				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: "Select a gist to use for VS Code Todo",
				});

				return selected?.gist;
			}
		);
	}

	private formatGistDate(timestamp: string): string {
		const parsed = Date.parse(timestamp);
		if (Number.isNaN(parsed)) {
			return "unknown";
		}
		return new Date(parsed).toISOString().slice(0, 10);
	}

	private async showGistCreatedMessage(gistId: string): Promise<void> {
		const action = await vscode.window.showInformationMessage(
			"Created a new secret gist for VS Code Todo. You can change it in Settings.",
			"View Gist",
			"Open Settings"
		);

		if (action === "View Gist") {
			const url = this.apiClient.getGistUrl(gistId);
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} else if (action === "Open Settings") {
			await this.openGistIdSettings();
		}
	}

	private async showGistSelectedMessage(gist: GistSummary): Promise<void> {
		const label = gist.description?.trim() ? gist.description.trim() : gist.id;
		const action = await vscode.window.showInformationMessage(
			`Using gist "${label}" for VS Code Todo. You can change it in Settings.`,
			"View Gist",
			"Open Settings"
		);

		if (action === "View Gist") {
			const url = this.apiClient.getGistUrl(gist.id);
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} else if (action === "Open Settings") {
			await this.openGistIdSettings();
		}
	}

	/**
	 * Command: View Gist on GitHub
	 */
	private async viewGistOnGitHub(): Promise<void> {
		const gistId = getGistId();

		if (!gistId) {
			const action = await vscode.window.showErrorMessage(
				"Gist ID not configured. Set 'vscodeTodo.sync.github.gistId' in Settings.",
				"Open Settings"
			);
			if (action === "Open Settings") {
				await this.openGistIdSettings();
			}
			return;
		}

		const url = this.apiClient.getGistUrl(gistId);
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	private isUserSyncModeValue(value: unknown): value is UserSyncModeValue {
		return value === "profile-local" || value === "profile-sync" || value === "github";
	}

	private isWorkspaceSyncModeValue(value: unknown): value is WorkspaceSyncModeValue {
		return value === "local" || value === "github";
	}

	private getUserSyncModeLabel(mode: UserSyncModeValue): string {
		switch (mode) {
			case "profile-local":
				return "Local";
			case "profile-sync":
				return "Profile Sync";
			case "github":
				return "GitHub Gist";
			default:
				return "Local";
		}
	}

	private getWorkspaceSyncModeLabel(mode: WorkspaceSyncModeValue): string {
		return mode === "github" ? "GitHub Gist" : "Local";
	}

	private async applyUserSyncMode(mode: UserSyncModeValue): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");

		if (mode === "github") {
			// Ensure authenticated
			const isAuth = await this.authManager.ensureAuthenticated();
			if (!isAuth) {
				return;
			}

			// Ensure gist ID is configured
			const gistId = await this.ensureGistIdConfigured("user");
			if (!gistId) {
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
			notifyGitHubSyncInfo(this.context);

			vscode.window.showInformationMessage("GitHub sync enabled for user lists.");
			return;
		}

		// Switch to local or profile sync
		await this.context.globalState.update("syncMode", mode);

		// Reload store data from local storage
		await this.reloadStoreData("user");

		// Stop polling
		this.syncManager.stopPolling("user");

		// Notify visibility coordinator
		this.visibilityCoordinator?.updateSyncModes();
		notifyGitHubSyncInfo(this.context);

		const label = this.getUserSyncModeLabel(mode);
		vscode.window.showInformationMessage(`Switched to ${label} mode for user lists.`);
	}

	private async applyWorkspaceSyncMode(mode: WorkspaceSyncModeValue): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");

		if (mode === "github") {
			// Ensure authenticated
			const isAuth = await this.authManager.ensureAuthenticated();
			if (!isAuth) {
				return;
			}

			// Ensure gist ID is configured
			const gistId = await this.ensureGistIdConfigured("workspace");
			if (!gistId) {
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
			notifyGitHubSyncInfo(this.context);

			vscode.window.showInformationMessage("GitHub sync enabled for workspace lists.");
			return;
		}

		// Switch to local
		await this.context.workspaceState.update("syncMode", "local");

		// Reload store data from local storage
		await this.reloadStoreData("workspace");

		// Stop polling
		this.syncManager.stopPolling("workspace");

		// Notify visibility coordinator
		this.visibilityCoordinator?.updateSyncModes();
		notifyGitHubSyncInfo(this.context);

		const label = this.getWorkspaceSyncModeLabel(mode);
		vscode.window.showInformationMessage(`Switched to ${label} mode for workspace lists.`);
	}

	/**
	 * Command: Select User Sync Mode
	 */
	private async selectUserSyncMode(mode?: UserSyncModeValue): Promise<void> {
		if (this.isUserSyncModeValue(mode)) {
			await this.applyUserSyncMode(mode);
			return;
		}

		const currentMode = this.context.globalState.get<UserSyncModeValue>("syncMode", "profile-local");

		const items = [
			{
				label: "$(archive) Local",
				description: "This device only",
				detail: currentMode === "profile-local" ? "Currently selected" : undefined,
				mode: "profile-local" as UserSyncModeValue,
			},
			{
				label: "$(sync) Profile Sync",
				description: "Syncs via VS Code Settings Sync",
				detail: currentMode === "profile-sync" ? "Currently selected" : undefined,
				mode: "profile-sync" as UserSyncModeValue,
			},
			{
				label: "$(github) GitHub Gist",
				description: "Syncs via GitHub Gist",
				detail: currentMode === "github" ? "Currently selected" : "Requires gist ID configuration",
				mode: "github" as UserSyncModeValue,
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select sync mode for user lists",
		});

		if (!selected) {
			return;
		}

		await this.applyUserSyncMode(selected.mode);
	}

	/**
	 * Command: Select Workspace Sync Mode
	 */
	private async selectWorkspaceSyncMode(mode?: WorkspaceSyncModeValue): Promise<void> {
		if (this.isWorkspaceSyncModeValue(mode)) {
			await this.applyWorkspaceSyncMode(mode);
			return;
		}

		const currentMode = this.context.workspaceState.get<WorkspaceSyncModeValue>("syncMode", "local");

		const items = [
			{
				label: "$(archive) Local",
				description: "This workspace only",
				detail: currentMode === "local" ? "Currently selected" : undefined,
				mode: "local" as WorkspaceSyncModeValue,
			},
			{
				label: "$(github) GitHub Gist",
				description: "Syncs via GitHub Gist",
				detail: currentMode === "github" ? "Currently selected" : "Requires gist ID configuration",
				mode: "github" as WorkspaceSyncModeValue,
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select sync mode for workspace lists",
		});

		if (!selected) {
			return;
		}

		await this.applyWorkspaceSyncMode(selected.mode);
	}/**
	 * Command: Change User List (GitHub Gist)
	 */
	private async setUserFile(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const syncMode = this.context.globalState.get<string>("syncMode", "profile-local");

		if (syncMode !== "github") {
			vscode.window.showErrorMessage("GitHub sync is not enabled. Enable it first using 'User: Sync Mode...'.");
			return;
		}

		const gistId = getGistId();
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
					notifyGitHubSyncInfo(this.context);
					return;
				}

				const currentFile = config.get<string>("github.userFile", "user-todos.json");
				type CreateItem = vscode.QuickPickItem & { isNew: true };
				type ExistingItem = vscode.QuickPickItem & {
					isNew: false;
					file: typeof filesResult.data[number];
				};
				type SeparatorItem = vscode.QuickPickItem & {
					kind: vscode.QuickPickItemKind.Separator;
				};
				type FilePickItem = CreateItem | ExistingItem | SeparatorItem;

				const sortedFiles = [...filesResult.data].sort((a, b) =>
					a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
				);
				const listItems: ExistingItem[] = sortedFiles.map((file) => {
					const isCurrent = file.fullPath === currentFile;
					return {
						label: isCurrent
							? `$(check) $(file) ${file.displayName}`
							: `$(file) ${file.displayName}`,
						description: isCurrent ? `Gist file: ${file.fullPath}` : undefined,
						file,
						isNew: false as const,
					};
				});

				const items: FilePickItem[] = [
					{ label: "Actions", kind: vscode.QuickPickItemKind.Separator },
					{
						label: "$(add) Create new user list...",
						description: "Creates a new list in your GitHub Gist",
						isNew: true,
					},
					{ label: "GitHub Gist lists", kind: vscode.QuickPickItemKind.Separator },
					...listItems,
				];

				const selected = await vscode.window.showQuickPick(items, {
					title: "User lists (GitHub Gist)",
					placeHolder: "Select a user list to sync",
				});

				if (!selected || selected.kind === vscode.QuickPickItemKind.Separator) {
					return;
				}

				if ("isNew" in selected && selected.isNew) {
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
					notifyGitHubSyncInfo(this.context);
				} else if ("file" in selected) {
					// Select existing file
					await config.update("github.userFile", selected.file.fullPath, vscode.ConfigurationTarget.Global);

					// Clear any workspace override that might exist
					await clearWorkspaceOverride("github.userFile");

					vscode.window.showInformationMessage(`User file set to: ${selected.file.displayName}`);

					// Trigger immediate sync
					await this.syncManager.sync("user");

					// Reload store data from new file
					await this.reloadStoreData("user");
					notifyGitHubSyncInfo(this.context);
				}
			}
		);
	}

	/**
	 * Command: Change Workspace List (GitHub Gist)
	 */
	private async setWorkspaceFile(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const syncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (syncMode !== "github") {
			vscode.window.showErrorMessage(
				"GitHub sync is not enabled. Enable it first using 'Workspace: Sync Mode...'."
			);
			return;
		}

		const gistId = getGistId();
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
					notifyGitHubSyncInfo(this.context);
					return;
				}

				const currentFile = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
				type CreateItem = vscode.QuickPickItem & { isNew: true };
				type ExistingItem = vscode.QuickPickItem & {
					isNew: false;
					file: typeof filesResult.data[number];
				};
				type SeparatorItem = vscode.QuickPickItem & {
					kind: vscode.QuickPickItemKind.Separator;
				};
				type FilePickItem = CreateItem | ExistingItem | SeparatorItem;

				const sortedFiles = [...filesResult.data].sort((a, b) =>
					a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
				);
				const listItems: ExistingItem[] = sortedFiles.map((file) => {
					const isCurrent = file.fullPath === currentFile;
					return {
						label: isCurrent
							? `$(check) $(file) ${file.displayName}`
							: `$(file) ${file.displayName}`,
						description: isCurrent ? `Gist file: ${file.fullPath}` : undefined,
						file,
						isNew: false as const,
					};
				});

				const items: FilePickItem[] = [
					{ label: "Actions", kind: vscode.QuickPickItemKind.Separator },
					{
						label: "$(add) Create new workspace list...",
						description: "Creates a new workspace list in your GitHub Gist",
						isNew: true,
					},
					{ label: "GitHub Gist lists", kind: vscode.QuickPickItemKind.Separator },
					...listItems,
				];

				const selected = await vscode.window.showQuickPick(items, {
					title: "Workspace lists (GitHub Gist)",
					placeHolder: "Select a workspace list to sync",
				});

				if (!selected || selected.kind === vscode.QuickPickItemKind.Separator) {
					return;
				}

				if ("isNew" in selected && selected.isNew) {
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
					notifyGitHubSyncInfo(this.context);
				} else if ("file" in selected) {
					// Select existing file
					await config.update("github.workspaceFile", selected.file.fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(`Workspace file set to: ${selected.file.displayName}`);

					// Trigger immediate sync
					await this.syncManager.sync("workspace");

					// Reload store data from new file
					await this.reloadStoreData("workspace");
					notifyGitHubSyncInfo(this.context);
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
			const action = await vscode.window.showInformationMessage(
				"GitHub Gist sync is not enabled for any scope. Enable it via 'User: Sync Mode...' or 'Workspace: Sync Mode...'.",
				"User: Sync Mode...",
				"Workspace: Sync Mode..."
			);
			if (action === "User: Sync Mode...") {
				await this.selectUserSyncMode();
			} else if (action === "Workspace: Sync Mode...") {
				await this.selectWorkspaceSyncMode();
			}
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
				actions = ["Open Settings"];
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
					case "Open Settings":
						await this.openGistIdSettings();
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



