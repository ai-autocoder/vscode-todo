import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import {
	Message,
	MessageActionsToWebview,
	messagesFromWebview,
} from "../../../../src/panels/message";
import { Todo, TodoCount, TodoScope } from "../../../../src/todo/todoTypes";
import { vscode } from "../utilities/vscode";
import { Config } from "../../../../src/utilities/config";

@Injectable({
	providedIn: "root",
})
export class TodoService {
	private _userTodos: Todo[] = [];
	private _workspaceTodos: Todo[] = [];
	private _currentFileTodos: Todo[] = [];
	private _todoCount: TodoCount = { user: 0, workspace: 0, currentFile: 0 };
	private _config: Config = {
		taskSortingOptions: "sortType1",
	};
	private currentFilePathSource = new BehaviorSubject<string>("");
	private workspaceFilesWithRecordsSource = new BehaviorSubject<
		{ filePath: string; todoNumber: number }[]
	>([]);

	userLastAction = new BehaviorSubject<string>("");
	workspaceLastAction = new BehaviorSubject<string>("");
	currentFileLastAction = new BehaviorSubject<string>("");
	currentFilePath = this.currentFilePathSource.asObservable();
	workspaceFilesWithRecords = this.workspaceFilesWithRecordsSource.asObservable();

	constructor() {
		window.addEventListener("message", this.handleMessage.bind(this));
	}

	private handleMessage(event: MessageEvent) {
		const { data } = event;
		switch (data.type) {
			case MessageActionsToWebview.reloadWebview:
				this.handleReloadWebview(data);
				break;
			case MessageActionsToWebview.syncTodoData:
				this.handleSyncTodoData(data);
				break;
			case MessageActionsToWebview.syncfileDataInfo:
				if (data.payload.lastActionType === "fileDataInfo/setCurrentFile") {
					this.handleEditorTabChange(data);
				} else if (data.payload.lastActionType === "fileDataInfo/setWorkspaceFilesWithRecords") {
					this.workspaceFilesWithRecordsSource.next(data.payload.workspaceFilesWithRecords);
				}
				break;
			default:
				console.warn("Unhandled message type:", data.type);
		}
	}

	private handleReloadWebview(data: Message<MessageActionsToWebview.reloadWebview>) {
		const { user, workspace, currentFile } = data.payload;
		this._config = data.config;

		this.updateTodos("user", user.todos, user.numberOfTodos);
		this.updateTodos("workspace", workspace.todos, workspace.numberOfTodos);
		this.updateTodos("currentFile", currentFile.todos, currentFile.numberOfTodos);
		this.userLastAction.next("");
		this.workspaceLastAction.next("");
		this.currentFileLastAction.next("");
	}

	private handleSyncTodoData(data: Message<MessageActionsToWebview.syncTodoData>) {
		const { payload } = data;
		const scope =
			payload.scope === TodoScope.user
				? "user"
				: payload.scope === TodoScope.workspace
					? "workspace"
					: "currentFile";
		this.updateTodos(scope, payload.todos, payload.numberOfTodos);
		this[`${scope}LastAction`].next(payload.lastActionType);
	}

	private handleEditorTabChange(data: Message<MessageActionsToWebview.syncfileDataInfo>) {
		const { payload } = data;
		if (payload.editorFocusedFilePath !== "") {
			this.currentFilePathSource.next(payload.editorFocusedFilePath);
			vscode.postMessage(
				messagesFromWebview.requestData(TodoScope.currentFile, {
					filePath: payload.editorFocusedFilePath,
				})
			);
		}
	}

	private updateTodos(
		scope: "user" | "workspace" | "currentFile",
		todos: Todo[],
		numberOfTodos: number
	) {
		this[`_${scope}Todos`] = [...todos];
		this._todoCount[scope] = numberOfTodos;
	}

	get userTodos(): Todo[] {
		return this._userTodos;
	}

	get workspaceTodos(): Todo[] {
		return this._workspaceTodos;
	}

	get currentFileTodos(): Todo[] {
		return this._currentFileTodos;
	}

	get todoCount(): TodoCount {
		return this._todoCount;
	}

	get config(): Config {
		return this._config;
	}

	addTodo(...args: Parameters<typeof messagesFromWebview.addTodo>) {
		vscode.postMessage(messagesFromWebview.addTodo(...args));
	}

	deleteTodo(...args: Parameters<typeof messagesFromWebview.deleteTodo>) {
		vscode.postMessage(messagesFromWebview.deleteTodo(...args));
	}

	toggleTodo(...args: Parameters<typeof messagesFromWebview.toggleTodo>) {
		vscode.postMessage(messagesFromWebview.toggleTodo(...args));
	}

	editTodo(...args: Parameters<typeof messagesFromWebview.editTodo>) {
		vscode.postMessage(messagesFromWebview.editTodo(...args));
	}

	reorderTodos(...args: Parameters<typeof messagesFromWebview.reorderTodo>) {
		vscode.postMessage(messagesFromWebview.reorderTodo(...args));
	}

	toggleMarkdown(...args: Parameters<typeof messagesFromWebview.toggleMarkdown>) {
		vscode.postMessage(messagesFromWebview.toggleMarkdown(...args));
	}

	toggleTodoNote(...args: Parameters<typeof messagesFromWebview.toggleTodoNote>) {
		vscode.postMessage(messagesFromWebview.toggleTodoNote(...args));
	}
}
