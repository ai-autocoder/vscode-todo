/**
 * VsCodeGateway — the default {@link DataGateway} for the extension webview.
 *
 * It is a faithful, behavior-preserving extraction of {@link TodoService}'s command methods:
 * every method posts exactly the message `TodoService` posts today, and inbound
 * extension→webview messages are surfaced on {@link messages} (fed by the `window` `message`
 * listener) instead of `TodoService` listening on `window` directly.
 *
 * This keeps the extension build's behavior identical; the PWA selects {@link GistGateway}
 * instead. (Wiring `TodoService` to actually consume a gateway is the deferred follow-up; this
 * class is the drop-in that makes that refactor a no-op for the extension.)
 */

import { Observable, Subject } from "rxjs";
import {
	ExportFormats,
	ImportFormats,
	TodoScope,
} from "../../../../src/todo/todoTypes";
import {
	messagesFromWebview,
	UserSyncMode,
	WorkspaceSyncMode,
} from "../../../../src/panels/message";
import { vscode } from "../utilities/vscode";
import type { DataGateway, InboundMessage } from "./data-gateway";

export class VsCodeGateway implements DataGateway {
	private readonly _messages = new Subject<InboundMessage>();
	readonly messages: Observable<InboundMessage> = this._messages.asObservable();

	constructor() {
		window.addEventListener("message", this.onWindowMessage);
	}

	private onWindowMessage = (event: MessageEvent): void => {
		// The extension only ever posts the InboundMessage shapes; forward as-is.
		this._messages.next(event.data as InboundMessage);
	};

	ready(): void {
		vscode.postMessage({ type: "webview-ready" });
	}

	addTodo(...args: Parameters<typeof messagesFromWebview.addTodo>): void {
		vscode.postMessage(messagesFromWebview.addTodo(...args));
	}
	deleteTodo(...args: Parameters<typeof messagesFromWebview.deleteTodo>): void {
		vscode.postMessage(messagesFromWebview.deleteTodo(...args));
	}
	undoDelete(...args: Parameters<typeof messagesFromWebview.undoDelete>): void {
		vscode.postMessage(messagesFromWebview.undoDelete(...args));
	}
	toggleTodo(...args: Parameters<typeof messagesFromWebview.toggleTodo>): void {
		vscode.postMessage(messagesFromWebview.toggleTodo(...args));
	}
	editTodo(...args: Parameters<typeof messagesFromWebview.editTodo>): void {
		vscode.postMessage(messagesFromWebview.editTodo(...args));
	}
	setTags(...args: Parameters<typeof messagesFromWebview.setTags>): void {
		vscode.postMessage(messagesFromWebview.setTags(...args));
	}
	reorderTodos(...args: Parameters<typeof messagesFromWebview.reorderTodo>): void {
		vscode.postMessage(messagesFromWebview.reorderTodo(...args));
	}
	toggleMarkdown(...args: Parameters<typeof messagesFromWebview.toggleMarkdown>): void {
		vscode.postMessage(messagesFromWebview.toggleMarkdown(...args));
	}
	toggleTodoNote(...args: Parameters<typeof messagesFromWebview.toggleTodoNote>): void {
		vscode.postMessage(messagesFromWebview.toggleTodoNote(...args));
	}
	toggleCollapsed(...args: Parameters<typeof messagesFromWebview.toggleCollapsed>): void {
		vscode.postMessage(messagesFromWebview.toggleCollapsed(...args));
	}
	setAllCollapsed(...args: Parameters<typeof messagesFromWebview.setAllCollapsed>): void {
		vscode.postMessage(messagesFromWebview.setAllCollapsed(...args));
	}

	pinFile(): void {
		vscode.postMessage(messagesFromWebview.pinFile(TodoScope.currentFile));
	}
	setCurrentFile(filePath: string): void {
		vscode.postMessage(messagesFromWebview.requestData(TodoScope.currentFile, { filePath }));
	}
	import(format: ImportFormats): void {
		vscode.postMessage(messagesFromWebview.import(format));
	}
	export(format: ExportFormats): void {
		vscode.postMessage(messagesFromWebview.export(format));
	}
	setWideViewEnabled(isEnabled: boolean): void {
		vscode.postMessage(messagesFromWebview.setWideViewEnabled(isEnabled));
	}
	setShowTagsEnabled(isEnabled: boolean): void {
		vscode.postMessage(messagesFromWebview.setShowTagsEnabled(isEnabled));
	}

	selectUserSyncMode(): void {
		vscode.postMessage(messagesFromWebview.selectUserSyncMode());
	}
	selectWorkspaceSyncMode(): void {
		vscode.postMessage(messagesFromWebview.selectWorkspaceSyncMode());
	}
	setUserSyncMode(mode: UserSyncMode): void {
		vscode.postMessage(messagesFromWebview.setUserSyncMode(mode));
	}
	setWorkspaceSyncMode(mode: WorkspaceSyncMode): void {
		vscode.postMessage(messagesFromWebview.setWorkspaceSyncMode(mode));
	}
	connectGitHub(): void {
		vscode.postMessage(messagesFromWebview.connectGitHub());
	}
	disconnectGitHub(): void {
		vscode.postMessage(messagesFromWebview.disconnectGitHub());
	}
	setUserFile(): void {
		vscode.postMessage(messagesFromWebview.setUserFile());
	}
	setWorkspaceFile(): void {
		vscode.postMessage(messagesFromWebview.setWorkspaceFile());
	}
	openGistIdSettings(): void {
		vscode.postMessage(messagesFromWebview.openGistIdSettings());
	}
	viewGistOnGitHub(): void {
		vscode.postMessage(messagesFromWebview.viewGistOnGitHub());
	}
	syncNow(): void {
		vscode.postMessage(messagesFromWebview.syncNow());
	}

	startMcpServer(): void {
		vscode.postMessage(messagesFromWebview.startMcpServer());
	}
	stopMcpServer(): void {
		vscode.postMessage(messagesFromWebview.stopMcpServer());
	}
}
