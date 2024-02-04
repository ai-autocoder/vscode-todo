import { storeActions } from "../todo/store";
import { FullData } from "../todo/todoTypes";

export interface Message<T extends MessageActions> {
	type: T;
	payload: T extends MessageActions.addTodo
		? Parameters<typeof storeActions.addTodo>[0]
		: T extends MessageActions.toggleTodo
		? Parameters<typeof storeActions.toggleTodo>[0]
		: T extends MessageActions.deleteTodo
		? Parameters<typeof storeActions.deleteTodo>[0]
		: T extends MessageActions.editTodo
		? Parameters<typeof storeActions.editTodo>[0]
		: T extends MessageActions.reloadWebview
		? FullData
		: T extends MessageActions.syncData
		? FullData
		: T extends MessageActions.reorderTodo
		? Parameters<typeof storeActions.reorderTodo>[0]
		: never;
}

export const enum MessageActions {
	addTodo = "addTodo",
	editTodo = "editTodo",
	toggleTodo = "toggleTodo",
	deleteTodo = "deleteTodo",
	reorderTodo = "reorderTodo",
	reloadWebview = "reloadWebview", // Initial data sent to webview
	syncData = "syncData", //Subsequent data synchronization to webview
}

// Message creators from Webview to Extension
export const MESSAGE = {
	addTodo: (
		payload: Parameters<typeof storeActions.addTodo>[0]
	): Message<MessageActions.addTodo> => ({
		type: MessageActions.addTodo,
		payload,
	}),
	editTodo: (
		payload: Parameters<typeof storeActions.editTodo>[0]
	): Message<MessageActions.editTodo> => ({
		type: MessageActions.editTodo,
		payload,
	}),
	toggleTodo: (
		payload: Parameters<typeof storeActions.toggleTodo>[0]
	): Message<MessageActions.toggleTodo> => ({
		type: MessageActions.toggleTodo,
		payload,
	}),
	deleteTodo: (
		payload: Parameters<typeof storeActions.deleteTodo>[0]
	): Message<MessageActions.deleteTodo> => ({
		type: MessageActions.deleteTodo,
		payload,
	}),
	reorderTodo: (
		payload: Parameters<typeof storeActions.reorderTodo>[0]
	): Message<MessageActions.reorderTodo> => ({
		type: MessageActions.reorderTodo,
		payload,
	}),
	// Message creators from extension to UI
	reloadWebview: (payload: FullData): Message<MessageActions.reloadWebview> => ({
		type: MessageActions.reloadWebview,
		payload,
	}),
	syncData: (payload: FullData): Message<MessageActions.syncData> => ({
		type: MessageActions.syncData,
		payload,
	}),
};
