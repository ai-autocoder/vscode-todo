import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import {
	Message,
	MessageActionsToWebview,
	messagesFromWebview,
} from "../../../../src/panels/message";
import {
	CurrentFileSlice,
	Todo,
	TodoCount,
	TodoScope,
	TodoSlice,
} from "../../../../src/todo/todoTypes";
import { vscode } from "../utilities/vscode";
import { Config } from "../../../../src/utilities/config";

@Injectable({
	providedIn: "root",
})
export class TodoService {
	private _userTodos: Todo[] = [];
	private _workspaceTodos: Todo[] = [];
	private _currentFileSlice: CurrentFileSlice = {
		filePath: "",
		todos: [],
		isPinned: false,
		scope: TodoScope.currentFile,
		lastActionType: "",
		numberOfTodos: 0,
		numberOfNotes: 0,
	};
	private _todoCount: TodoCount = { user: 0, workspace: 0, currentFile: 0 };
	private _config: Config = {
		taskSortingOptions: "sortType1",
	};
	private _currentFilePathSource = new BehaviorSubject<string>("");
	private _workspaceFilesWithRecordsSource = new BehaviorSubject<
		{ filePath: string; todoNumber: number }[]
	>([]);

	userLastAction = new BehaviorSubject<string>("");
	workspaceLastAction = new BehaviorSubject<string>("");
	currentFileLastAction = new BehaviorSubject<string>("");
	currentFilePath = this._currentFilePathSource.asObservable();
	workspaceFilesWithRecords = this._workspaceFilesWithRecordsSource.asObservable();

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
				this.handleSyncTodoData(data.payload);
				break;
			case MessageActionsToWebview.syncfileDataInfo:
				if (data.payload.lastActionType === "fileDataInfo/setWorkspaceFilesWithRecords") {
					this._workspaceFilesWithRecordsSource.next(data.payload.workspaceFilesWithRecords);
				}
				break;
			default:
				console.warn("Unhandled message type:", data.type);
		}
	}

	private handleReloadWebview(data: Message<MessageActionsToWebview.reloadWebview>) {
		const { user, workspace, currentFile } = data.payload;
		this._config = data.config;

		for (const scope of Object.values(TodoScope)) {
			this.handleSyncTodoData(data.payload[scope]);
		}
	}

	private handleSyncTodoData(payload: TodoSlice | CurrentFileSlice) {
		switch (payload.scope) {
			case TodoScope.user:
				this._userTodos = payload.todos;
				this._todoCount.user = payload.numberOfTodos;
				this.userLastAction.next(payload.lastActionType);
				break;
			case TodoScope.workspace:
				this._workspaceTodos = payload.todos;
				this._todoCount.workspace = payload.numberOfTodos;
				this.workspaceLastAction.next(payload.lastActionType);
				break;
			case TodoScope.currentFile: {
				const currentFilePayload = payload as CurrentFileSlice;
				this._currentFileSlice = currentFilePayload;
				this._todoCount.currentFile = currentFilePayload.numberOfTodos;
				this._currentFilePathSource.next(currentFilePayload.filePath);
				this.currentFileLastAction.next(currentFilePayload.lastActionType);
				break;
			}
			default:
				throw new Error("Invalid action scope");
		}
	}

	get userTodos(): Todo[] {
		return this._userTodos;
	}

	get workspaceTodos(): Todo[] {
		return this._workspaceTodos;
	}

	get currentFileTodos(): Todo[] {
		return this._currentFileSlice.todos;
	}

	get todoCount(): TodoCount {
		return this._todoCount;
	}

	get config(): Config {
		return this._config;
	}

	get isPinned(): boolean {
		return this._currentFileSlice.isPinned;
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

	pinFile() {
		vscode.postMessage(messagesFromWebview.pinFile(TodoScope.currentFile));
	}
}
