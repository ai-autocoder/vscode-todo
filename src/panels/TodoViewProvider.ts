import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { HelloWorldPanel } from "./HelloWorldPanel";
import { getCurrentThemeKind } from "../utilities/currentTheme";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { getConfig } from "../utilities/config";
import { messagesToWebview } from "./message";
import { TodoSlice, EditorFocusAndRecordsSlice, CurrentFileSlice, Slices } from "../todo/todoTypes";

export class TodoViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "vsc-todo.todoView";
	private _view?: vscode.WebviewView;
	public static currentProvider: TodoViewProvider | undefined;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _store: EnhancedStore,
		private readonly _context: vscode.ExtensionContext
	) {
		TodoViewProvider.currentProvider = this;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, "out"),
				vscode.Uri.joinPath(this._extensionUri, "webview-ui/build/browser"),
			],
		};

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.reloadWebview();
			}
		});

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
		HelloWorldPanel.setupWebviewMessageHandler(webviewView.webview, this._context, this._store);
		this.reloadWebview();
	}

	private reloadWebview() {
		if (this._view) {
			const currentState = this._store.getState();
			const config = getConfig();
			this._view.webview.postMessage(messagesToWebview.reloadWebview(currentState, config));
		}
	}

	public updateWebview(
		newSliceState: TodoSlice | EditorFocusAndRecordsSlice | CurrentFileSlice,
		sliceType?: Slices
	) {
		if (this._view) {
			const message =
				sliceType === Slices.editorFocusAndRecords
					? messagesToWebview.syncEditorFocusAndRecords(newSliceState as EditorFocusAndRecordsSlice)
					: messagesToWebview.syncTodoData(newSliceState as TodoSlice | CurrentFileSlice);
			this._view.webview.postMessage(message);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const stylesUri = getUri(webview, this._extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"styles.css",
		]);
		const polyfillsUri = getUri(webview, this._extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"polyfills.js",
		]);
		const mainScriptUri = getUri(webview, this._extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"main.js",
		]);
		const scriptsUri = getUri(webview, this._extensionUri, [
			"webview-ui",
			"build",
			"browser",
			"scripts.js",
		]);
		const nonce = getNonce();
		const themeKind = getCurrentThemeKind();

		return `
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
}
