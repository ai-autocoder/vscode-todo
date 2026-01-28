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
import TodoService from "./todo/TodoService";
import PlanArchiveService from "./todo/PlanArchiveService";
import { TodoViewProvider } from "./panels/TodoViewProvider";
import { getConfig } from "./utilities/config";
import { notifyGitHubSyncInfo, reloadScopeData } from "./utilities/syncUtils";
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
	TodoFilesDataPaths,
	TodoScope,
	TodoSlice,
} from "./todo/todoTypes";
import {
	deleteCompletedTodos,
	deleteCompletedTodosCurrentFile,
	ensureFilesDataPaths,
	getRelativePathIfInsideWorkspace,
	getWorkspacePath,
	getWorkspaceFilesWithRecords,
	removeDataForDeletedFile,
	resolveFilesDataKey,
	sortByFileName,
	upsertFilesDataPathEntry,
	updateDataForRenamedFile,
} from "./todo/todoUtils";
import { GitHubAuthManager, GitHubApiClient, SyncManager, SyncCommands, SyncStatus } from "./sync";
import { messagesToWebview } from "./panels/message";
import { WebviewVisibilityCoordinator } from "./sync/WebviewVisibilityCoordinator";
import McpServerHost from "./mcp/McpServerHost";
import McpLogChannel from "./mcp/McpLogChannel";

const GLOBAL_STATE_SYNC_KEYS: readonly string[] = ["TodoData"];

