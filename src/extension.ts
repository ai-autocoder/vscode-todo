import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import StorageSyncManager from "./storage/StorageSyncManager";
import { tabChangeHandler } from "./editorHandler";
import { HelloWorldPanel } from "./panels/HelloWorldPanel";
import { initStatusBarItem, updateStatusBarItem, updateSyncStatus } from "./statusBarItem";
import { exportCommand } from "./todo/exporter";
import { ExportFormats } from "./todo/todoTypes";
import { importCommand } from "./todo/importer";
import { ImportFormats } from "./todo/todoTypes";
import { TodoViewProvider } from "./panels/TodoViewProvider";
import { getConfig } from "./utilities/config";
import createStore, {
	actionTrackerActions,
	currentFileActions,
	editorFocusAndRecordsActions,
	userActions,
	workspaceActions,
} from "./todo/store";
import {
	CurrentFileSlice,
	Slices,
	StoreState,
	TodoFilesData,
	TodoScope,
	TodoSlice,
} from "./todo/todoTypes";
import {
	deleteCompletedTodos,
	deleteCompletedTodosCurrentFile,
	getWorkspaceFilesWithRecords,
	removeDataForDeletedFile,
	updateDataForRenamedFile,
} from "./todo/todoUtils";
import { GitHubAuthManager, GitHubApiClient, SyncManager, SyncCommands } from "./sync";

const GLOBAL_STATE_SYNC_KEYS: readonly string[] = ["TodoData"];

/**
 * Migrate old sync settings to new internal storage structure
 */
async function migrateSyncSettings(context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
	let hasChanges = false;

	// === Migrate User/Global Sync Mode ===
	const oldGithubEnabledGlobal = config.inspect<boolean>("githubEnabled")?.globalValue;
	const oldUserMode = config.inspect<string>("user")?.globalValue;

	if (oldGithubEnabledGlobal !== undefined || oldUserMode !== undefined) {
		const newMode = oldGithubEnabledGlobal ? "github" : (oldUserMode || "profile-local");
		await context.globalState.update("syncMode", newMode);

		// Remove old settings
		if (oldGithubEnabledGlobal !== undefined) {
			await config.update("githubEnabled", undefined, vscode.ConfigurationTarget.Global);
		}
		if (oldUserMode !== undefined) {
			await config.update("user", undefined, vscode.ConfigurationTarget.Global);
		}
		hasChanges = true;
	}

	// === Migrate Workspace Sync Mode ===
	const oldGithubEnabledWorkspace = config.inspect<boolean>("githubEnabled")?.workspaceValue;
	if (oldGithubEnabledWorkspace !== undefined) {
		const newMode = oldGithubEnabledWorkspace ? "github" : "local";
		await context.workspaceState.update("syncMode", newMode);

		await config.update("githubEnabled", undefined, vscode.ConfigurationTarget.Workspace);
		hasChanges = true;
	}

	// === Migrate Renamed Settings ===

	// Migrate gistId → github.gistId
	const oldGistIdGlobal = config.inspect<string>("gistId")?.globalValue;
	const oldGistIdWorkspace = config.inspect<string>("gistId")?.workspaceValue;

	if (oldGistIdGlobal !== undefined) {
		await config.update("github.gistId", oldGistIdGlobal, vscode.ConfigurationTarget.Global);
		await config.update("gistId", undefined, vscode.ConfigurationTarget.Global);
		hasChanges = true;
	}
	if (oldGistIdWorkspace !== undefined) {
		await config.update("github.gistId", oldGistIdWorkspace, vscode.ConfigurationTarget.Workspace);
		await config.update("gistId", undefined, vscode.ConfigurationTarget.Workspace);
		hasChanges = true;
	}

	// Migrate globalFile → github.userFile (and rename global- to user-)
	const oldGlobalFile = config.inspect<string>("globalFile")?.globalValue;
	if (oldGlobalFile !== undefined) {
		let newUserFile = oldGlobalFile;
		if (oldGlobalFile.startsWith("global-")) {
			newUserFile = oldGlobalFile.replace("global-", "user-");
		} else if (oldGlobalFile.startsWith("global/")) {
			newUserFile = oldGlobalFile.replace("global/", "user-");
		}

		await config.update("github.userFile", newUserFile, vscode.ConfigurationTarget.Global);
		await config.update("globalFile", undefined, vscode.ConfigurationTarget.Global);
		hasChanges = true;
	}

	// Migrate workspaceFile → github.workspaceFile
	const oldWorkspaceFileGlobal = config.inspect<string>("workspaceFile")?.globalValue;
	const oldWorkspaceFileWorkspace = config.inspect<string>("workspaceFile")?.workspaceValue;

	if (oldWorkspaceFileGlobal !== undefined) {
		await config.update("github.workspaceFile", oldWorkspaceFileGlobal, vscode.ConfigurationTarget.Global);
		await config.update("workspaceFile", undefined, vscode.ConfigurationTarget.Global);
		hasChanges = true;
	}
	if (oldWorkspaceFileWorkspace !== undefined) {
		await config.update("github.workspaceFile", oldWorkspaceFileWorkspace, vscode.ConfigurationTarget.Workspace);
		await config.update("workspaceFile", undefined, vscode.ConfigurationTarget.Workspace);
		hasChanges = true;
	}

	// Migrate pollInterval → github.pollInterval
	const oldPollInterval = config.inspect<number>("pollInterval")?.globalValue;
	if (oldPollInterval !== undefined) {
		await config.update("github.pollInterval", oldPollInterval, vscode.ConfigurationTarget.Global);
		await config.update("pollInterval", undefined, vscode.ConfigurationTarget.Global);
		hasChanges = true;
	}

	// Show one-time message if any migrations occurred
	if (hasChanges) {
		vscode.window.showInformationMessage(
			"VS Code Todo: Sync settings have been updated for improved clarity. GitHub sync configuration has been reorganized."
		);
	}
}

