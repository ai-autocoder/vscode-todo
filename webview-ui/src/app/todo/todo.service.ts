import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import {
	Message,
	MessageActionsToWebview,
	messagesFromWebview,
} from "../../../../src/panels/message";
import {
	CurrentFileSlice,
	EditorFocusAndRecordsSlice,
	Todo,
	TodoCount,
	TodoScope,
	TodoSlice,
	ExportFormats,
	ImportFormats,
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
		createMarkdownByDefault: false,
		createPosition: "top",
		enableLineNumbers: false,
		enableWideView: false,
		autoDeleteCompletedAfterDays: 0,
	};
	private _currentFilePathSource = new BehaviorSubject<string>("");
	private _workspaceFilesWithRecordsSource = new BehaviorSubject<
		{ filePath: string; todoNumber: number }[]
	>([]);
	private _enableWideViewSource = new BehaviorSubject<boolean>(this._config.enableWideView);

	private _enableWideViewAnimation = new BehaviorSubject<boolean>(false);

	enableWideView = this._enableWideViewSource.asObservable();
	enableWideViewAnimation = this._enableWideViewAnimation.asObservable();
	userLastAction = new BehaviorSubject<string>("");
	workspaceLastAction = new BehaviorSubject<string>("");
	currentFileLastAction = new BehaviorSubject<string>("");
	currentFilePath = this._currentFilePathSource.asObservable();
	workspaceFilesWithRecords = this._workspaceFilesWithRecordsSource.asObservable();

	constructor() {
		window.addEventListener("message", this.handleMessage.bind(this));

		setTimeout(() => {
			vscode.postMessage({ type: "webview-ready" });
		}, 0);
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
			case MessageActionsToWebview.syncEditorFocusAndRecords:
				this.handleSyncEditorFocusAndRecords(data.payload);
				break;
			default:
				console.warn("Unhandled message type:", data.type);
		}
	}

	private handleReloadWebview(data: Message<MessageActionsToWebview.reloadWebview>) {
		this._config = data.config;
		this._userTodos = data.payload.user.todos;
		this._todoCount.user = data.payload.user.numberOfTodos;
		this._workspaceTodos = data.payload.workspace.todos;
		this._todoCount.workspace = data.payload.workspace.numberOfTodos;
		this._currentFileSlice = data.payload.currentFile;
		this._todoCount.currentFile = data.payload.currentFile.numberOfTodos;
		this._currentFilePathSource.next(data.payload.currentFile.filePath);
		this._enableWideViewSource.next(this._config.enableWideView);
		this.userLastAction.next("");
		this.workspaceLastAction.next("");
		this.currentFileLastAction.next("");
		this.handleSyncEditorFocusAndRecords(data.payload.editorFocusAndRecords);
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

	private handleSyncEditorFocusAndRecords(payload: EditorFocusAndRecordsSlice) {
		this._workspaceFilesWithRecordsSource.next(payload.workspaceFilesWithRecords);
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

	undoDelete(...args: Parameters<typeof messagesFromWebview.undoDelete>) {
		vscode.postMessage(messagesFromWebview.undoDelete(...args));
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

	setCurrentFile(filePath: string) {
		vscode.postMessage(
			messagesFromWebview.requestData(TodoScope.currentFile, {
				filePath,
			})
		);
	}

	import(format: ImportFormats) {
		vscode.postMessage(messagesFromWebview.import(format));
	}

	export(format: ExportFormats) {
		vscode.postMessage(messagesFromWebview.export(format));
	}

	setWideViewEnabled(isEnabled: boolean) {
		this._enableWideViewAnimation.next(true);
		this._config.enableWideView = isEnabled;
		this._enableWideViewSource.next(isEnabled);
		vscode.postMessage(messagesFromWebview.setWideViewEnabled(isEnabled));
	}

	deleteAll(scope: TodoScope) {
		vscode.postMessage(messagesFromWebview.deleteAll(scope));
	}

	deleteCompleted(scope: TodoScope) {
		vscode.postMessage(messagesFromWebview.deleteCompleted(scope));
	}
}
