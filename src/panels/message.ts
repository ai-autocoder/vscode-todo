import { ExportFormats } from "../todo/todoTypes";
import { ImportFormats } from "../todo/todoTypes";
import { currentFileActions, userActions, workspaceActions } from "../todo/store";
import {
	CurrentFileSlice,
	EditorFocusAndRecordsSlice,
	StoreState,
	TodoScope,
	TodoSlice,
} from "../todo/todoTypes";
import { Config } from "../utilities/config";

type MessagePayload<T, L> = T extends
	| MessageActionsFromWebview.addTodo
	| MessageActionsFromWebview.editTodo
	| MessageActionsFromWebview.toggleTodo
	| MessageActionsFromWebview.deleteTodo
	| MessageActionsFromWebview.reorderTodo
	| MessageActionsFromWebview.toggleMarkdown
	| MessageActionsFromWebview.toggleTodoNote
	| MessageActionsFromWebview.toggleCollapsed
	| MessageActionsFromWebview.setAllCollapsed
	? Parameters<
			L extends TodoScope.user
				? (typeof userActions)[T]
				: L extends TodoScope.workspace
					? (typeof workspaceActions)[T]
					: L extends TodoScope.currentFile
						? (typeof currentFileActions)[T]
						: never
		>[0]
	: T extends MessageActionsFromWebview.undoDelete
		? {
				id: number;
				text: string;
				completed: boolean;
				creationDate: string;
				isMarkdown: boolean;
				isNote: boolean;
				collapsed?: boolean;
				itemPosition: number;
				currentFilePath?: string | null;
			}
		: T extends MessageActionsFromWebview.requestData
			? L extends TodoScope.currentFile
				? { filePath: string }
				: never
			: T extends MessageActionsFromWebview.export
				? { format: ExportFormats }
				: T extends MessageActionsFromWebview.import
					? { format: ImportFormats }
					: T extends MessageActionsFromWebview.setWideViewEnabled
						? {
								isEnabled: boolean;
							}
						: T extends MessageActionsToWebview.syncTodoData
							? TodoSlice | CurrentFileSlice
							: T extends MessageActionsToWebview.syncEditorFocusAndRecords
								? EditorFocusAndRecordsSlice
								: T extends MessageActionsToWebview.reloadWebview
									? StoreState
									: T extends MessageActionsToWebview.updateGitHubStatus
										? { isConnected: boolean }
										: T extends MessageActionsToWebview.updateSyncStatus
											? { isSyncing: boolean }
											: never;

export type Message<
	T extends MessageActionsFromWebview | MessageActionsToWebview,
	L extends TodoScope = never,
> = T extends MessageActionsToWebview.reloadWebview
	? {
			type: T;
			payload: MessagePayload<T, L>;
			config: Config;
		}
	: T extends
				| MessageActionsToWebview.syncTodoData
				| MessageActionsToWebview.syncEditorFocusAndRecords
				| MessageActionsToWebview.updateGitHubStatus
				| MessageActionsToWebview.updateSyncStatus
		? {
				type: T;
				payload: MessagePayload<T, L>;
			}
		: T extends MessageActionsFromWebview.pinFile
			? { type: T; scope: TodoScope.currentFile }
			: T extends
						| MessageActionsFromWebview.export
						| MessageActionsFromWebview.import
						| MessageActionsFromWebview.setWideViewEnabled
				? {
						type: T;
						payload: MessagePayload<T, L>;
					}
				: T extends MessageActionsFromWebview.deleteCompleted
					? {
							type: T;
							scope: L;
						}
					: {
							type: T;
							scope: L;
							payload: MessagePayload<T, L>;
						};

