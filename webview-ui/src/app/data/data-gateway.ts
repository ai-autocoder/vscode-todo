/**
 * DataGateway — the seam that decouples the Angular UI from its data source.
 *
 * The webview UI currently talks to the VS Code extension host over `postMessage`
 * ({@link TodoService} is the one place that does this). To reuse the very same UI as a
 * standalone PWA that reads/writes the shared GitHub Gist, we abstract that data source
 * behind this interface:
 *
 *   - {@link VsCodeGateway}  — the existing behavior; forwards every command to the extension
 *                              host via `postMessage`. This stays the default for the
 *                              extension build, which is therefore unaffected.
 *   - {@link GistGateway}    — drives `@vsc-todo/core`'s `GistSyncEngine` directly from the
 *                              browser, holding local state that mirrors the slice shape.
 *
 * Two directions:
 *   - **Commands** (UI → data): the methods below mirror {@link TodoService}'s command
 *     methods 1:1, typed against the extension's `messagesFromWebview` payload shapes so both
 *     implementations are held to an identical contract. A {@link VsCodeGateway} method is a
 *     trivial `postMessage`; a {@link GistGateway} method mutates local state and schedules a
 *     reconcile.
 *   - **Data** (data → UI): {@link DataGateway.messages} emits the same inbound messages the
 *     extension sends today (`reloadWebview`, `syncTodoData`, GitHub/MCP status, …). The UI
 *     subscribes to this instead of listening on `window` for `message` events, so the data
 *     source is fully pluggable.
 *
 * NOTE (additive rollout): introducing this interface does not, by itself, change the
 * shipping {@link TodoService}. The `VsCodeGateway` is a faithful extraction of its command
 * methods; wiring `TodoService` to consume a gateway is a later, separate step. Until then
 * this interface is the contract the PWA's `GistGateway` is built against.
 */

import type { Observable } from "rxjs";
import type {
	ExportFormats,
	ImportFormats,
	TodoScope,
} from "../../../../src/todo/todoTypes";
import type {
	Message,
	MessageActionsToWebview,
	UserSyncMode,
	WorkspaceSyncMode,
	messagesFromWebview,
} from "../../../../src/panels/message";

/**
 * The set of inbound messages a gateway delivers to the UI. These are exactly the
 * extension→webview messages the UI already knows how to handle in `TodoService`.
 */
export type InboundMessage =
	| Message<MessageActionsToWebview.reloadWebview>
	| Message<MessageActionsToWebview.syncTodoData>
	| Message<MessageActionsToWebview.syncEditorFocusAndRecords>
	| Message<MessageActionsToWebview.updateGitHubStatus>
	| Message<MessageActionsToWebview.updateGitHubSyncInfo>
	| Message<MessageActionsToWebview.updateSyncStatus>
	| Message<MessageActionsToWebview.updateMcpStatus>;

/**
 * Source-agnostic contract for the data layer. Command method parameter lists are taken
 * verbatim from `messagesFromWebview` so the VS Code and Gist implementations cannot drift.
 */
export interface DataGateway {
	/** Inbound data/state updates pushed to the UI (replaces the `window` message listener). */
	readonly messages: Observable<InboundMessage>;

	/**
	 * Signal that the UI is mounted and ready to receive the initial data dump. The
	 * VS Code gateway posts `webview-ready`; the Gist gateway performs the first reconcile.
	 */
	ready(): void;

	// --- Item commands (mirror TodoService) ---
	addTodo(...args: Parameters<typeof messagesFromWebview.addTodo>): void;
	deleteTodo(...args: Parameters<typeof messagesFromWebview.deleteTodo>): void;
	undoDelete(...args: Parameters<typeof messagesFromWebview.undoDelete>): void;
	toggleTodo(...args: Parameters<typeof messagesFromWebview.toggleTodo>): void;
	editTodo(...args: Parameters<typeof messagesFromWebview.editTodo>): void;
	setTags(...args: Parameters<typeof messagesFromWebview.setTags>): void;
	reorderTodos(...args: Parameters<typeof messagesFromWebview.reorderTodo>): void;
	toggleMarkdown(...args: Parameters<typeof messagesFromWebview.toggleMarkdown>): void;
	toggleTodoNote(...args: Parameters<typeof messagesFromWebview.toggleTodoNote>): void;
	toggleCollapsed(...args: Parameters<typeof messagesFromWebview.toggleCollapsed>): void;
	setAllCollapsed(...args: Parameters<typeof messagesFromWebview.setAllCollapsed>): void;

	// --- File / view commands ---
	pinFile(): void;
	setCurrentFile(filePath: string): void;
	import(format: ImportFormats): void;
	export(format: ExportFormats): void;
	setWideViewEnabled(isEnabled: boolean): void;
	setShowTagsEnabled(isEnabled: boolean): void;

	// --- Sync / GitHub commands ---
	selectUserSyncMode(): void;
	selectWorkspaceSyncMode(): void;
	setUserSyncMode(mode: UserSyncMode): void;
	setWorkspaceSyncMode(mode: WorkspaceSyncMode): void;
	connectGitHub(): void;
	disconnectGitHub(): void;
	setUserFile(): void;
	setWorkspaceFile(): void;
	openGistIdSettings(): void;
	viewGistOnGitHub(): void;
	syncNow(): void;

	// --- MCP commands (no-op in the PWA, which has no extension host) ---
	startMcpServer(): void;
	stopMcpServer(): void;
}

/** Marker used by the eventual TodoService refactor for DI. */
export const DATA_GATEWAY = "DATA_GATEWAY";