export async function activate(context: ExtensionContext) {
	const store = createStore();
	const storageSyncManager = new StorageSyncManager(context, store);
	await storageSyncManager.initialize();

	// Migrate old sync settings to new structure
	await migrateSyncSettings(context);

	// Initialize GitHub sync modules
	const authManager = GitHubAuthManager.getInstance(context);
	const apiClient = new GitHubApiClient(context);
	const syncManager = new SyncManager(context);
	const syncCommands = new SyncCommands(context, authManager, apiClient, syncManager);

	// Start GitHub sync polling if enabled
	// Start polling if GitHub sync is enabled
	const userSyncMode = context.globalState.get<string>("syncMode", "profile-local");
	const workspaceSyncMode = context.workspaceState.get<string>("syncMode", "local");
	const syncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");

	if (userSyncMode === "github" || workspaceSyncMode === "github") {
		const pollInterval = syncConfig.get<number>("github.pollInterval", 180);
		if (userSyncMode === "github") {
			syncManager.startPolling("user", pollInterval);
		}
		if (workspaceSyncMode === "github") {
			syncManager.startPolling("workspace", pollInterval);
		}
	}

	// Listen for sync status changes and update status bar
	const syncStatusListener = syncManager.onStatusChange((event) => {
		updateSyncStatus(event.scope, event.status);
		updateStatusBarItem(store.getState());
	});
	context.subscriptions.push(syncStatusListener);

	if (typeof context.globalState.setKeysForSync === "function") {
		// Enable VS Code Settings Sync for TodoData if using profile-sync mode
		const currentSyncMode = context.globalState.get<string>("syncMode", "profile-local");
		context.globalState.setKeysForSync(
			currentSyncMode === "profile-sync" ? GLOBAL_STATE_SYNC_KEYS : []
		);
		const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			// Handle GitHub sync poll interval changes
			if (e.affectsConfiguration("vscodeTodo.sync.github.pollInterval")) {
				const updatedSyncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");
				const updatedPollInterval = updatedSyncConfig.get<number>("github.pollInterval", 180);

				const currentUserMode = context.globalState.get<string>("syncMode", "profile-local");
				const currentWorkspaceMode = context.workspaceState.get<string>("syncMode", "local");

				if (currentUserMode === "github") {
					syncManager.startPolling("user", updatedPollInterval);
				}
				if (currentWorkspaceMode === "github") {
					syncManager.startPolling("workspace", updatedPollInterval);
				}
			}
		});
		context.subscriptions.push(configListener);
	}

	const commands = [
		vscode.commands.registerCommand("vsc-todo.openTodo", () =>
			HelloWorldPanel.render(context, store)
		),
		vscode.commands.registerCommand("vsc-todo.exportDataToJSON", () =>
			exportCommand(context, ExportFormats.JSON, store)
		),
		vscode.commands.registerCommand("vsc-todo.exportDataToMarkdown", () =>
			exportCommand(context, ExportFormats.MARKDOWN, store)
		),
		vscode.commands.registerCommand("vsc-todo.importDataFromJSON", () =>
			importCommand(context, ImportFormats.JSON, store)
		),
		vscode.commands.registerCommand("vsc-todo.importDataFromMarkdown", () =>
			importCommand(context, ImportFormats.MARKDOWN, store)
		),
	];

	const statusBarItem = initStatusBarItem(context);

	store.subscribe(() => {
		const state = store.getState();

		switch (state.actionTracker.lastSliceName) {
			case Slices.unset:
			case Slices.actionTracker:
				return;
			case Slices.user:
			case Slices.workspace:
			case Slices.currentFile:
				handleTodoChange(
					state,
					state[state.actionTracker.lastSliceName],
					store,
					context,
					storageSyncManager,
					syncManager
				);
				break;
			case Slices.editorFocusAndRecords:
				handleEditorFocusAndRecordsChange(state, store, context);
				break;
		}
	});

	const initialWorkspaceTodos = await storageSyncManager.getWorkspaceTodos();
	const initialUserTodos = await storageSyncManager.getUserTodos();
	const initialWorkspaceFilesData = await storageSyncManager.getWorkspaceFilesData();

	// Load workspace slice
	store.dispatch(
		workspaceActions.loadData({
			data: initialWorkspaceTodos ?? [],
		})
	);

	// Load user slice
	store.dispatch(
		userActions.loadData({
			data: initialUserTodos ?? [],
		})
	);

	// Load list of files with records
	store.dispatch(
		editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(initialWorkspaceFilesData ?? {})
		)
	);

	// Load current active editor tab and listen for changes
	tabChangeHandler(store, context);
	const onDidChangeActiveTextEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
		tabChangeHandler(store, context);
	});

	const onDidRenameFilesSubscription = vscode.workspace.onDidRenameFiles((event) => {
		for (const { oldUri, newUri } of event.files) {
			updateDataForRenamedFile({ oldPath: oldUri.fsPath, newPath: newUri.fsPath, context, store });
		}
	});

	const onDidDeleteFilesSubscription = vscode.workspace.onDidDeleteFiles((event) => {
		for (const deletedUri of event.files) {
			removeDataForDeletedFile({ filePath: deletedUri.fsPath, context, store });
		}
	});

	const provider = new TodoViewProvider(context.extensionUri, store, context);

	context.subscriptions.push(
		...commands,
		...syncCommands.registerCommands(),
		statusBarItem,
		onDidChangeActiveTextEditorSubscription,
		onDidRenameFilesSubscription,
		onDidDeleteFilesSubscription,
		vscode.window.registerWebviewViewProvider(TodoViewProvider.viewType, provider),
		{ dispose: () => syncManager.dispose() }
	);

	deleteCompletedTodos(store);
}