export const enum MessageActionsFromWebview {
	addTodo = "addTodo",
	editTodo = "editTodo",
	toggleTodo = "toggleTodo",
	deleteTodo = "deleteTodo",
	undoDelete = "undoDelete",
	reorderTodo = "reorderTodo",
	toggleMarkdown = "toggleMarkdown",
	toggleTodoNote = "toggleTodoNote",
	toggleCollapsed = "toggleCollapsed",
	setAllCollapsed = "setAllCollapsed",
	requestData = "requestData",
	pinFile = "pinFile",
	export = "export",
	import = "import",
	setWideViewEnabled = "setWideViewEnabled",
	deleteCompleted = "deleteCompleted",
	selectUserSyncMode = "selectUserSyncMode",
	selectWorkspaceSyncMode = "selectWorkspaceSyncMode",
	connectGitHub = "connectGitHub",
	disconnectGitHub = "disconnectGitHub",
	setGistId = "setGistId",
	setUserFile = "setUserFile",
	setWorkspaceFile = "setWorkspaceFile",
	syncNow = "syncNow",
}
export const enum MessageActionsToWebview {
	reloadWebview = "reloadWebview", // Send full data to webview when it reloads
	syncTodoData = "syncTodoData",
	syncEditorFocusAndRecords = "syncEditorFocusAndRecords",
	updateGitHubStatus = "updateGitHubStatus",
	updateSyncStatus = "updateSyncStatus",
}

