import { Injectable } from "@angular/core";
import { Todo, TodoCount } from "../../../../src/todo/todoTypes";
import { storeActions } from "../../../../src/todo/store";
import { MESSAGE, Message, MessageActions } from "../../../../src/panels/message";
import { vscode } from "../utilities/vscode";
import { BehaviorSubject } from "rxjs";

@Injectable({
	providedIn: "root",
})
export class TodoService {
	private _userTodos: Todo[] = [];
	private _workspaceTodos: Todo[] = [];
	private _todoCount: TodoCount = { user: 0, workspace: 0 };
	lastActionType = new BehaviorSubject<string>("");

	constructor() {
		window.addEventListener("message", ({ data }: { data: Message<MessageActions> }) => {
			const {
				payload: { workspaceTodos, userTodos, lastActionType, numberOfTodos },
			} = data as Message<MessageActions.reloadWebview | MessageActions.syncData>;

			if (data.type === MessageActions.reloadWebview) {
				this.updateLastActionType("");
			} else {
				this.updateLastActionType(lastActionType);
			}

			// Clear old data
			this._userTodos.length = 0;
			this._workspaceTodos.length = 0;

			if (userTodos.length) this._userTodos.push(...userTodos);
			if (workspaceTodos.length) this._workspaceTodos.push(...workspaceTodos);
			Object.assign(this._todoCount, numberOfTodos);
		});
	}

	updateLastActionType(actionType: string = ""): void {
		this.lastActionType.next(actionType);
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
