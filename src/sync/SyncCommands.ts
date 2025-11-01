/**
 * Sync Commands
 * VS Code commands for GitHub Gist sync features
 */

import * as vscode from "vscode";
import { GitHubAuthManager } from "./GitHubAuthManager";
import { GitHubApiClient } from "./GitHubApiClient";
import { SyncManager } from "./SyncManager";
import { GlobalSyncMode, WorkspaceSyncMode, GIST_ID_REGEX, SyncErrorType } from "./syncTypes";

export class SyncCommands {
	private authManager: GitHubAuthManager;
	private apiClient: GitHubApiClient;
	private syncManager: SyncManager;
	private context: vscode.ExtensionContext;

	constructor(
		context: vscode.ExtensionContext,
		authManager: GitHubAuthManager,
		apiClient: GitHubApiClient,
		syncManager: SyncManager
	) {
		this.context = context;
		this.authManager = authManager;
		this.apiClient = apiClient;
		this.syncManager = syncManager;
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
			vscode.commands.registerCommand("vsc-todo.selectGlobalSyncMode", () => this.selectGlobalSyncMode()),
			vscode.commands.registerCommand("vsc-todo.selectWorkspaceSyncMode", () => this.selectWorkspaceSyncMode()),
			vscode.commands.registerCommand("vsc-todo.setGlobalFile", () => this.setGlobalFile()),
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
				await this.authManager.connect();
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

			// Revert sync modes to local
			const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
			await config.update("githubEnabled", false, vscode.ConfigurationTarget.Global);

			// Stop polling
			this.syncManager.stopPolling("global");
			this.syncManager.stopPolling("workspace");
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
				await config.update("gistId", gistId, scope.target);

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
		const gistId = config.get<string>("gistId");

		if (!gistId) {
			vscode.window.showErrorMessage("Gist ID not configured. Use 'Set Gist ID' command first.");
			return;
		}

		const url = this.apiClient.getGistUrl(gistId);
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	/**
	 * Command: Select Global Sync Mode
	 */
	private async selectGlobalSyncMode(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const currentMode = config.get<string>("user", "profile-local");
		const githubEnabled = config.get<boolean>("githubEnabled", false);

		const items = [
			{
				label: "$(archive) Local",
				description: "This device only",
				detail: currentMode === "profile-local" && !githubEnabled ? "✓ Currently selected" : undefined,
				mode: GlobalSyncMode.Local,
			},
			{
				label: "$(sync) Profile Sync",
				description: "Syncs via VS Code Settings Sync",
				detail: currentMode === "profile-sync" && !githubEnabled ? "✓ Currently selected" : undefined,
				mode: GlobalSyncMode.ProfileSync,
			},
			{
				label: "$(github) GitHub Gist",
				description: "Syncs via manually-created gist",
				detail: githubEnabled ? "✓ Currently selected" : "[Requires gist ID configuration]",
				mode: GlobalSyncMode.GitHub,
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select sync mode for global lists",
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
			const gistId = config.get<string>("gistId");
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

			// Enable GitHub sync
			await config.update("githubEnabled", true, vscode.ConfigurationTarget.Global);

			// Show security warning
			vscode.window.showWarningMessage(
				"Security Notice: Todos synced to GitHub are stored in plaintext. " +
					"Never store passwords, API keys, or sensitive information in synced todos."
			);

			// Start polling
			const pollInterval = config.get<number>("pollInterval", 180);
			this.syncManager.startPolling("global", pollInterval);

			vscode.window.showInformationMessage("GitHub sync enabled for global lists.");
		} else {
			// Switch to local or profile sync
			await config.update("githubEnabled", false, vscode.ConfigurationTarget.Global);
			await config.update("user", selected.mode === GlobalSyncMode.Local ? "profile-local" : "profile-sync");

			// Stop polling
			this.syncManager.stopPolling("global");

			vscode.window.showInformationMessage(`Switched to ${selected.label} mode for global lists.`);
		}
	}

	/**
	 * Command: Select Workspace Sync Mode
	 */
	private async selectWorkspaceSyncMode(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const githubEnabled = config.get<boolean>("githubEnabled", false);

		const items = [
			{
				label: "$(archive) Local",
				description: "This workspace only",
				detail: !githubEnabled ? "✓ Currently selected" : undefined,
				mode: WorkspaceSyncMode.Local,
			},
			{
				label: "$(github) GitHub Gist",
				description: "Syncs via manually-created gist",
				detail: githubEnabled ? "✓ Currently selected" : "[Requires gist ID configuration]",
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
			const gistId = config.get<string>("gistId");
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

			// Enable GitHub sync for workspace
			await config.update("githubEnabled", true, vscode.ConfigurationTarget.Workspace);

			// Start polling
			const pollInterval = config.get<number>("pollInterval", 180);
			this.syncManager.startPolling("workspace", pollInterval);

			vscode.window.showInformationMessage("GitHub sync enabled for workspace lists.");
		} else {
			// Switch to local
			await config.update("githubEnabled", false, vscode.ConfigurationTarget.Workspace);

			// Stop polling
			this.syncManager.stopPolling("workspace");

			vscode.window.showInformationMessage("Switched to Local mode for workspace lists.");
		}
	}

	/**
	 * Command: Set Global File
	 */
	private async setGlobalFile(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const githubEnabled = config.get<boolean>("githubEnabled", false);

		if (!githubEnabled) {
			vscode.window.showErrorMessage("GitHub sync is not enabled. Enable it first using 'Select Global Sync Mode'.");
			return;
		}

		const gistId = config.get<string>("gistId");
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
				const filesResult = await this.apiClient.listFiles(gistId, "global");
				if (!filesResult.success || !filesResult.data) {
					vscode.window.showErrorMessage(`Failed to load files: ${filesResult.error?.message}`);
					return;
				}

				if (filesResult.data.length === 0) {
					// No files found - prompt to create new file
					const fileName = await vscode.window.showInputBox({
						prompt: "No global files found in gist. Enter a name for your new global list",
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

					const fullPath = `global-${fileName}.json`;
					await config.update("globalFile", fullPath, vscode.ConfigurationTarget.Global);
					vscode.window.showInformationMessage(
						`Global file set to: ${fileName}. It will be created on first sync.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("global");
					return;
				}

				const currentFile = config.get<string>("globalFile", "global-todos.json");
				const items: Array<
					| { label: string; description: string; isNew: true; file?: never }
					| { label: string; description?: string; isNew: false; file: typeof filesResult.data[number] }
				> = [
					{
						label: "$(add) Create New File",
						description: "Create a new global list file",
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
					placeHolder: "Select global list from gist or create new",
				});

				if (!selected) {
					return;
				}

				if (selected.isNew) {
					// Create new file
					const fileName = await vscode.window.showInputBox({
						prompt: "Enter a name for your new global list",
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

					const fullPath = `global-${fileName}.json`;
					await config.update("globalFile", fullPath, vscode.ConfigurationTarget.Global);
					vscode.window.showInformationMessage(
						`Global file set to: ${fileName}. It will be created on first sync.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("global");
				} else {
					// Select existing file
					await config.update("globalFile", selected.file.fullPath, vscode.ConfigurationTarget.Global);
					vscode.window.showInformationMessage(`Global file set to: ${selected.file.displayName}`);

					// Trigger immediate sync
					await this.syncManager.sync("global");
				}
			}
		);
	}

	/**
	 * Command: Set Workspace File
	 */
	private async setWorkspaceFile(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const githubEnabled = config.get<boolean>("githubEnabled", false);

		if (!githubEnabled) {
			vscode.window.showErrorMessage(
				"GitHub sync is not enabled. Enable it first using 'Select Workspace Sync Mode'."
			);
			return;
		}

		const gistId = config.get<string>("gistId");
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
					await config.update("workspaceFile", fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(
						`Workspace file set to: ${fileName}. It will be created on first sync.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("workspace");
					return;
				}

				const currentFile = config.get<string>("workspaceFile") || `workspace-${workspaceName}.json`;
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
					await config.update("workspaceFile", fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(
						`Workspace file set to: ${fileName}. It will be created on first sync.`
					);

					// Trigger immediate sync to create the file
					await this.syncManager.sync("workspace");
				} else {
					// Select existing file
					await config.update("workspaceFile", selected.file.fullPath, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage(`Workspace file set to: ${selected.file.displayName}`);

					// Trigger immediate sync
					await this.syncManager.sync("workspace");
				}
			}
		);
	}

	/**
	 * Command: Sync Now
	 */
	private async syncNow(): Promise<void> {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const githubEnabled = config.get<boolean>("githubEnabled", false);

		if (!githubEnabled) {
			vscode.window.showInformationMessage("GitHub sync is not enabled.");
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Syncing with GitHub...",
				cancellable: false,
			},
			async () => {
				// Sync both scopes
				const globalResult = await this.syncManager.sync("global");
				const workspaceResult = await this.syncManager.sync("workspace");

				if (globalResult.success && workspaceResult.success) {
					vscode.window.showInformationMessage("Synced successfully.");
				} else if (!globalResult.success) {
					this.showSyncError("Global", globalResult.error);
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
