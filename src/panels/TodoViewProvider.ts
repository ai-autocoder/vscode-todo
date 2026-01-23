import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { HelloWorldPanel } from "./HelloWorldPanel";
import { getCurrentThemeKind } from "../utilities/currentTheme";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { getConfig } from "../utilities/config";
import { getGistId } from "../utilities/syncConfig";
import { messagesToWebview, GitHubSyncInfo } from "./message";
import type { McpStatus } from "./message";
import { TodoSlice, EditorFocusAndRecordsSlice, CurrentFileSlice, Slices } from "../todo/todoTypes";
import { deleteCompletedTodos } from "../todo/todoUtils";
import { GitHubAuthManager } from "../sync/GitHubAuthManager";
import { WebviewVisibilityCoordinator } from "../sync/WebviewVisibilityCoordinator";
import { getGitHubSyncInfo } from "../utilities/syncInfo";
import McpServerHost from "../mcp/McpServerHost";

export class TodoViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "vsc-todo.todoView";
	private _view?: vscode.WebviewView;
	public static currentProvider: TodoViewProvider | undefined;
	private _visibilityCoordinator: WebviewVisibilityCoordinator | undefined;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _store: EnhancedStore,
		private readonly _context: vscode.ExtensionContext,
		visibilityCoordinator?: WebviewVisibilityCoordinator,
		private readonly _mcpServerHost?: McpServerHost
	) {
		TodoViewProvider.currentProvider = this;
		this._visibilityCoordinator = visibilityCoordinator;
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

		// Track initial visibility
		if (webviewView.visible && this._visibilityCoordinator) {
			this._visibilityCoordinator.incrementVisibility();
		}

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				if (this._visibilityCoordinator) {
					this._visibilityCoordinator.incrementVisibility();
				}
				deleteCompletedTodos(this._store);
				this.reloadWebview();
			} else {
				if (this._visibilityCoordinator) {
					this._visibilityCoordinator.decrementVisibility();
				}
			}
		});

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
		HelloWorldPanel.setupWebviewMessageHandler(webviewView.webview, this._context, this._store);

		// Refresh webview when typography settings change
		this._context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
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

	public async reloadWebview() {
		if (this._view) {
			const currentState = this._store.getState();
			const config = getConfig();
			this._view.webview.postMessage(messagesToWebview.reloadWebview(currentState, config));
			await this.postGitHubStatus();
			this.postGitHubSyncInfo();
			this.postMcpStatus();
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

	public updateGitHubStatus(isConnected: boolean, hasGistId: boolean) {
		if (this._view) {
			this._view.webview.postMessage(messagesToWebview.updateGitHubStatus(isConnected, hasGistId));
		}
	}

	public updateGitHubSyncInfo(info: GitHubSyncInfo) {
		if (this._view) {
			this._view.webview.postMessage(messagesToWebview.updateGitHubSyncInfo(info));
		}
	}

	public updateSyncStatus(isSyncing: boolean) {
		if (this._view) {
			this._view.webview.postMessage(messagesToWebview.updateSyncStatus(isSyncing));
		}
	}

	public updateMcpStatus(status: McpStatus) {
		if (this._view) {
			this._view.webview.postMessage(messagesToWebview.updateMcpStatus(status));
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

	private getHasGistId(): boolean {
		return getGistId().length > 0;
	}

	private async postGitHubStatus(): Promise<void> {
		if (!this._view) {
			return;
		}

		const authManager = GitHubAuthManager.getInstance(this._context);
		const isConnected = await authManager.isAuthenticated();
		const hasGistId = this.getHasGistId();
		this._view.webview.postMessage(messagesToWebview.updateGitHubStatus(isConnected, hasGistId));
	}

	private postGitHubSyncInfo(): void {
		if (!this._view) {
			return;
		}

		const info = getGitHubSyncInfo(this._context);
		this._view.webview.postMessage(messagesToWebview.updateGitHubSyncInfo(info));
	}

	private postMcpStatus(): void {
		if (!this._view || !this._mcpServerHost) {
			return;
		}

		this.updateMcpStatus(this._mcpServerHost.getStatus());
	}
}