export function deactivate() {
	// Cleanup is handled by dispose methods in context.subscriptions
}

function handleTodoChange(
	state: StoreState,
	sliceState: TodoSlice | CurrentFileSlice,
	store: EnhancedStore,
	context: ExtensionContext,
	storageSyncManager: StorageSyncManager,
	syncManager: SyncManager
) {
	store.dispatch(actionTrackerActions.resetLastSliceName());
	HelloWorldPanel.currentPanel?.updateWebview(sliceState);
	TodoViewProvider.currentProvider?.updateWebview(sliceState);
	updateStatusBarItem(state);
	void storageSyncManager.persistSlice(sliceState as TodoSlice | CurrentFileSlice);

	// Trigger GitHub sync if enabled
	const syncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");
	// Trigger sync if GitHub mode is enabled for the scope
	const userMode = context.globalState.get<string>("syncMode", "profile-local");
	const workspaceMode = context.workspaceState.get<string>("syncMode", "local");

	if (sliceState.scope === TodoScope.user && userMode === "github") {
		syncManager.triggerDebounceSync("user");
	} else if ((sliceState.scope === TodoScope.workspace || sliceState.scope === TodoScope.currentFile) && workspaceMode === "github") {
		syncManager.triggerDebounceSync("workspace");
	}

	if (sliceState.scope === TodoScope.currentFile) {
		// Update editorFocusAndRecordsSlice
		store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
				getWorkspaceFilesWithRecords(context.workspaceState.get("TodoFilesData") ?? {})
			)
		);
	}
}

function handleEditorFocusAndRecordsChange(
	state: StoreState,
	store: EnhancedStore,
	context: ExtensionContext
) {
	store.dispatch(actionTrackerActions.resetLastSliceName());
	if (
		state.editorFocusAndRecords.editorFocusedFilePath !== "" &&
		state.editorFocusAndRecords.lastActionType === `${Slices.editorFocusAndRecords}/setCurrentFile` &&
		!state.currentFile.isPinned
	) {
		const data = context.workspaceState.get("TodoFilesData") as TodoFilesData | undefined;
		const todos = data?.[state.editorFocusAndRecords.editorFocusedFilePath] || [];
		store.dispatch(
			currentFileActions.loadData({
				filePath: state.editorFocusAndRecords.editorFocusedFilePath,
				data: todos,
			})
		);
	} else if (
		state.editorFocusAndRecords.lastActionType ===
		"editorFocusAndRecords/setWorkspaceFilesWithRecords"
	) {
		deleteCompletedTodosCurrentFile(store);
		HelloWorldPanel.currentPanel?.updateWebview(
			state.editorFocusAndRecords,
			Slices.editorFocusAndRecords
		);
		TodoViewProvider.currentProvider?.updateWebview(
			state.editorFocusAndRecords,
			Slices.editorFocusAndRecords
		);
	}
}

