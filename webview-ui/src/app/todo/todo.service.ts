import { Injectable } from "@angular/core";
import { BehaviorSubject, Subject } from "rxjs";
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

export interface SelectionState {
	hasSelection: boolean;
	selectedCount: number;
	totalCount: number;
}

export type SelectionCommand = "selectAll" | "deleteSelected" | "clearSelection";

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
		enableMarkdownDiagrams: true,
		enableMarkdownKatex: true,
		enableWideView: false,
		sync: {
			user: "profile-local",
		},
		autoDeleteCompletedAfterDays: 0,
		collapsedPreviewLines: 1,
		webviewFontFamily: "",
		webviewFontSize: 0,
	};
	private _currentFilePathSource = new BehaviorSubject<string>("");
	private _workspaceFilesWithRecordsSource = new BehaviorSubject<
		{ filePath: string; todoNumber: number }[]
	>([]);
	private _enableWideViewSource = new BehaviorSubject<boolean>(this._config.enableWideView);

	private _enableWideViewAnimation = new BehaviorSubject<boolean>(false);

	private _selectionStateMap: Record<TodoScope, BehaviorSubject<SelectionState>> = {
		[TodoScope.user]: new BehaviorSubject<SelectionState>({ hasSelection: false, selectedCount: 0, totalCount: 0 }),
		[TodoScope.workspace]: new BehaviorSubject<SelectionState>({ hasSelection: false, selectedCount: 0, totalCount: 0 }),
		[TodoScope.currentFile]: new BehaviorSubject<SelectionState>({ hasSelection: false, selectedCount: 0, totalCount: 0 }),
	};
	private _selectionCommandMap: Record<TodoScope, Subject<SelectionCommand>> = {
		[TodoScope.user]: new Subject<SelectionCommand>(),
		[TodoScope.workspace]: new Subject<SelectionCommand>(),
		[TodoScope.currentFile]: new Subject<SelectionCommand>(),
	};

	private _activeEditorMap: Record<TodoScope, BehaviorSubject<number | null>> = {
		[TodoScope.user]: new BehaviorSubject<number | null>(null),
		[TodoScope.workspace]: new BehaviorSubject<number | null>(null),
		[TodoScope.currentFile]: new BehaviorSubject<number | null>(null),
	};

	enableWideView = this._enableWideViewSource.asObservable();
	enableWideViewAnimation = this._enableWideViewAnimation.asObservable();
	userLastAction = new BehaviorSubject<string>("");
	workspaceLastAction = new BehaviorSubject<string>("");
	currentFileLastAction = new BehaviorSubject<string>("");
	currentFilePath = this._currentFilePathSource.asObservable();
	workspaceFilesWithRecords = this._workspaceFilesWithRecordsSource.asObservable();

	setSelectionState(scope: TodoScope, state: SelectionState): void {
		this._selectionStateMap[scope].next(state);
	}

	getSelectionState(scope: TodoScope) {
		return this._selectionStateMap[scope].asObservable();
	}

	emitSelectionCommand(scope: TodoScope, command: SelectionCommand): void {
		this._selectionCommandMap[scope].next(command);
	}

	selectionCommand(scope: TodoScope) {
		return this._selectionCommandMap[scope].asObservable();
	}


	setActiveEditor(scope: TodoScope, todoId: number): void {
		const subject = this._activeEditorMap[scope];
		if (subject.getValue() === todoId) {
			return;
		}
		subject.next(todoId);
	}

	clearActiveEditor(scope: TodoScope, expectedId?: number): void {
		const subject = this._activeEditorMap[scope];
		if (expectedId !== undefined && subject.getValue() !== expectedId) {
			return;
		}
		if (subject.getValue() === null) {
			return;
		}
		subject.next(null);
	}

	activeEditor(scope: TodoScope) {
		return this._activeEditorMap[scope].asObservable();
	}


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
		this.applyCssFontVars();
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

	private applyCssFontVars() {
		const root = document.documentElement.style;
		const family = (this._config.webviewFontFamily || "").trim();
		const size = this._config.webviewFontSize || 0;

		const effectiveFamily = family || "var(--vscode-font-family)";
		const effectiveSize = size > 0 ? `${size}px` : "var(--vscode-editor-font-size)";

		root.setProperty("--app-font-family", effectiveFamily);
		root.setProperty("--app-font-size", effectiveSize);
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

	toggleCollapsed(...args: Parameters<typeof messagesFromWebview.toggleCollapsed>) {
		vscode.postMessage(messagesFromWebview.toggleCollapsed(...args));
	}

	setAllCollapsed(...args: Parameters<typeof messagesFromWebview.setAllCollapsed>) {
		vscode.postMessage(messagesFromWebview.setAllCollapsed(...args));
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
		const totalTodos = this.getTodosInScope(scope).length;

		if (!totalTodos) {
			return;
		}

		this.emitSelectionCommand(scope, "selectAll");
		this.emitSelectionCommand(scope, "deleteSelected");
	}

	private getTodosInScope(scope: TodoScope): Todo[] {
		switch (scope) {
			case TodoScope.user:
				return this._userTodos;
			case TodoScope.workspace:
				return this._workspaceTodos;
			case TodoScope.currentFile:
				return this._currentFileSlice.todos;
			default:
				throw new Error("Invalid todo scope");
		}
	}

	deleteCompleted(scope: TodoScope) {
		vscode.postMessage(messagesFromWebview.deleteCompleted(scope));
	}
}
