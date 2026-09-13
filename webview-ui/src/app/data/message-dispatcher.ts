/**
 * Routes the app's outbound webview messages to a {@link DataGateway}.
 *
 * In the extension, `TodoService` posts messages to the host via `vscode.postMessage`. The
 * standalone PWA has no host, so the PWA shell installs
 * `vscode.setPostMessageDelegate((m) => dispatchMessageToGateway(gateway, m))` — every message
 * the existing UI sends is translated into the equivalent gateway command, leaving
 * `TodoService` completely untouched.
 *
 * The `type` strings below are the (inlined) values of `MessageActionsFromWebview` plus the
 * bare `webview-ready` handshake. Unknown types are logged and dropped rather than thrown, so
 * a new extension-only message can never break the PWA.
 */

import type { DataGateway } from "./data-gateway";

type OutboundMessage = {
	type: string;
	scope?: unknown;
	payload?: unknown;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- payloads are re-validated by the
   gateway's typed methods; this boundary just fans the untyped wire shape out to them. */
export function dispatchMessageToGateway(gateway: DataGateway, message: unknown): void {
	const msg = message as OutboundMessage;
	if (!msg || typeof msg.type !== "string") {
		return;
	}
	const scope = msg.scope as any;
	const payload = msg.payload as any;

	switch (msg.type) {
		case "webview-ready":
			gateway.ready();
			break;

		case "addTodo":
			gateway.addTodo(scope, payload);
			break;
		case "deleteTodo":
			gateway.deleteTodo(scope, payload);
			break;
		case "undoDelete":
			gateway.undoDelete(scope, payload);
			break;
		case "toggleTodo":
			gateway.toggleTodo(scope, payload);
			break;
		case "editTodo":
			gateway.editTodo(scope, payload);
			break;
		case "setTags":
			gateway.setTags(scope, payload);
			break;
		case "reorderTodo":
			gateway.reorderTodos(scope, payload);
			break;
		case "toggleMarkdown":
			gateway.toggleMarkdown(scope, payload);
			break;
		case "toggleTodoNote":
			gateway.toggleTodoNote(scope, payload);
			break;
		case "toggleCollapsed":
			gateway.toggleCollapsed(scope, payload);
			break;
		case "setAllCollapsed":
			gateway.setAllCollapsed(scope, payload);
			break;

		case "pinFile":
			gateway.pinFile();
			break;
		case "requestData":
			gateway.setCurrentFile(payload?.filePath ?? "");
			break;
		case "import":
			gateway.import(payload?.format);
			break;
		case "export":
			gateway.export(payload?.format);
			break;
		case "setWideViewEnabled":
			gateway.setWideViewEnabled(!!payload?.isEnabled);
			break;
		case "setShowTagsEnabled":
			gateway.setShowTagsEnabled(!!payload?.isEnabled);
			break;

		case "selectUserSyncMode":
			gateway.selectUserSyncMode();
			break;
		case "selectWorkspaceSyncMode":
			gateway.selectWorkspaceSyncMode();
			break;
		case "setUserSyncMode":
			gateway.setUserSyncMode(payload?.mode);
			break;
		case "setWorkspaceSyncMode":
			gateway.setWorkspaceSyncMode(payload?.mode);
			break;
		case "connectGitHub":
			gateway.connectGitHub();
			break;
		case "disconnectGitHub":
			gateway.disconnectGitHub();
			break;
		case "setUserFile":
			gateway.setUserFile();
			break;
		case "setWorkspaceFile":
			gateway.setWorkspaceFile();
			break;
		case "openGistIdSettings":
			gateway.openGistIdSettings();
			break;
		case "viewGistOnGitHub":
			gateway.viewGistOnGitHub();
			break;
		case "syncNow":
			gateway.syncNow();
			break;
		case "startMcpServer":
			gateway.startMcpServer();
			break;
		case "stopMcpServer":
			gateway.stopMcpServer();
			break;

		default:
			console.warn("[PWA] Unhandled outbound message type:", msg.type);
	}
}
/* eslint-enable @typescript-eslint/no-explicit-any */