// Message creators from Webview to Extension
export const messagesFromWebview = {
	addTodo: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.addTodo>[0]
			: Parameters<typeof workspaceActions.addTodo>[0]
	): Message<MessageActionsFromWebview.addTodo, TodoScope> => ({
		type: MessageActionsFromWebview.addTodo,
		scope,
		payload,
	}),
	editTodo: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.editTodo>[0]
			: Parameters<typeof workspaceActions.editTodo>[0]
	): Message<MessageActionsFromWebview.editTodo, TodoScope> => ({
		type: MessageActionsFromWebview.editTodo,
		scope,
		payload,
	}),
	toggleTodo: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.toggleTodo>[0]
			: Parameters<typeof workspaceActions.toggleTodo>[0]
	): Message<MessageActionsFromWebview.toggleTodo, TodoScope> => ({
		type: MessageActionsFromWebview.toggleTodo,
		scope,
		payload,
	}),
	deleteTodo: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.deleteTodo>[0]
			: Parameters<typeof workspaceActions.deleteTodo>[0]
	): Message<MessageActionsFromWebview.deleteTodo, TodoScope> => ({
		type: MessageActionsFromWebview.deleteTodo,
		scope,
		payload,
	}),
	undoDelete: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.currentFile
			? Parameters<typeof currentFileActions.undoDelete>[0] & { currentFilePath: string | null }
			: L extends TodoScope.user
				? Parameters<typeof userActions.undoDelete>[0]
				: Parameters<typeof workspaceActions.undoDelete>[0]
	): Message<MessageActionsFromWebview.undoDelete, L> => ({
		type: MessageActionsFromWebview.undoDelete,
		scope,
		payload,
	}),
	reorderTodo: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.reorderTodo>[0]
			: Parameters<typeof workspaceActions.reorderTodo>[0]
	): Message<MessageActionsFromWebview.reorderTodo, TodoScope> => ({
		type: MessageActionsFromWebview.reorderTodo,
		scope,
		payload,
	}),
	toggleMarkdown: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.toggleMarkdown>[0]
			: Parameters<typeof workspaceActions.toggleMarkdown>[0]
	): Message<MessageActionsFromWebview.toggleMarkdown, TodoScope> => ({
		type: MessageActionsFromWebview.toggleMarkdown,
		scope,
		payload,
	}),
	toggleTodoNote: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.toggleTodoNote>[0]
			: Parameters<typeof workspaceActions.toggleTodoNote>[0]
	): Message<MessageActionsFromWebview.toggleTodoNote, TodoScope> => ({
		type: MessageActionsFromWebview.toggleTodoNote,
		scope,
		payload,
	}),
	toggleCollapsed: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.toggleCollapsed>[0]
			: Parameters<typeof workspaceActions.toggleCollapsed>[0]
	): Message<MessageActionsFromWebview.toggleCollapsed, TodoScope> => ({
		type: MessageActionsFromWebview.toggleCollapsed,
		scope,
		payload,
	}),
	setAllCollapsed: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.user
			? Parameters<typeof userActions.setAllCollapsed>[0]
			: Parameters<typeof workspaceActions.setAllCollapsed>[0]
	): Message<MessageActionsFromWebview.setAllCollapsed, TodoScope> => ({
		type: MessageActionsFromWebview.setAllCollapsed,
		scope,
		payload,
	}),
	requestData: <L extends TodoScope>(
		scope: L,
		payload: L extends TodoScope.currentFile ? { filePath: string } : never
	): Message<MessageActionsFromWebview.requestData, TodoScope> => ({
		type: MessageActionsFromWebview.requestData,
		scope,
		payload,
	}),
	pinFile: (
		scope: TodoScope.currentFile
	): Message<MessageActionsFromWebview.pinFile, TodoScope> => ({
		type: MessageActionsFromWebview.pinFile,
		scope,
	}),
	export: (format: ExportFormats): Message<MessageActionsFromWebview.export> => ({
		type: MessageActionsFromWebview.export,
		payload: { format },
	}),
	import: (format: ImportFormats): Message<MessageActionsFromWebview.import> => ({
		type: MessageActionsFromWebview.import,
		payload: { format },
	}),
	setWideViewEnabled: (
		isEnabled: boolean
	): Message<MessageActionsFromWebview.setWideViewEnabled> => ({
		type: MessageActionsFromWebview.setWideViewEnabled,
		payload: { isEnabled },
	}),
	deleteCompleted: <L extends TodoScope>(
		scope: L
	): Message<MessageActionsFromWebview.deleteCompleted, TodoScope> => ({
		type: MessageActionsFromWebview.deleteCompleted,
		scope,
	}),
	selectUserSyncMode: (): { type: MessageActionsFromWebview.selectUserSyncMode } => ({
		type: MessageActionsFromWebview.selectUserSyncMode,
	}),
	selectWorkspaceSyncMode: (): { type: MessageActionsFromWebview.selectWorkspaceSyncMode } => ({
		type: MessageActionsFromWebview.selectWorkspaceSyncMode,
	}),
	connectGitHub: (): { type: MessageActionsFromWebview.connectGitHub } => ({
		type: MessageActionsFromWebview.connectGitHub,
	}),
	disconnectGitHub: (): { type: MessageActionsFromWebview.disconnectGitHub } => ({
		type: MessageActionsFromWebview.disconnectGitHub,
	}),
	setGistId: (): { type: MessageActionsFromWebview.setGistId } => ({
		type: MessageActionsFromWebview.setGistId,
	}),
	setUserFile: (): { type: MessageActionsFromWebview.setUserFile } => ({
		type: MessageActionsFromWebview.setUserFile,
	}),
	setWorkspaceFile: (): { type: MessageActionsFromWebview.setWorkspaceFile } => ({
		type: MessageActionsFromWebview.setWorkspaceFile,
	}),
	syncNow: (): { type: MessageActionsFromWebview.syncNow } => ({
		type: MessageActionsFromWebview.syncNow,
	}),
};
export const messagesToWebview = {
	// Message creators from extension to UI
	reloadWebview: (
		payload: StoreState,
		config: Config
	): Message<MessageActionsToWebview.reloadWebview> => ({
		type: MessageActionsToWebview.reloadWebview,
		payload,
		config,
	}),
	syncTodoData: (
		payload: TodoSlice | CurrentFileSlice
	): Message<MessageActionsToWebview.syncTodoData> => ({
		type: MessageActionsToWebview.syncTodoData,
		payload,
	}),
	syncEditorFocusAndRecords: (
		payload: EditorFocusAndRecordsSlice
	): Message<MessageActionsToWebview.syncEditorFocusAndRecords> => ({
		type: MessageActionsToWebview.syncEditorFocusAndRecords,
		payload,
	}),
	updateGitHubStatus: (isConnected: boolean): { type: MessageActionsToWebview.updateGitHubStatus; payload: { isConnected: boolean } } => ({
		type: MessageActionsToWebview.updateGitHubStatus,
		payload: { isConnected },
	}),
	updateSyncStatus: (isSyncing: boolean): { type: MessageActionsToWebview.updateSyncStatus; payload: { isSyncing: boolean } } => ({
		type: MessageActionsToWebview.updateSyncStatus,
		payload: { isSyncing },
	}),
};
