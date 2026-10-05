import { Injectable, computed, signal } from "@angular/core";
import { BehaviorSubject, Subject } from "rxjs";
import {
	Message,
	MessageActionsToWebview,
	GitHubSyncInfo,
	McpStatus,
	SyncStatusInfo,
	messagesFromWebview,
	UserSyncMode,
	WorkspaceSyncMode,
} from "../../../../src/panels/message";
import {
	CurrentFileSlice,
	EditorFocusAndRecordsSlice,
	Todo,
	TodoCount,
	TodoFilesDataPaths,
	TodoScope,
	TodoSlice,
	ExportFormats,
	ImportFormats,
} from "../../../../src/todo/todoTypes";
import { vscode } from "../utilities/vscode";
import { environment } from "../../environments/environment";
import { Config } from "../../../../src/utilities/config";

export interface SelectionState {
	hasSelection: boolean;
	selectedCount: number;
	totalCount: number;
}

export type SelectionCommand =
	| "selectAll"
	| "deleteSelected"
	| "deleteCompleted"
	| "clearSelection";

/**
 * A composer add, as {@link TodoService.undeliveredAdds} hands it back. A late arrival is reported
 * on {@link TodoService.lateDeliveredAdds} with the same object, so the composer can tell which
 * of the texts it put back has turned out to be stored.
 */
export interface ComposerAdd {
	readonly scope: TodoScope;
	readonly text: string;
	/** For a per-file add, the file whose list it was sent to. */
	readonly filePath?: string;
}

