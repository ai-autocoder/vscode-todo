import { EnhancedStore } from "@reduxjs/toolkit";
import {
	Disposable,
	ExtensionContext,
	Tab,
	TabInputWebview,
	Uri,
	ViewColumn,
	Webview,
	WebviewPanel,
	window,
	commands,
	workspace,
} from "vscode";
import { currentFileActions, userActions, workspaceActions } from "../todo/store";
import {
	CurrentFileSlice,
	EditorFocusAndRecordsSlice,
	Slices,
	Todo,
	TodoFilesData,
	TodoFilesDataPaths,
	TodoScope,
	TodoSlice,
} from "../todo/todoTypes";
import { getConfig, setConfig } from "../utilities/config";
import { getCurrentThemeKind } from "../utilities/currentTheme";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { getGistId } from "../utilities/syncConfig";
import {
	Message,
	MessageActionsFromWebview,
	messagesToWebview,
	GitHubSyncInfo,
	SyncStatusInfo,
} from "./message";
import type { McpStatus } from "./message";
import { ExportFormats } from "../todo/todoTypes";
import { ImportFormats } from "../todo/todoTypes";
import { TodoViewProvider } from "./TodoViewProvider";
import {
	deleteCompletedTodos,
	ensureFilesDataPaths,
	getWorkspacePath,
	resolveFilesDataKey,
} from "../todo/todoUtils";
import { GitHubAuthManager } from "../sync/GitHubAuthManager";
import { WebviewVisibilityCoordinator } from "../sync/WebviewVisibilityCoordinator";
import { getGitHubSyncInfo, getSyncStatusInfo } from "../utilities/syncInfo";
import McpServerHost from "../mcp/McpServerHost";
import LogChannel from "../utilities/LogChannel";

/**
 * Whether a webview tab's `viewType` is the Todo panel's. VS Code reports the type it uses
 * internally, which prefixes the extension's own (`mainThreadWebview-showVscodeTodoWebview`), so
 * both spellings are accepted.
 */
function isTodoPanelViewType(viewType: string): boolean {
	return viewType === HelloWorldPanel.viewType || viewType.endsWith(`-${HelloWorldPanel.viewType}`);
}

/**
 * This class manages the state and behavior of HelloWorld webview panels.
 *
 * It contains all the data and methods for:
 *
 * - Creating and rendering HelloWorld webview panels
 * - Properly cleaning up and disposing of webview resources when the panel is closed
 * - Setting the HTML (and by proxy CSS/JavaScript) content of the webview panel
 * - Setting message listeners so data can be passed between the webview and extension
 */
export class HelloWorldPanel {
	public static readonly viewType = "showVscodeTodoWebview";
	public static currentPanel: HelloWorldPanel | undefined;
	private readonly _panel: WebviewPanel;
	private _disposables: Disposable[] = [];
	private _store: EnhancedStore;
	private _context: ExtensionContext;
	private _visibilityCoordinator: WebviewVisibilityCoordinator | undefined;
	private _mcpServerHost: McpServerHost | undefined;
	private _isVisible: boolean = false;

	private constructor(
		panel: WebviewPanel,
		context: ExtensionContext,
		store: EnhancedStore,
		visibilityCoordinator?: WebviewVisibilityCoordinator,
		mcpServerHost?: McpServerHost
	) {
		this._panel = panel;
		this._store = store;
		this._context = context;
		this._visibilityCoordinator = visibilityCoordinator;
		this._mcpServerHost = mcpServerHost;
		const extensionUri = context.extensionUri;

		// Track initial visibility
		this._isVisible = panel.visible;
		if (this._isVisible && this._visibilityCoordinator) {
			this._visibilityCoordinator.incrementVisibility();
		}

		// Track visibility changes
		this._panel.onDidChangeViewState(
			(e) => {
				const wasVisible = this._isVisible;
				this._isVisible = e.webviewPanel.visible;

				if (!wasVisible && this._isVisible) {
					// Became visible
					if (this._visibilityCoordinator) {
						this._visibilityCoordinator.incrementVisibility();
					}
				} else if (wasVisible && !this._isVisible) {
					// Became hidden
					if (this._visibilityCoordinator) {
						this._visibilityCoordinator.decrementVisibility();
					}
				}
			},
			null,
			this._disposables
		);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);

