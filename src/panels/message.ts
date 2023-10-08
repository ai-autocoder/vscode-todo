import { FullData } from "../todo/store";
import { storeActions } from "../todo/store";

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
		: T extends MessageActions.setData
		? FullData
		: never;
}

export const enum MessageActions {
	addTodo = "addTodo",
	editTodo = "editTodo",
	toggleTodo = "toggleTodo",
	deleteTodo = "deleteTodo",
	getData = "getData",
	setData = "setData",
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
	// Message creators from extension to UI
	setData: (payload: FullData): Message<MessageActions.setData> => ({
		type: MessageActions.setData,
		payload,
	}),
};