/** A composer add sent to the host and not seen coming back yet; see {@link TodoService.addTodo}. */
interface UnconfirmedAdd {
	add: ComposerAdd;
	/** Whether the wait ran out and the text was handed back to the composer. */
	handedBack: boolean;
	timer: ReturnType<typeof setTimeout>;
}

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
		showTags: false,
		autoDeleteCompletedAfterDays: 0,
		collapsedPreviewLines: 1,
		webviewFontFamily: "",
		webviewFontSize: 0,
	};
	private _currentFilePathSource = new BehaviorSubject<string>("");
	private _workspaceFilesWithRecordsSource = new BehaviorSubject<
		{ filePath: string; todoNumber: number }[]
	>([]);
	private _filesDataPathsSource = new BehaviorSubject<TodoFilesDataPaths>({});
	private _enableWideViewSource = new BehaviorSubject<boolean>(this._config.enableWideView);
	private _showTagsSource = new BehaviorSubject<boolean>(this._config.showTags);

	private _enableWideViewAnimation = new BehaviorSubject<boolean>(false);

	private _isGitHubConnectedSource = new BehaviorSubject<boolean>(false);
	private _hasGistIdSource = new BehaviorSubject<boolean>(false);
	private _gitHubSyncInfoSource = new BehaviorSubject<GitHubSyncInfo>({
		isGitHubSyncEnabled: false,
		userSyncEnabled: false,
		workspaceSyncEnabled: false,
		// Seed values, replaced by the host's first updateGitHubSyncInfo. The PWA has only one
		// mode, so seeding a local one made the sync pill paint the "local" icon until
		// GistGateway.initialize() resolved — a cold start with a slow IndexedDB read briefly
		// showed a mode the PWA cannot be in.
		userSyncMode: environment.pwa ? "github" : "profile-local",
		workspaceSyncMode: environment.pwa ? "github" : "local",
		userFile: "user-todos.json",
		workspaceFile: "workspace-default.json",
		isWorkspaceOpen: true,
	});

	private _isSyncingSource = new BehaviorSubject<boolean>(false);
	/**
	 * Per-scope sync state, for the header's indicator. "offline" until the host says otherwise:
	 * in the extension that is a scope not in GitHub mode (where the indicator stays hidden), and
	 * in the PWA it is the moment before the first reconcile.
	 */
	private _syncStatusSource = new BehaviorSubject<SyncStatusInfo>({
		isSyncing: false,
		user: { status: "offline", canRetry: false },
		workspace: { status: "offline", canRetry: false },
	});
	private _nowSource = new BehaviorSubject<number>(Date.now());
	private _mcpStatusSource = new BehaviorSubject<McpStatus>({
		enabled: false,
		running: false,
		trusted: true,
		readOnly: true,
		transport: "streamableHttp",
		port: null,
	});

	private _selectionStateMap: Record<TodoScope, BehaviorSubject<SelectionState>> = {
		[TodoScope.user]: new BehaviorSubject<SelectionState>({
			hasSelection: false,
			selectedCount: 0,
			totalCount: 0,
		}),
		[TodoScope.workspace]: new BehaviorSubject<SelectionState>({
			hasSelection: false,
			selectedCount: 0,
			totalCount: 0,
		}),
		[TodoScope.currentFile]: new BehaviorSubject<SelectionState>({
			hasSelection: false,
			selectedCount: 0,
			totalCount: 0,
		}),
	};
	private _selectionCommandMap: Record<TodoScope, Subject<SelectionCommand>> = {
		[TodoScope.user]: new Subject<SelectionCommand>(),
		[TodoScope.workspace]: new Subject<SelectionCommand>(),
		[TodoScope.currentFile]: new Subject<SelectionCommand>(),
	};

	/** See {@link matchesLocalAdd}. */
	private _pendingLocalAdd: Record<TodoScope, { text: string; at: number } | null> = {
		[TodoScope.user]: null,
		[TodoScope.workspace]: null,
		[TodoScope.currentFile]: null,
	};
	/**
	 * How long a composer add stays claimable. The echo is normally immediate, but in the
	 * workspace scope the item can instead arrive on a later `loadData` — the data-file watcher
	 * and a gist reload both dispatch one — so the wait has to cover a sync round trip. Bounded
	 * so that a request the host silently refused cannot be claimed by something much later.
	 */
	private static readonly localAddTtlMs = 10_000;

	/**
	 * Composer adds sent and not yet seen in a list from the host, oldest first. Separate from
	 * {@link _pendingLocalAdd}: that one is for scrolling to the item and only remembers the
	 * latest add, while every add here has to be accounted for, since the composer has already
	 * cleared its text.
	 */
	private _unconfirmedAdds: Record<TodoScope, UnconfirmedAdd[]> = {
		[TodoScope.user]: [],
		[TodoScope.workspace]: [],
		[TodoScope.currentFile]: [],
	};
	/** Whether a list for the scope has arrived, which is what an incoming list is compared to. */
	private _hasList: Record<TodoScope, boolean> = {
		[TodoScope.user]: false,
		[TodoScope.workspace]: false,
		[TodoScope.currentFile]: false,
	};
	private readonly _undeliveredAdds = new Subject<ComposerAdd>();
	private readonly _lateDeliveredAdds = new Subject<ComposerAdd>();
	/**
	 * How long an add may go without coming back before its text is handed back. The echo is
	 * normally immediate; nothing comes back at all when the webview has lost its host, which a
	 * VS Code editor tab does when the extension host restarts underneath it.
	 */
	private static readonly addConfirmTimeoutMs = 5_000;
	/**
	 * How long a handed-back add is still recognised if it arrives after all. An extension host
	 * that another extension is blocking answers late rather than never, and without this the
	 * handed-back text would sit in the composer inviting a duplicate.
	 */
	private static readonly lateDeliveryWindowMs = 60_000;

	/**
	 * An add whose text was handed back to the composer because the host never confirmed it,
	 * so the text can be sent again rather than lost.
	 */
	readonly undeliveredAdds = this._undeliveredAdds.asObservable();
	/** A handed-back add that the host turned out to have stored after all. */
	readonly lateDeliveredAdds = this._lateDeliveredAdds.asObservable();

	private _activeEditorMap: Record<TodoScope, BehaviorSubject<number | null>> = {
		[TodoScope.user]: new BehaviorSubject<number | null>(null),
		[TodoScope.workspace]: new BehaviorSubject<number | null>(null),
		[TodoScope.currentFile]: new BehaviorSubject<number | null>(null),
	};

	private readonly _searchQuery = signal<string>("");

	readonly searchQuery = computed(() => this._searchQuery());
	readonly normalizedSearchQuery = computed(() => this._searchQuery().trim().toLowerCase());
	readonly isSearchActive = computed(() => this.normalizedSearchQuery().length > 0);

	enableWideView = this._enableWideViewSource.asObservable();
	showTags = this._showTagsSource.asObservable();
	enableWideViewAnimation = this._enableWideViewAnimation.asObservable();
	isGitHubConnected = this._isGitHubConnectedSource.asObservable();
	hasGistId = this._hasGistIdSource.asObservable();
	gitHubSyncInfo = this._gitHubSyncInfoSource.asObservable();
	isSyncing = this._isSyncingSource.asObservable();
	syncStatus = this._syncStatusSource.asObservable();
	now = this._nowSource.asObservable();
	mcpStatus = this._mcpStatusSource.asObservable();
	userLastAction = new BehaviorSubject<string>("");
	workspaceLastAction = new BehaviorSubject<string>("");
	currentFileLastAction = new BehaviorSubject<string>("");
	currentFilePath = this._currentFilePathSource.asObservable();
	workspaceFilesWithRecords = this._workspaceFilesWithRecordsSource.asObservable();
	filesDataPaths = this._filesDataPathsSource.asObservable();

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

	setSearchQuery(query: string): void {
		this._searchQuery.set(query);
	}

	clearSearchQuery(): void {
		this._searchQuery.set("");
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

		setInterval(() => {
			this._nowSource.next(Date.now());
		}, 60000);

		setTimeout(() => {
			vscode.postMessage({ type: "webview-ready" });
		}, 0);
	}

	private handleMessage(event: MessageEvent) {
		if (!vscode.isHostMessage(event)) {
			return;
		}
		const { data } = event;
		if (typeof data !== "object" || data === null) {
			return;
		}
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
			case MessageActionsToWebview.updateGitHubStatus:
				this.handleUpdateGitHubStatus(data.payload);
				break;
			case MessageActionsToWebview.updateGitHubSyncInfo:
				this.handleUpdateGitHubSyncInfo(data.payload);
				break;
			case MessageActionsToWebview.updateSyncStatus:
				this.handleUpdateSyncStatus(data.payload);
				break;
			case MessageActionsToWebview.updateMcpStatus:
				this.handleUpdateMcpStatus(data.payload);
				break;
			default:
				console.warn("Unhandled message type:", data.type);
		}
	}

	private handleReloadWebview(data: Message<MessageActionsToWebview.reloadWebview>) {
		this.confirmArrivedAdds(TodoScope.user, data.payload.user.todos);
		this.confirmArrivedAdds(TodoScope.workspace, data.payload.workspace.todos);
		this.confirmArrivedAdds(
			TodoScope.currentFile,
			data.payload.currentFile.todos,
			data.payload.currentFile.filePath
		);
		for (const scope of Object.values(TodoScope)) {
			this._hasList[scope] = true;
		}
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
		this._showTagsSource.next(this._config.showTags);
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
				this.confirmArrivedAdds(TodoScope.user, payload.todos);
				this._hasList.user = true;
				this._userTodos = payload.todos;
				this._todoCount.user = payload.numberOfTodos;
				this.userLastAction.next(payload.lastActionType);
				break;
			case TodoScope.workspace:
				this.confirmArrivedAdds(TodoScope.workspace, payload.todos);
				this._hasList.workspace = true;
				this._workspaceTodos = payload.todos;
				this._todoCount.workspace = payload.numberOfTodos;
				this.workspaceLastAction.next(payload.lastActionType);
				break;
			case TodoScope.currentFile: {
				const currentFilePayload = payload as CurrentFileSlice;
				this.confirmArrivedAdds(
					TodoScope.currentFile,
					currentFilePayload.todos,
					currentFilePayload.filePath
				);
				this._hasList.currentFile = true;
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
		this._filesDataPathsSource.next(payload.filesDataPaths ?? {});
	}

	private handleUpdateGitHubStatus(payload: { isConnected: boolean; hasGistId: boolean }) {
		this._isGitHubConnectedSource.next(payload.isConnected);
		this._hasGistIdSource.next(payload.hasGistId);
	}

	private handleUpdateGitHubSyncInfo(payload: GitHubSyncInfo) {
		this._gitHubSyncInfoSource.next(payload);
	}

	private handleUpdateSyncStatus(payload: SyncStatusInfo) {
		this._syncStatusSource.next(payload);
		// Kept as its own stream: the sync menu's spinner is deliberately scope-agnostic, so it
		// must not follow the current tab the way the indicator does.
		this._isSyncingSource.next(payload.isSyncing);
	}

	private handleUpdateMcpStatus(payload: McpStatus) {
		this._mcpStatusSource.next(payload);
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

	get isWorkspaceOpen(): boolean {
		return this._gitHubSyncInfoSource.getValue().isWorkspaceOpen;
	}

	/**
	 * Sends a composer add to the host and waits for it to come back in a list. One that does not
	 * come back within {@link addConfirmTimeoutMs} is reported on {@link undeliveredAdds}, so the
	 * composer can put the text back: it clears the box as soon as it sends, and posting gives no
	 * error when nothing receives the message. A webview that has lost its host still accepts
	 * input, so without this an add typed there was silently lost.
	 */
	addTodo(...args: Parameters<typeof messagesFromWebview.addTodo>) {
		const [scope, { text }] = args;
		this._pendingLocalAdd[scope] = { text: text.trim(), at: Date.now() };
		const add: ComposerAdd =
			scope === TodoScope.currentFile
				? { scope, text: text.trim(), filePath: this._currentFileSlice.filePath }
				: { scope, text: text.trim() };
		const entry: UnconfirmedAdd = {
			add,
			handedBack: false,
			timer: setTimeout(() => this.handBack(entry), TodoService.addConfirmTimeoutMs),
		};
		this._unconfirmedAdds[scope].push(entry);
		vscode.postMessage(messagesFromWebview.addTodo(...args));
	}

	private handBack(entry: UnconfirmedAdd): void {
		entry.handedBack = true;
		entry.timer = setTimeout(
			() => this.forgetUnconfirmedAdd(entry),
			TodoService.lateDeliveryWindowMs
		);
		this._undeliveredAdds.next(entry.add);
	}

	private forgetUnconfirmedAdd(entry: UnconfirmedAdd): void {
		const pending = this._unconfirmedAdds[entry.add.scope];
		const index = pending.indexOf(entry);
		if (index !== -1) {
			pending.splice(index, 1);
		}
	}

	/**
	 * Settles the composer adds that `incoming` carries, before it replaces the scope's list: items
	 * it has and the current list does not, with the text that was sent. Matched by what arrived
	 * rather than by the action name, for the reason {@link matchesLocalAdd} gives, and by a new
	 * id, so an existing item that reads the same does not settle it. Each arrival settles one add,
	 * oldest first.
	 *
	 * Only against a list of the same thing. Before the first list for the scope arrives, and for a
	 * per-file list of another file, every item in it is new, and one that happened to read the
	 * same would settle an add that was lost.
	 */
	private confirmArrivedAdds(scope: TodoScope, incoming: Todo[], incomingFilePath?: string): void {
		const pending = this._unconfirmedAdds[scope];
		if (pending.length === 0 || !this._hasList[scope]) {
			return;
		}
		if (scope === TodoScope.currentFile && incomingFilePath !== this._currentFileSlice.filePath) {
			return;
		}
		const known = new Set(this.getTodosInScope(scope).map((todo) => todo.id));
		for (const todo of incoming) {
			if (known.has(todo.id)) {
				continue;
			}
			const entry = pending.find(
				({ add }) => add.text === todo.text.trim() && add.filePath === incomingFilePath
			);
			if (!entry) {
				continue;
			}
			clearTimeout(entry.timer);
			this.forgetUnconfirmedAdd(entry);
			if (entry.handedBack) {
				this._lateDeliveredAdds.next(entry.add);
			}
		}
	}

	/**
	 * Whether `text` is the item this webview's composer just sent for `scope`.
	 *
	 * The action name cannot answer this on its own, in either direction. `todo_add_item` over
	 * MCP dispatches the very same `addTodo` and arrives as the same `"<scope>/addTodo"`, so
	 * without this an agent writing todos in the background would scroll the list out from under
	 * whoever is reading it. And in the workspace scope the item often does *not* arrive on its
	 * own slice at all — the data-file watcher and a gist reload each dispatch a `loadData`
	 * carrying it — so keying off the name alone missed the user's own add entirely.
	 *
	 * Matching what actually arrived covers both: an expired or absent request matches nothing,
	 * and someone else's add only matches if they wrote the same words within ten seconds, where
	 * scrolling to it is no worse than harmless.
	 */
	matchesLocalAdd(scope: TodoScope, text: string): boolean {
		const pending = this._pendingLocalAdd[scope];
		if (!pending) {
			return false;
		}
		if (Date.now() - pending.at > TodoService.localAddTtlMs) {
			this._pendingLocalAdd[scope] = null;
			return false;
		}
		return pending.text === text.trim();
	}

	/** {@link matchesLocalAdd}, and forgets the request so only one arrival can claim it. */
	claimLocalAdd(scope: TodoScope, text: string): boolean {
		if (!this.matchesLocalAdd(scope, text)) {
			return false;
		}
		this._pendingLocalAdd[scope] = null;
		return true;
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

	setTags(...args: Parameters<typeof messagesFromWebview.setTags>) {
		vscode.postMessage(messagesFromWebview.setTags(...args));
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

	setShowTagsEnabled(isEnabled: boolean) {
		this._config.showTags = isEnabled;
		this._showTagsSource.next(isEnabled);
		vscode.postMessage(messagesFromWebview.setShowTagsEnabled(isEnabled));
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
		const todos = this.getTodosInScope(scope);
		if (!todos.some((todo) => todo.completed && !todo.isNote)) {
			return;
		}

		this.emitSelectionCommand(scope, "deleteCompleted");
	}

	selectUserSyncMode() {
		vscode.postMessage(messagesFromWebview.selectUserSyncMode());
	}

	selectWorkspaceSyncMode() {
		vscode.postMessage(messagesFromWebview.selectWorkspaceSyncMode());
	}

	setUserSyncMode(mode: UserSyncMode) {
		vscode.postMessage(messagesFromWebview.setUserSyncMode(mode));
	}

	setWorkspaceSyncMode(mode: WorkspaceSyncMode) {
		vscode.postMessage(messagesFromWebview.setWorkspaceSyncMode(mode));
	}

	connectGitHub() {
		vscode.postMessage(messagesFromWebview.connectGitHub());
	}

	disconnectGitHub() {
		vscode.postMessage(messagesFromWebview.disconnectGitHub());
	}

	setUserFile() {
		vscode.postMessage(messagesFromWebview.setUserFile());
	}

	setWorkspaceFile() {
		vscode.postMessage(messagesFromWebview.setWorkspaceFile());
	}

	openGistIdSettings() {
		vscode.postMessage(messagesFromWebview.openGistIdSettings());
	}

	viewGistOnGitHub() {
		vscode.postMessage(messagesFromWebview.viewGistOnGitHub());
	}

	syncNow() {
		vscode.postMessage(messagesFromWebview.syncNow());
	}

	startMcpServer() {
		vscode.postMessage(messagesFromWebview.startMcpServer());
	}

	stopMcpServer() {
		vscode.postMessage(messagesFromWebview.stopMcpServer());
	}
}