		HelloWorldPanel.setupWebviewMessageHandler(this._panel.webview, context, store);

		// Refresh webview when typography settings change
		context.subscriptions.push(
			workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("vscodeTodo.webviewFontFamily") ||
					e.affectsConfiguration("vscodeTodo.webviewFontSize")
				) {
					this.reloadWebview();
				}
				if (e.affectsConfiguration("vscodeTodo.sync.github.gistId")) {
					void this.postGitHubStatus();
				}
			})
		);
	}

	/**
	 * Renders the current webview panel if it exists otherwise a new webview panel
	 * will be created and displayed.
	 *
	 */
	public static render(
		context: ExtensionContext,
		store: EnhancedStore,
		visibilityCoordinator?: WebviewVisibilityCoordinator,
		mcpServerHost?: McpServerHost
	) {
		if (HelloWorldPanel.currentPanel) {
			// If the webview panel already exists and in focus, dispose it
			if (HelloWorldPanel.currentPanel._panel?.active) {
				HelloWorldPanel.currentPanel._panel.dispose();
			}
			// If the webview panel already exists but not in focus, reveal it
			else {
				HelloWorldPanel.currentPanel._panel.reveal(ViewColumn.Beside);
				deleteCompletedTodos(store);
			}
		} else {
			// If a webview panel does not already exist create and show a new one
			HelloWorldPanel.create(
				context,
				store,
				{ viewColumn: ViewColumn.Beside },
				visibilityCoordinator,
				mcpServerHost
			);
		}
	}

	/** The Todo editor tabs open in the window. */
	public static todoTabs(): Tab[] {
		return window.tabGroups.all
			.flatMap((group) => group.tabs)
			.filter(
				(tab) => tab.input instanceof TabInputWebview && isTodoPanelViewType(tab.input.viewType)
			);
	}

	/**
	 * Replaces Todo tabs left behind by an earlier extension host. Pass {@link todoTabs} as taken
	 * at the very start of activation, before anything can open a tab: every Todo tab open then
	 * belongs to that host.
	 *
	 * When the extension host restarts with the window still open, as an update to this extension
	 * makes it do, VS Code keeps webview tabs open but never connects them to the new host. Such a
	 * tab goes on showing the list it had and accepts input, and everything sent from it is
	 * dropped: an add typed there cleared the box and was lost. A sidebar view does not have the
	 * problem, since VS Code disposes it and resolves it again. This host has no handle on the old
	 * tab, so it opens a live one in the same group and closes the old one.
	 *
	 * A tab in front in its group is replaced at once. One behind another editor is replaced when
	 * it is next shown: replacing it now would bring the Todo tab to the front over the editor in
	 * use, and a hidden tab takes no input meanwhile. One moved to another group before it is
	 * shown is not recognised again, since moving it makes it a new tab.
	 *
	 * Whatever was unsent in the old tab, such as a draft in the composer or an edit in progress,
	 * goes with it. Nothing sent from it since the restart was saved anyway.
	 *
	 * @returns the listener waiting for hidden tabs to be shown, to dispose with the extension
	 */
	public static replaceOrphanedTabs(
		orphans: readonly Tab[],
		context: ExtensionContext,
		store: EnhancedStore,
		visibilityCoordinator?: WebviewVisibilityCoordinator,
		mcpServerHost?: McpServerHost
	): Disposable {
		const waiting = new Set(orphans);
		const replaceShown = () => {
			const open = new Set(window.tabGroups.all.flatMap((group) => group.tabs));
			const shown: Tab[] = [];
			for (const tab of waiting) {
				if (!open.has(tab)) {
					waiting.delete(tab);
				} else if (tab.isActive) {
					waiting.delete(tab);
					shown.push(tab);
				}
			}
			if (shown.length === 0) {
				return;
			}
			// One live panel can stand in for one tab. Others shown at the same moment, in other
			// groups, are only closed: the panel moving from one to the next would empty them all.
			HelloWorldPanel.replaceTab(shown[0], context, store, visibilityCoordinator, mcpServerHost)
				.then(() => (shown.length > 1 ? window.tabGroups.close(shown.slice(1), true) : true))
				.then(undefined, (error: unknown) =>
					LogChannel.log(
						`Failed to replace a Todo tab left by the previous extension host: ${error instanceof Error ? error.message : String(error)}`
					)
				);
		};

		replaceShown();
		const listener = window.tabGroups.onDidChangeTabs((event) => {
			for (const tab of event.closed) {
				waiting.delete(tab);
			}
			replaceShown();
			if (waiting.size === 0) {
				listener.dispose();
			}
		});
		if (waiting.size === 0) {
			listener.dispose();
		}
		return listener;
	}

	private static async replaceTab(
		tab: Tab,
		context: ExtensionContext,
		store: EnhancedStore,
		visibilityCoordinator?: WebviewVisibilityCoordinator,
		mcpServerHost?: McpServerHost
	): Promise<void> {
		const { viewColumn } = tab.group;
		// Opened first, so closing the old tab cannot close its group and lose the column. A panel
		// this host already has, from the Todo command run during activation or a tab replaced
		// earlier, is moved there instead, since there is only one.
		if (HelloWorldPanel.currentPanel) {
			HelloWorldPanel.currentPanel._panel.reveal(viewColumn, true);
		} else {
			HelloWorldPanel.create(
				context,
				store,
				{ viewColumn, preserveFocus: true },
				visibilityCoordinator,
				mcpServerHost
			);
		}
		await window.tabGroups.close(tab, true);
	}

	private static create(
		context: ExtensionContext,
		store: EnhancedStore,
		showOptions: { viewColumn: ViewColumn; preserveFocus?: boolean },
		visibilityCoordinator?: WebviewVisibilityCoordinator,
		mcpServerHost?: McpServerHost
	): void {
		const extensionUri = context.extensionUri;
		const panel = window.createWebviewPanel(
			// Panel view type
			HelloWorldPanel.viewType,
			// Panel title
			"Todo",
			// The editor column the panel should be displayed in
			showOptions,
			// Extra panel configurations
			{
				// Enable JavaScript in the webview
				enableScripts: true,
				// Restrict the webview to only load resources from the `out` and `webview-ui/build/browser` directories
				localResourceRoots: [
					Uri.joinPath(extensionUri, "out"),
					Uri.joinPath(extensionUri, "webview-ui/build/browser"),
				],
				retainContextWhenHidden: true,
				enableFindWidget: true,
			}
		);
		deleteCompletedTodos(store);
		HelloWorldPanel.currentPanel = new HelloWorldPanel(
			panel,
			context,
			store,
			visibilityCoordinator,
			mcpServerHost
		);
	}

	/**
	 * Sends the full state of the store and config to the webview.
	 */
	private async reloadWebview() {
		const currentState = this._store.getState();
		const config = getConfig();
		this._panel.webview.postMessage(messagesToWebview.reloadWebview(currentState, config));
		await this.postGitHubStatus();
		this.postGitHubSyncInfo();
		this.postSyncStatus();
		this.postMcpStatus();
	}

	/**
	 * Updates the webview with the given new slice state.
	 *
	 * @param newSliceState - The new slice state to update the webview with.
	 * @param sliceType - (Optional) The type of slice state being updated.
	 * Defaults to `user / workspace / currentFile` slices.
	 */
	public updateWebview(
		newSliceState: TodoSlice | EditorFocusAndRecordsSlice | CurrentFileSlice,
		sliceType?: Slices
	) {
		const message =
			sliceType === Slices.editorFocusAndRecords
				? messagesToWebview.syncEditorFocusAndRecords(newSliceState as EditorFocusAndRecordsSlice)
				: messagesToWebview.syncTodoData(newSliceState as TodoSlice | CurrentFileSlice);
		this._panel.webview.postMessage(message);
	}

	public updateGitHubStatus(isConnected: boolean, hasGistId: boolean) {
		this._panel.webview.postMessage(messagesToWebview.updateGitHubStatus(isConnected, hasGistId));
	}

	public updateGitHubSyncInfo(info: GitHubSyncInfo) {
		this._panel.webview.postMessage(messagesToWebview.updateGitHubSyncInfo(info));
	}

	public updateSyncStatus(info: SyncStatusInfo) {
		this._panel.webview.postMessage(messagesToWebview.updateSyncStatus(info));
	}

	public updateMcpStatus(status: McpStatus) {
		this._panel.webview.postMessage(messagesToWebview.updateMcpStatus(status));
	}

	public dispose() {
		// Decrement visibility if panel was visible
		if (this._isVisible && this._visibilityCoordinator) {
			this._visibilityCoordinator.decrementVisibility();
		}

		HelloWorldPanel.currentPanel = undefined;

		// Dispose of the current webview panel
		this._panel.dispose();

		// Dispose of all disposables (i.e. commands) for the current webview panel
		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the Angular webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private _getWebviewContent(webview: Webview, extensionUri: Uri) {
		// The CSS file from the Angular build output
		const stylesUri = getUri(webview, extensionUri, ["webview-ui", "build", "browser", "styles.css"]);
		// The JS files from the Angular build output
		const polyfillsUri = getUri(webview, extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"polyfills.js",
		]);
		const mainScriptUri = getUri(webview, extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"main.js",
		]);
		const scriptsUri = getUri(webview, extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"scripts.js",
		]);
		const nonce = getNonce();
		const themeKind = getCurrentThemeKind();

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
            <!DOCTYPE html>
            <html lang="en">
                <head>
                    <meta charset="UTF-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                    <link rel="stylesheet" type="text/css" href="${stylesUri}">
                    <title>Todo</title>
                </head>
                <body class="${themeKind}">
                    <app-root></app-root>
                    <script type="module" nonce="${nonce}" src="${polyfillsUri}"></script>
                    <script nonce="${nonce}" src="${scriptsUri}"></script>
                    <script type="module" nonce="${nonce}" src="${mainScriptUri}"></script>
                </body>
            </html>
        `;
	}

	private getHasGistId(): boolean {
		return getGistId().length > 0;
	}

	private async postGitHubStatus(): Promise<void> {
		const authManager = GitHubAuthManager.getInstance(this._context);
		const isConnected = await authManager.isAuthenticated();
		const hasGistId = this.getHasGistId();
		this._panel.webview.postMessage(messagesToWebview.updateGitHubStatus(isConnected, hasGistId));
	}

	private postGitHubSyncInfo(): void {
		const info = getGitHubSyncInfo(this._context);
		this._panel.webview.postMessage(messagesToWebview.updateGitHubSyncInfo(info));
	}

	/** See TodoViewProvider.postSyncStatus. */
	private postSyncStatus(): void {
		this._panel.webview.postMessage(messagesToWebview.updateSyncStatus(getSyncStatusInfo()));
	}

	private postMcpStatus(): void {
		if (!this._mcpServerHost) {
			return;
		}

		this.updateMcpStatus(this._mcpServerHost.getStatus());
	}

	public static setupWebviewMessageHandler(
		webview: Webview,
		context: ExtensionContext,
		store: EnhancedStore
	) {
		webview.onDidReceiveMessage(
			async (message: Message<MessageActionsFromWebview, TodoScope> | { type: "webview-ready" }) => {
				const storeActions =
					"scope" in message && message.scope
						? HelloWorldPanel.getStoreActions(message.scope)
						: undefined;
				switch (message.type) {
					case "webview-ready": {
						HelloWorldPanel.currentPanel?.reloadWebview();
						TodoViewProvider.currentProvider?.reloadWebview();
						break;
					}
					case MessageActionsFromWebview.addTodo: {
						const { payload } = message as Message<MessageActionsFromWebview.addTodo, TodoScope>;
						if (
							(message.scope === TodoScope.workspace || message.scope === TodoScope.currentFile) &&
							!getWorkspacePath()
						) {
							window.showWarningMessage(
								"No workspace open. Open a folder to add workspace or file todos."
							);
							break;
						}
						store.dispatch(storeActions!.addTodo(payload));
						break;
					}
					case MessageActionsFromWebview.deleteTodo: {
						const { payload } = message as Message<MessageActionsFromWebview.deleteTodo, TodoScope>;
						store.dispatch(storeActions!.deleteTodo(payload));
						break;
					}
					case MessageActionsFromWebview.undoDelete: {
						const { payload } = message as Message<MessageActionsFromWebview.undoDelete, TodoScope>;
						const { currentFilePath } = payload;

						if (
							message.scope === TodoScope.currentFile &&
							currentFilePath &&
							store.getState().currentFilePath !== currentFilePath
						) {
							const filesData = context.workspaceState.get<TodoFilesData>("TodoFilesData") ?? {};
							const filesDataPaths = ensureFilesDataPaths(
								filesData,
								context.workspaceState.get<TodoFilesDataPaths>("TodoFilesDataPaths") ?? {},
								getWorkspacePath()
							);
							void context.workspaceState.update("TodoFilesDataPaths", filesDataPaths);
							const resolved = resolveFilesDataKey({
								filePath: currentFilePath,
								filesData,
								filesDataPaths,
							});
							const todos = resolved.key ? (filesData[resolved.key] ?? []) : [];

							store.dispatch(
								currentFileActions.loadData({
									filePath: currentFilePath,
									data: todos,
								})
							);
						}
						store.dispatch(storeActions!.undoDelete(payload));
						break;
					}
					case MessageActionsFromWebview.toggleTodo: {
						const { payload } = message as Message<MessageActionsFromWebview.toggleTodo, TodoScope>;
						store.dispatch(storeActions!.toggleTodo(payload));
						break;
					}
					case MessageActionsFromWebview.editTodo: {
						const { payload } = message as Message<MessageActionsFromWebview.editTodo, TodoScope>;
						store.dispatch(storeActions!.editTodo(payload));
						break;
					}
					case MessageActionsFromWebview.reorderTodo: {
						const { payload } = message as Message<MessageActionsFromWebview.reorderTodo, TodoScope>;
						store.dispatch(storeActions!.reorderTodo(payload));
						break;
					}
					case MessageActionsFromWebview.toggleMarkdown: {
						const { payload } = message as Message<MessageActionsFromWebview.toggleMarkdown, TodoScope>;
						store.dispatch(storeActions!.toggleMarkdown(payload));
						break;
					}
					case MessageActionsFromWebview.toggleTodoNote: {
						const { payload } = message as Message<MessageActionsFromWebview.toggleTodoNote, TodoScope>;
						store.dispatch(storeActions!.toggleTodoNote(payload));
						break;
					}
					case MessageActionsFromWebview.setTags: {
						const { payload } = message as Message<MessageActionsFromWebview.setTags, TodoScope>;
						store.dispatch(storeActions!.setTags(payload));
						break;
					}
					case MessageActionsFromWebview.toggleCollapsed: {
						const { payload } = message as Message<MessageActionsFromWebview.toggleCollapsed, TodoScope>;
						store.dispatch(storeActions!.toggleCollapsed(payload));
						break;
					}
					case MessageActionsFromWebview.setAllCollapsed: {
						const { payload } = message as Message<MessageActionsFromWebview.setAllCollapsed, TodoScope>;
						store.dispatch(storeActions!.setAllCollapsed(payload));
						break;
					}
					case MessageActionsFromWebview.pinFile: {
						store.dispatch(currentFileActions.pinFile());
						break;
					}
					case MessageActionsFromWebview.requestData: {
						const { payload: messagePayload } = message as Message<
							MessageActionsFromWebview.requestData,
							TodoScope
						>;
						if (message.scope === TodoScope.currentFile) {
							const data = context.workspaceState.get("TodoFilesData") as
								| {
										[filePath: string]: Todo[];
								  }
								| undefined;
							const todos = data?.[messagePayload.filePath] || [];
							const actionPayload = {
								filePath: messagePayload.filePath,
								data: todos,
							};
							store.dispatch(
								storeActions!.loadData(actionPayload as Parameters<typeof currentFileActions.loadData>[0])
							);
						} else {
							console.error("Scope not supported for loadData");
						}
						break;
					}
					case MessageActionsFromWebview.export: {
						const { payload } = message as Message<MessageActionsFromWebview.export>;
						if (payload.format === ExportFormats.JSON) {
							commands.executeCommand("vsc-todo.exportDataToJSON");
						} else if (payload.format === ExportFormats.MARKDOWN) {
							commands.executeCommand("vsc-todo.exportDataToMarkdown");
						}
						break;
					}
					case MessageActionsFromWebview.import: {
						const { payload } = message as Message<MessageActionsFromWebview.import>;
						if (payload.format === ImportFormats.JSON) {
							commands.executeCommand("vsc-todo.importDataFromJSON");
						} else if (payload.format === ImportFormats.MARKDOWN) {
							commands.executeCommand("vsc-todo.importDataFromMarkdown");
						}
						break;
					}
					case MessageActionsFromWebview.setWideViewEnabled: {
						const { payload } = message;
						setConfig("enableWideView", payload.isEnabled);
						break;
					}
					case MessageActionsFromWebview.setShowTagsEnabled: {
						const { payload } = message;
						setConfig("showTags", payload.isEnabled);
						break;
					}
					case MessageActionsFromWebview.deleteCompleted: {
						store.dispatch(storeActions!.deleteCompleted());
						break;
					}
					case MessageActionsFromWebview.selectUserSyncMode: {
						commands.executeCommand("vsc-todo.selectUserSyncMode");
						break;
					}
					case MessageActionsFromWebview.selectWorkspaceSyncMode: {
						commands.executeCommand("vsc-todo.selectWorkspaceSyncMode");
						break;
					}
					case MessageActionsFromWebview.setUserSyncMode: {
						const { payload } = message as Message<MessageActionsFromWebview.setUserSyncMode>;
						commands.executeCommand("vsc-todo.selectUserSyncMode", payload.mode);
						break;
					}
					case MessageActionsFromWebview.setWorkspaceSyncMode: {
						const { payload } = message as Message<MessageActionsFromWebview.setWorkspaceSyncMode>;
						commands.executeCommand("vsc-todo.selectWorkspaceSyncMode", payload.mode);
						break;
					}
					case MessageActionsFromWebview.connectGitHub: {
						commands.executeCommand("vsc-todo.connectGitHub");
						break;
					}
					case MessageActionsFromWebview.disconnectGitHub: {
						commands.executeCommand("vsc-todo.disconnectGitHub");
						break;
					}
					case MessageActionsFromWebview.setUserFile: {
						commands.executeCommand("vsc-todo.setUserFile");
						break;
					}
					case MessageActionsFromWebview.setWorkspaceFile: {
						commands.executeCommand("vsc-todo.setWorkspaceFile");
						break;
					}
					case MessageActionsFromWebview.openGistIdSettings: {
						commands.executeCommand("vsc-todo.setupGistId");
						break;
					}
					case MessageActionsFromWebview.viewGistOnGitHub: {
						commands.executeCommand("vsc-todo.viewGistOnGitHub");
						break;
					}
					case MessageActionsFromWebview.syncNow: {
						commands.executeCommand("vsc-todo.syncNow");
						break;
					}
					case MessageActionsFromWebview.startMcpServer: {
						commands.executeCommand("vsc-todo.startMcpServer");
						break;
					}
					case MessageActionsFromWebview.stopMcpServer: {
						commands.executeCommand("vsc-todo.stopMcpServer");
						break;
					}
					default:
						console.error("Action not found");
				}
			},
			undefined,
			[]
		);
	}

	private static getStoreActions(scope: TodoScope) {
		switch (scope) {
			case TodoScope.user:
				return userActions;
			case TodoScope.workspace:
				return workspaceActions;
			case TodoScope.currentFile:
				return currentFileActions;
			default:
				throw new Error("Invalid action scope");
		}
	}
}
