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

export async function activate(context: ExtensionContext) {
	const store = createStore();
	const storageSyncManager = new StorageSyncManager(context, store);
	await storageSyncManager.initialize();

	// Initialize GitHub sync modules
	const authManager = GitHubAuthManager.getInstance(context);
	const apiClient = new GitHubApiClient(context);
	const syncManager = new SyncManager(context);
	const syncCommands = new SyncCommands(context, authManager, apiClient, syncManager);

	// Start GitHub sync polling if enabled
	const syncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");
	const githubEnabled = syncConfig.get<boolean>("githubEnabled", false);
	if (githubEnabled) {
		const pollInterval = syncConfig.get<number>("pollInterval", 180);
		syncManager.startPolling("global", pollInterval);
		syncManager.startPolling("workspace", pollInterval);
	}

	// Listen for sync status changes and update status bar
	const syncStatusListener = syncManager.onStatusChange((event) => {
		updateSyncStatus(event.scope, event.status);
		updateStatusBarItem(store.getState());
	});
	context.subscriptions.push(syncStatusListener);

	if (typeof context.globalState.setKeysForSync === "function") {
		const cfg = getConfig();
		context.globalState.setKeysForSync(
			cfg.sync.user === "profile-sync" ? GLOBAL_STATE_SYNC_KEYS : []
		);
		const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("vscodeTodo.sync.user")) {
				const updated = getConfig();
				context.globalState.setKeysForSync(
					updated.sync.user === "profile-sync" ? GLOBAL_STATE_SYNC_KEYS : []
				);
			}
			// Handle GitHub sync configuration changes
			if (e.affectsConfiguration("vscodeTodo.sync.githubEnabled") || e.affectsConfiguration("vscodeTodo.sync.pollInterval")) {
				const updatedSyncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");
				const updatedGithubEnabled = updatedSyncConfig.get<boolean>("githubEnabled", false);
				const updatedPollInterval = updatedSyncConfig.get<number>("pollInterval", 180);

				if (updatedGithubEnabled) {
					syncManager.startPolling("global", updatedPollInterval);
					syncManager.startPolling("workspace", updatedPollInterval);
				} else {
					syncManager.stopPolling("global");
					syncManager.stopPolling("workspace");
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
	const githubEnabled = syncConfig.get<boolean>("githubEnabled", false);
	if (githubEnabled) {
		if (sliceState.scope === TodoScope.user) {
			syncManager.triggerDebounceSync("global");
		} else if (sliceState.scope === TodoScope.workspace || sliceState.scope === TodoScope.currentFile) {
			syncManager.triggerDebounceSync("workspace");
		}
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

