import { Injectable } from "@angular/core";
import { Todo, storeActions } from "../../../../src/todo/store";
import { MESSAGE, Message, MessageActions } from "../../../../src/panels/message";
import { vscode } from "../utilities/vscode";
import { TodoCount } from "../../../../src/todo/todoUtils";

@Injectable({
	providedIn: "root",
})
export class TodoService {
	private _userTodos: Todo[] = [];
	private _workspaceTodos: Todo[] = [];
	private _todoCount: TodoCount = { user: 0, workspace: 0 };

	constructor() {
		window.addEventListener("message", ({ data }: { data: Message<MessageActions> }) => {
			if (data.type === MessageActions.setData) {
				const {
					payload: { workspaceTodos, userTodos, lastActionType, numberOfTodos },
				} = data as Message<MessageActions.setData>;

				// Clear old data
				if (this._userTodos.length) this._userTodos.length = 0;
				if (this._workspaceTodos.length) this._workspaceTodos.length = 0;

				if (userTodos.length) this._userTodos.push(...userTodos);
				if (workspaceTodos.length) this._workspaceTodos.push(...workspaceTodos);
				Object.assign(this._todoCount, numberOfTodos);
			}
		});
	}

	get userTodos(): Todo[] {
		return this._userTodos;
	}

	get workspaceTodos(): Todo[] {
		return this._workspaceTodos;
	}

	get todoCount(): TodoCount {
		return this._todoCount;
	}

	addTodo(payload: Parameters<typeof storeActions.addTodo>[0]) {
		vscode.postMessage(MESSAGE.addTodo(payload));
	}

	removeTodo(payload: Parameters<typeof storeActions.deleteTodo>[0]) {
		vscode.postMessage(MESSAGE.deleteTodo(payload));
	}

	toggleTodo(payload: Parameters<typeof storeActions.toggleTodo>[0]) {
		vscode.postMessage(MESSAGE.toggleTodo(payload));
	}

	editTodo(payload: Parameters<typeof storeActions.editTodo>[0]) {
		vscode.postMessage(MESSAGE.editTodo(payload));
	}

	reorderTodos(payload: Parameters<typeof storeActions.reorderTodo>[0]) {
		vscode.postMessage(MESSAGE.reorderTodo(payload));
	}
}
