import { EnhancedStore } from "@reduxjs/toolkit";
import {
	Disposable,
	ExtensionContext,
	Uri,
	ViewColumn,
	Webview,
	WebviewPanel,
	window,
	commands,
} from "vscode";
import { currentFileActions, userActions, workspaceActions } from "../todo/store";
import {
	CurrentFileSlice,
	EditorFocusAndRecordsSlice,
	Slices,
	Todo,
	TodoFilesData,
	TodoScope,
	TodoSlice,
} from "../todo/todoTypes";
import { getConfig, setConfig } from "../utilities/config";
import { getCurrentThemeKind } from "../utilities/currentTheme";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { Message, MessageActionsFromWebview, messagesToWebview } from "./message";
import { ExportFormats } from "../todo/todoTypes";
import { ImportFormats } from "../todo/todoTypes";
import { TodoViewProvider } from "./TodoViewProvider";
import { deleteCompletedTodos } from "../todo/todoUtils";

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
	public static currentPanel: HelloWorldPanel | undefined;
	private readonly _panel: WebviewPanel;
	private _disposables: Disposable[] = [];
	private _store: EnhancedStore;

	private constructor(panel: WebviewPanel, context: ExtensionContext, store: EnhancedStore) {
		this._panel = panel;
		this._store = store;
		const extensionUri = context.extensionUri;

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);

		HelloWorldPanel.setupWebviewMessageHandler(this._panel.webview, context, store);
	}

	/**
	 * Renders the current webview panel if it exists otherwise a new webview panel
	 * will be created and displayed.
	 *
	 */
	public static render(context: ExtensionContext, store: EnhancedStore) {
		const extensionUri = context.extensionUri;
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
			const panel = window.createWebviewPanel(
				// Panel view type
				"showVscodeTodoWebview",
				// Panel title
				"Todo",
				// The editor column the panel should be displayed in
				ViewColumn.Beside,
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
			HelloWorldPanel.currentPanel = new HelloWorldPanel(panel, context, store);
		}
	}

	/**
	 * Sends the full state of the store and config to the webview.
	 */
	private reloadWebview() {
		const currentState = this._store.getState();
		const config = getConfig();
		this._panel.webview.postMessage(messagesToWebview.reloadWebview(currentState, config));
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

	public dispose() {
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
							const data = context.workspaceState.get<TodoFilesData>("TodoFilesData");
							const todos = data?.[currentFilePath] ?? [];

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
					case MessageActionsFromWebview.deleteAll: {
						let scopeDisplay = "";
						switch (message.scope) {
							case TodoScope.user:
								scopeDisplay = "User";
								break;
							case TodoScope.workspace:
								scopeDisplay = "Workspace";
								break;
							case TodoScope.currentFile:
								scopeDisplay = "Current File";
								break;
						}
						const confirmDelete = await window.showWarningMessage(
							`Are you sure you want to delete all items in the ${scopeDisplay} list? This action cannot be undone.`,
							{ modal: true },
							"Yes"
						);
						if (confirmDelete === "Yes") {
							store.dispatch(storeActions!.deleteAll());
						}
						break;
					}
					case MessageActionsFromWebview.deleteCompleted: {
						store.dispatch(storeActions!.deleteCompleted());
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
