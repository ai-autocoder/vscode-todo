import {
	Disposable,
	Webview,
	WebviewPanel,
	window,
	Uri,
	ViewColumn,
	ExtensionContext,
} from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { storeActions, FullData } from "../todo/store";
import { ToolkitStore } from "@reduxjs/toolkit/dist/configureStore";
import { Message, MessageActions, MESSAGE } from "./message";
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
	private context: ExtensionContext;
	private store: ToolkitStore;

	/**
	 * The HelloWorldPanel class private constructor (called only from the render method).
	 *
	 * @param panel A reference to the webview panel
	 * @param context The ExtensionContext
	 */
	private constructor(panel: WebviewPanel, context: ExtensionContext, store: ToolkitStore) {
		this._panel = panel;
		this.context = context;
		this.store = store;
		const extensionUri = context.extensionUri;

		// Set an event listener to listen for when the panel is disposed (i.e. when the user closes
		// the panel or when the panel is closed programmatically)
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Set the HTML content for the webview panel
		this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);

		// Set an event listener to listen for messages passed from the webview context
		this._setWebviewMessageListener(this._panel.webview, context);

		this._panel.onDidChangeViewState(
			() => {
				if (this._panel.visible) {
					// Send data to the webview
					this.update(store.getState());
				}
			},
			null,
			this._disposables
		);

		// Send data to the webview
		this.update(store.getState());
	}

	/**
	 * Renders the current webview panel if it exists otherwise a new webview panel
	 * will be created and displayed.
	 *
	 * @param extensionUri The URI of the directory containing the extension.
	 */
	public static render(context: ExtensionContext, store: ToolkitStore) {
		const extensionUri = context.extensionUri;
		if (HelloWorldPanel.currentPanel) {
			// If the webview panel already exists but and in focus, dispose it
			if (HelloWorldPanel.currentPanel._panel?.active) {
				HelloWorldPanel.currentPanel._panel.dispose();
			}
			// If the webview panel already exists but not in focus, reveal it
			else {
				HelloWorldPanel.currentPanel._panel.reveal(ViewColumn.One);
			}
		} else {
			// If a webview panel does not already exist create and show a new one
			const panel = window.createWebviewPanel(
				// Panel view type
				"showHelloWorld",
				// Panel title
				"Tasks / Todo",
				// The editor column the panel should be displayed in
				ViewColumn.One,
				// Extra panel configurations
				{
					// Enable JavaScript in the webview
					enableScripts: true,
					// Restrict the webview to only load resources from the `out` and `webview-ui/build` directories
					localResourceRoots: [
						Uri.joinPath(extensionUri, "out"),
						Uri.joinPath(extensionUri, "webview-ui/build"),
					],
				}
			);
			HelloWorldPanel.currentPanel = new HelloWorldPanel(panel, context, store);
		}
	}

	/**
	 * Sends the updated data to the webview.
	 */
	update(state: FullData) {
		this._panel.webview.postMessage(MESSAGE.setData(state));
	}

	/**
	 * Cleans up and disposes of webview resources when the webview panel is closed.
	 */
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
		const stylesUri = getUri(webview, extensionUri, ["webview-ui", "build", "styles.css"]);
		// The JS files from the Angular build output
		const runtimeUri = getUri(webview, extensionUri, ["webview-ui", "build", "runtime.js"]);
		const polyfillsUri = getUri(webview, extensionUri, ["webview-ui", "build", "polyfills.js"]);
		const scriptUri = getUri(webview, extensionUri, ["webview-ui", "build", "main.js"]);

		const nonce = getNonce();

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <title>Tasks / Todo</title>
        </head>
        <body>
          <app-root></app-root>
          <script type="module" nonce="${nonce}" src="${runtimeUri}"></script>
          <script type="module" nonce="${nonce}" src="${polyfillsUri}"></script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `;
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is recieved.
	 *
	 * @param webview A reference to the extension webview
	 * @param context A reference to the extension context
	 */
	private _setWebviewMessageListener(webview: Webview, context: ExtensionContext) {
		webview.onDidReceiveMessage(
			(message: Message<MessageActions>) => {
				switch (message.type) {
					case MessageActions.addTodo: {
						const { payload } = message as Message<MessageActions.addTodo>;
						this.store.dispatch(storeActions.addTodo(payload));
						break;
					}
					case MessageActions.deleteTodo: {
						const { payload } = message as Message<MessageActions.deleteTodo>;
						this.store.dispatch(storeActions.deleteTodo(payload));
						break;
					}
					case MessageActions.toggleTodo: {
						const { payload } = message as Message<MessageActions.toggleTodo>;
						this.store.dispatch(storeActions.toggleTodo(payload));
						break;
					}
					case MessageActions.editTodo: {
						const { payload } = message as Message<MessageActions.editTodo>;
						this.store.dispatch(storeActions.editTodo(payload));
						break;
					}
					case MessageActions.reorderTodo: {
						const { payload } = message as Message<MessageActions.reorderTodo>;
						this.store.dispatch(storeActions.reorderTodo(payload));
						break;
					}
					default:
						console.log("Action not found");
				}
			},
			undefined,
			this._disposables
		);
	}
}