export async function activate(context: ExtensionContext) {
	const store = createStore();
	const storageSyncManager = new StorageSyncManager(context, store);
	await storageSyncManager.initialize();

	// Initialize GitHub sync modules
	const authManager = GitHubAuthManager.getInstance(context);
	const apiClient = new GitHubApiClient(context);
	const syncManager = new SyncManager(context);
	const uiTodoService = new TodoService(context, store, storageSyncManager, syncManager);
	uiTodoService.updateAccess(false, ["user", "workspace", "file"]);
	const planArchiveService = new PlanArchiveService(uiTodoService);
	const syncCommands = new SyncCommands(context, authManager, apiClient, syncManager, store, storageSyncManager);
	const mcpServerHost = new McpServerHost(context, store, storageSyncManager, syncManager);
	mcpServerHost.initialize();

	// Start GitHub sync polling if enabled
	const userSyncMode = context.globalState.get<string>("syncMode", "profile-local");
	const workspaceSyncMode = context.workspaceState.get<string>("syncMode", "local");
	const syncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");

	// Create webview visibility coordinator
	const pollInterval = syncConfig.get<number>("github.pollInterval", 180);
	const visibilityCoordinator = new WebviewVisibilityCoordinator(syncManager, context, pollInterval);
	context.subscriptions.push(visibilityCoordinator);

	// Set coordinator in sync commands so it can be notified of mode changes
	syncCommands.setVisibilityCoordinator(visibilityCoordinator);

	// Listen for sync status changes and update status bar
	const syncStatusListener = syncManager.onStatusChange((event) => {
		updateSyncStatus(event.scope, event.status);
		updateStatusBarItem(store.getState());

		// Notify webviews of sync status
		const isSyncing = event.status === SyncStatus.Syncing;
		const message = messagesToWebview.updateSyncStatus(isSyncing);
		TodoViewProvider.currentProvider?.updateSyncStatus(isSyncing);
		HelloWorldPanel.currentPanel?.updateSyncStatus(isSyncing);
		notifyGitHubSyncInfo(context);
	});
	context.subscriptions.push(syncStatusListener);

	const mcpStatusListener = mcpServerHost.onDidChangeStatus((status) => {
		TodoViewProvider.currentProvider?.updateMcpStatus(status);
		HelloWorldPanel.currentPanel?.updateMcpStatus(status);
	});
	context.subscriptions.push(mcpStatusListener);

	// Listen for data downloads and reload store
	const dataDownloadListener = syncManager.onDataDownloaded(async (event) => {
		await reloadScopeData(event.scope, store, storageSyncManager, context);
	});
	context.subscriptions.push(dataDownloadListener);

	if (typeof context.globalState.setKeysForSync === "function") {
		// Enable VS Code Settings Sync for TodoData if using profile-sync mode
		const currentSyncMode = context.globalState.get<string>("syncMode", "profile-local");
		context.globalState.setKeysForSync(
			currentSyncMode === "profile-sync" ? GLOBAL_STATE_SYNC_KEYS : []
		);
	}

	const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
		let reloadUser = false;
		let reloadWorkspace = false;

		// Handle GitHub sync poll interval changes
		if (e.affectsConfiguration("vscodeTodo.sync.github.pollInterval")) {
			const updatedSyncConfig = vscode.workspace.getConfiguration("vscodeTodo.sync");
			const updatedPollInterval = updatedSyncConfig.get<number>("github.pollInterval", 180);

			// Update coordinator
			visibilityCoordinator.updatePollInterval(updatedPollInterval);

			// If pollOnlyWhenVisible is disabled, restart polling immediately
			const updatedPollOnlyWhenVisible = updatedSyncConfig.get<boolean>("pollOnlyWhenVisible", true);
			if (!updatedPollOnlyWhenVisible) {
				const currentUserMode = context.globalState.get<string>("syncMode", "profile-local");
				const currentWorkspaceMode = context.workspaceState.get<string>("syncMode", "local");

				if (currentUserMode === "github") {
					syncManager.startPolling("user", updatedPollInterval);
				}
				if (currentWorkspaceMode === "github") {
					syncManager.startPolling("workspace", updatedPollInterval);
				}
			}
		}

		if (e.affectsConfiguration("vscodeTodo.sync.github.userFile")) {
			reloadUser = true;
		}

		if (e.affectsConfiguration("vscodeTodo.sync.github.workspaceFile")) {
			reloadWorkspace = true;
		}

		if (reloadUser) {
			void reloadScopeData("user", store, storageSyncManager, context);
		}

		if (reloadWorkspace) {
			void reloadScopeData("workspace", store, storageSyncManager, context);
		}
	});
	context.subscriptions.push(configListener);

	// Start polling immediately if pollOnlyWhenVisible is disabled
	const pollOnlyWhenVisible = syncConfig.get<boolean>("pollOnlyWhenVisible", true);
	if (!pollOnlyWhenVisible && (userSyncMode === "github" || workspaceSyncMode === "github")) {
		if (userSyncMode === "github") {
			syncManager.startPolling("user", pollInterval);
		}
		if (workspaceSyncMode === "github") {
			syncManager.startPolling("workspace", pollInterval);
		}
	}

	const commands = [
		vscode.commands.registerCommand("vsc-todo.openTodo", () =>
			HelloWorldPanel.render(context, store, visibilityCoordinator, mcpServerHost, planArchiveService)
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
		vscode.commands.registerCommand("vsc-todo.startMcpServer", async () => {
			const status = mcpServerHost.getStatus();
			if (status.running) {
				const url = status.port ? `http://127.0.0.1:${status.port}/mcp` : null;
				const message = url
					? `MCP server is already running at ${url}`
					: "MCP server is already running.";
				McpLogChannel.log(`[MCP] ${message}`);
				void vscode.window.showInformationMessage(message);
				return;
			}
			const config = vscode.workspace.getConfiguration("vscodeTodo.mcp");
			const target = vscode.workspace.workspaceFolders
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
			await config.update("enabled", true, target);
			await mcpServerHost.start();
		}),
		vscode.commands.registerCommand("vsc-todo.stopMcpServer", async () => {
			const status = mcpServerHost.getStatus();
			if (!status.running) {
				const message = "MCP server is already stopped.";
				McpLogChannel.log(`[MCP] ${message}`);
				void vscode.window.showInformationMessage(message);
				if (!status.enabled) {
					return;
				}
			}
			const config = vscode.workspace.getConfiguration("vscodeTodo.mcp");
			const target = vscode.workspace.workspaceFolders
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
			await config.update("enabled", false, target);
			await mcpServerHost.stop();
		}),
	];

	const statusBarItem = initStatusBarItem(context);

	const initialWorkspaceTodos = await storageSyncManager.getWorkspaceTodos();
	const initialUserTodos = await storageSyncManager.getUserTodos();
	const initialWorkspaceFilesData = await storageSyncManager.getWorkspaceFilesData();
	const initialWorkspaceFilesDataPaths = ensureFilesDataPaths(
		initialWorkspaceFilesData ?? {},
		await storageSyncManager.getWorkspaceFilesDataPaths(),
		getWorkspacePath()
	);
	await context.workspaceState.update("TodoFilesData", initialWorkspaceFilesData ?? {});
	await context.workspaceState.update("TodoFilesDataPaths", initialWorkspaceFilesDataPaths);

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
			{
				workspaceFilesWithRecords: getWorkspaceFilesWithRecords(initialWorkspaceFilesData ?? {}),
				filesDataPaths: initialWorkspaceFilesDataPaths,
			}
		)
	);

	store.dispatch(actionTrackerActions.resetLastSliceName());
	updateStatusBarItem(store.getState());

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

	const provider = new TodoViewProvider(
		context.extensionUri,
		store,
		context,
		visibilityCoordinator,
		mcpServerHost,
		planArchiveService
	);

	context.subscriptions.push(
		...commands,
		...syncCommands.registerCommands(),
		statusBarItem,
		onDidChangeActiveTextEditorSubscription,
		onDidRenameFilesSubscription,
		onDidDeleteFilesSubscription,
		vscode.window.registerWebviewViewProvider(TodoViewProvider.viewType, provider),
		{ dispose: () => syncManager.dispose() },
		mcpServerHost
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

	// Trigger GitHub sync if enabled for the scope
	const userMode = context.globalState.get<string>("syncMode", "profile-local");
	const workspaceMode = context.workspaceState.get<string>("syncMode", "local");

	if (sliceState.scope === TodoScope.user && userMode === "github") {
		syncManager.triggerDebounceSync("user");
	} else if ((sliceState.scope === TodoScope.workspace || sliceState.scope === TodoScope.currentFile) && workspaceMode === "github") {
		syncManager.triggerDebounceSync("workspace");
	}

	if (sliceState.scope === TodoScope.currentFile) {
		const currentFileState = sliceState as CurrentFileSlice;
		const workspaceRoot = getWorkspacePath();
		const existingData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
		const existingPaths =
			(context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) ?? {};
		let filesData = { ...existingData };
		let filesDataPaths = ensureFilesDataPaths(filesData, existingPaths, workspaceRoot);

		if (currentFileState.filePath) {
			const resolved = resolveFilesDataKey({
				filePath: currentFileState.filePath,
				filesData,
				filesDataPaths,
			});
			const primaryKey = resolved.key ?? currentFileState.filePath;

			if (currentFileState.todos.length === 0) {
				delete filesData[primaryKey];
				delete filesDataPaths[primaryKey];
			} else {
				filesData[primaryKey] = currentFileState.todos;
				const relPath = getRelativePathIfInsideWorkspace(currentFileState.filePath, workspaceRoot);
				upsertFilesDataPathEntry({
					filesDataPaths,
					primaryKey,
					absPath: currentFileState.filePath,
					relPath,
				});
			}

			filesData = sortByFileName(filesData);
			filesDataPaths = ensureFilesDataPaths(filesData, filesDataPaths, workspaceRoot);
		}

		// Update editorFocusAndRecordsSlice with the latest file list snapshot.
		store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
				{
					workspaceFilesWithRecords: getWorkspaceFilesWithRecords(filesData),
					filesDataPaths,
				}
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
		const filesData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
		const filesDataPaths = ensureFilesDataPaths(
			filesData,
			(context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) ?? {},
			getWorkspacePath()
		);
		void context.workspaceState.update("TodoFilesDataPaths", filesDataPaths);
		const resolved = resolveFilesDataKey({
			filePath: state.editorFocusAndRecords.editorFocusedFilePath,
			filesData,
			filesDataPaths,
		});
		const todos = resolved.key ? filesData[resolved.key] ?? [] : [];
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

