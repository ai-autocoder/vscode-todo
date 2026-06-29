/**
 * GistGateway — the {@link DataGateway} for the standalone PWA.
 *
 * Instead of talking to a VS Code extension host, it drives `@vsc-todo/core`'s
 * {@link GistSyncEngine} directly from the browser and keeps an in-memory copy of the
 * `user`/`workspace` slices that mirrors what the extension would push. Commands mutate that
 * local state with the **shared** {@link todoMutations} (the same logic the extension's Redux
 * reducers use — ported into core so the two can't drift), echo the change to the UI via a
 * `syncTodoData` message, and schedule a debounced reconcile to the gist.
 *
 * Inbound `messages` reproduces the extension→webview protocol the UI already understands:
 * `reloadWebview` (full initial state), `syncTodoData` (per-scope updates),
 * `updateGitHubStatus`/`updateGitHubSyncInfo`/`updateSyncStatus` (connection + sync state).
 *
 * SCOPE OF THIS FIRST VERSION: user-scope todos are wired end-to-end (mutate → echo →
 * reconcile → pull-on-focus). Workspace mutations apply locally and reconcile too, but the
 * richer workspace file-list UI (`filesData` grouping, file discovery) is Phase 5. MCP and the
 * VS Code-only commands (import/export dialogs, sync-mode pickers, gist-id settings) are
 * no-ops or open GitHub directly, since there is no extension host.
 */

import { Observable, Subject } from "rxjs";
import {
	GistClient,
	GistSyncEngine,
	DeviceFlowClient,
	IndexedDbCacheStore,
	IndexedDbTokenStore,
	SYNC_GIST_DESCRIPTION,
	DefaultFileNames,
	type GlobalGistData,
	type WorkspaceGistData,
	type ReducerConfig,
	type TodoSliceState,
	todoMutations,
} from "@vsc-todo/core";
import {
	CurrentFileSlice,
	StoreState,
	Todo,
	TodoScope,
	TodoSlice,
} from "../../../../src/todo/todoTypes";
import {
	MessageActionsToWebview,
	messagesFromWebview,
	GitHubSyncInfo,
} from "../../../../src/panels/message";
import { Config } from "../../../../src/utilities/config";
import type { DataGateway, InboundMessage } from "./data-gateway";

/** Runtime configuration for the PWA's GitHub access (supplied by the PWA environment). */
export interface GistGatewayConfig {
	/** Public GitHub OAuth App client id (Device Flow enabled). */
	clientId: string;
	/** Base URL of the CORS proxy Worker that forwards the device-flow POSTs to github.com. */
	deviceFlowProxyUrl: string;
	/** Optional UI defaults; falls back to the same defaults the extension ships. */
	config?: Partial<Config>;
	/** Debounce window for pushing local edits to the gist (ms). Defaults to 3000. */
	pushDebounceMs?: number;
}

const DEFAULT_CONFIG: Config = {
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

const newUserSlice = (): TodoSlice => ({
	todos: [],
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
	scope: TodoScope.user,
});

const newWorkspaceSlice = (): TodoSlice => ({
	todos: [],
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
	scope: TodoScope.workspace,
});

const newCurrentFileSlice = (): CurrentFileSlice => ({
	filePath: "",
	isPinned: false,
	todos: [],
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
	scope: TodoScope.currentFile,
});

export class GistGateway implements DataGateway {
	private readonly _messages = new Subject<InboundMessage>();
	readonly messages: Observable<InboundMessage> = this._messages.asObservable();

	private readonly config: Config;
	private readonly reducerConfig: ReducerConfig;
	private readonly pushDebounceMs: number;

	private readonly tokenStore = new IndexedDbTokenStore();
	private readonly cacheStore = new IndexedDbCacheStore();
	private readonly client: GistClient;
	private readonly deviceFlow: DeviceFlowClient;
	private engine: GistSyncEngine | undefined;

	private token: string | undefined;
	private gistId: string | undefined;
	private userFile = DefaultFileNames.user;
	private workspaceFile = DefaultFileNames.workspace("default");

	private user = newUserSlice();
	private workspace = newWorkspaceSlice();

	private userPushTimer: ReturnType<typeof setTimeout> | undefined;
	private workspacePushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: GistGatewayConfig) {
		this.config = { ...DEFAULT_CONFIG, ...opts.config };
		this.reducerConfig = {
			createPosition: this.config.createPosition,
			createMarkdownByDefault: this.config.createMarkdownByDefault,
			taskSortingOptions: this.config.taskSortingOptions,
		};
		this.pushDebounceMs = opts.pushDebounceMs ?? 3000;

		this.client = new GistClient({ getToken: () => this.token });
		this.deviceFlow = new DeviceFlowClient({
			clientId: opts.clientId,
			proxyBaseUrl: opts.deviceFlowProxyUrl,
		});
	}

	// --- lifecycle ---

	async ready(): Promise<void> {
		this.token = await this.tokenStore.getToken();
		this.gistId = await this.tokenStore.getGistId();
		if (this.gistId) {
			this.engine = new GistSyncEngine({ client: this.client, gistId: this.gistId });
		}
		this.emitReload();
		this.emitGitHubStatus();
		this.emitSyncInfo();
		if (this.token && this.gistId) {
			void this.pullAll();
		}
	}

	/** Re-pull on regaining focus (the extension polls; the PWA pulls on focus to stay cheap). */
	async refresh(): Promise<void> {
		if (this.token && this.gistId) {
			await this.pullAll();
		}
	}

	// --- inbound message emitters ---

	private emitReload(): void {
		const editorFocusAndRecords: StoreState["editorFocusAndRecords"] = {
			editorFocusedFilePath: "",
			workspaceFilesWithRecords: [],
			filesDataPaths: {},
			lastActionType: "",
		};
		const payload: StoreState = {
			user: this.user,
			workspace: this.workspace,
			currentFile: newCurrentFileSlice(),
			editorFocusAndRecords,
			actionTracker: { lastSliceName: "" as StoreState["actionTracker"]["lastSliceName"] },
		};
		this._messages.next({
			type: MessageActionsToWebview.reloadWebview,
			payload,
			config: this.config,
		});
	}

	private emitScope(scope: TodoScope.user | TodoScope.workspace): void {
		const slice = scope === TodoScope.user ? this.user : this.workspace;
		this._messages.next({
			type: MessageActionsToWebview.syncTodoData,
			payload: slice,
		});
	}

	private emitGitHubStatus(): void {
		this._messages.next({
			type: MessageActionsToWebview.updateGitHubStatus,
			payload: { isConnected: !!this.token, hasGistId: !!this.gistId },
		});
	}

	private emitSyncInfo(): void {
		const info: GitHubSyncInfo = {
			isGitHubSyncEnabled: !!this.token && !!this.gistId,
			userSyncEnabled: !!this.token && !!this.gistId,
			workspaceSyncEnabled: !!this.token && !!this.gistId,
			userSyncMode: "github",
			workspaceSyncMode: "github",
			userFile: this.userFile,
			workspaceFile: this.workspaceFile,
			isWorkspaceOpen: true,
		};
		this._messages.next({ type: MessageActionsToWebview.updateGitHubSyncInfo, payload: info });
	}

	private emitSyncing(isSyncing: boolean): void {
		this._messages.next({
			type: MessageActionsToWebview.updateSyncStatus,
			payload: { isSyncing },
		});
	}

	// --- sync ---

	private asSliceState(slice: TodoSlice): TodoSliceState {
		return slice; // structural: TodoSlice already has todos/lastActionType/counts
	}

	private scheduleUserPush(): void {
		if (this.userPushTimer) {
			clearTimeout(this.userPushTimer);
		}
		this.userPushTimer = setTimeout(() => void this.reconcileUser(), this.pushDebounceMs);
	}

	private scheduleWorkspacePush(): void {
		if (this.workspacePushTimer) {
			clearTimeout(this.workspacePushTimer);
		}
		this.workspacePushTimer = setTimeout(() => void this.reconcileWorkspace(), this.pushDebounceMs);
	}

	private async reconcileUser(): Promise<void> {
		if (!this.engine) {
			return;
		}
		this.emitSyncing(true);
		try {
			const local: GlobalGistData = { userTodos: this.user.todos };
			const res = await this.engine.reconcileUser(this.userFile, local);
			if (res.success && res.data) {
				if (res.data.changedRemotely) {
					this.user.todos = res.data.data.userTodos;
					this.user.lastActionType = "loadData";
					this.recount(this.user);
					this.emitScope(TodoScope.user);
				}
			}
		} finally {
			this.emitSyncing(false);
		}
	}

	private async reconcileWorkspace(): Promise<void> {
		if (!this.engine) {
			return;
		}
		this.emitSyncing(true);
		try {
			// Phase 5 will carry real filesData; for now the PWA owns only workspaceTodos.
			const local: WorkspaceGistData = {
				workspaceTodos: this.workspace.todos,
				filesData: {},
				filesDataPaths: {},
			};
			const res = await this.engine.reconcileWorkspace(this.workspaceFile, local);
			if (res.success && res.data && res.data.changedRemotely) {
				this.workspace.todos = res.data.data.workspaceTodos;
				this.workspace.lastActionType = "loadData";
				this.recount(this.workspace);
				this.emitScope(TodoScope.workspace);
			}
		} finally {
			this.emitSyncing(false);
		}
	}

	private async pullAll(): Promise<void> {
		await this.reconcileUser();
		await this.reconcileWorkspace();
	}

	private recount(slice: TodoSlice): void {
		slice.numberOfTodos = slice.todos.filter((t) => !t.completed && !t.isNote).length;
		slice.numberOfNotes = slice.todos.filter((t) => t.isNote).length;
	}

	/** Apply a mutation to the right scope's slice, echo to the UI, and schedule a push. */
	private mutate(scope: TodoScope, fn: (state: TodoSliceState) => void): void {
		if (scope === TodoScope.user) {
			fn(this.asSliceState(this.user));
			this.emitScope(TodoScope.user);
			this.scheduleUserPush();
		} else if (scope === TodoScope.workspace) {
			fn(this.asSliceState(this.workspace));
			this.emitScope(TodoScope.workspace);
			this.scheduleWorkspacePush();
		}
		// currentFile scope is Phase 5 (file-specific lists).
	}

	// --- item commands ---

	addTodo(scope: TodoScope, payload: { text: string; position?: "top" | "bottom" }): void {
		this.mutate(scope, (s) => todoMutations.addTodo(s, payload, this.reducerConfig));
	}
	deleteTodo(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.deleteTodo(s, payload));
	}
	undoDelete(scope: TodoScope, payload: Parameters<typeof todoMutations.undoDelete>[1]): void {
		this.mutate(scope, (s) => todoMutations.undoDelete(s, payload));
	}
	toggleTodo(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleTodo(s, payload, this.reducerConfig));
	}
	editTodo(scope: TodoScope, payload: { id: number; newText: string }): void {
		this.mutate(scope, (s) => todoMutations.editTodo(s, payload));
	}
	setTags(scope: TodoScope, payload: { id: number; tags: string[] }): void {
		this.mutate(scope, (s) => todoMutations.setTags(s, payload));
	}
	reorderTodos(scope: TodoScope, payload: { reorderedTodos: Todo[] }): void {
		this.mutate(scope, (s) => todoMutations.reorderTodo(s, payload, this.reducerConfig));
	}
	toggleMarkdown(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleMarkdown(s, payload));
	}
	toggleTodoNote(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleTodoNote(s, payload, this.reducerConfig));
	}
	toggleCollapsed(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleCollapsed(s, payload));
	}
	setAllCollapsed(scope: TodoScope, payload: { collapsed: boolean }): void {
		this.mutate(scope, (s) => todoMutations.setAllCollapsed(s, payload));
	}

	// --- file / view commands ---

	pinFile(): void {
		/* no file scope in the PWA yet (Phase 5) */
	}
	setCurrentFile(_filePath: string): void {
		/* Phase 5 */
	}
	import(_format: unknown): void {
		/* No host file dialogs in the PWA; import/export UI is out of scope for now. */
	}
	export(_format: unknown): void {
		/* see import() */
	}
	setWideViewEnabled(isEnabled: boolean): void {
		this.config.enableWideView = isEnabled;
	}
	setShowTagsEnabled(isEnabled: boolean): void {
		this.config.showTags = isEnabled;
	}

	// --- sync / GitHub commands ---

	selectUserSyncMode(): void {
		/* PWA is always GitHub-backed; no mode picker. */
	}
	selectWorkspaceSyncMode(): void {
		/* see above */
	}
	setUserSyncMode(): void {
		/* see above */
	}
	setWorkspaceSyncMode(): void {
		/* see above */
	}

	/**
	 * Runs the GitHub Device Flow, persists the token, auto-discovers the sync gist by its
	 * description, and pulls. Surfaces progress/identity through the existing status messages.
	 */
	async connectGitHub(): Promise<void> {
		const code = await this.deviceFlow.requestDeviceCode();
		// The connection UI (next sub-step) listens for this to show the user code; for now we
		// open GitHub's verification page so the flow is usable even before that UI lands.
		window.open(code.verification_uri, "_blank", "noopener");
		const token = await this.deviceFlow.pollForToken(code.device_code, code.interval);

		this.token = token;
		await this.tokenStore.setToken(token);
		this.emitGitHubStatus();

		const found = await this.client.findGistByDescription(SYNC_GIST_DESCRIPTION);
		if (found.success && found.data) {
			this.gistId = found.data.id;
			await this.tokenStore.setGistId(this.gistId);
			this.engine = new GistSyncEngine({ client: this.client, gistId: this.gistId });
		}
		this.emitGitHubStatus();
		this.emitSyncInfo();
		await this.pullAll();
	}

	async disconnectGitHub(): Promise<void> {
		this.token = undefined;
		this.gistId = undefined;
		this.engine = undefined;
		await this.tokenStore.clear();
		await this.cacheStore.clear();
		this.user = newUserSlice();
		this.workspace = newWorkspaceSlice();
		this.emitReload();
		this.emitGitHubStatus();
		this.emitSyncInfo();
	}

	setUserFile(): void {
		/* File picker UI is part of the connection flow (next sub-step). */
	}
	setWorkspaceFile(): void {
		/* see above */
	}
	openGistIdSettings(): void {
		/* No VS Code settings in the PWA; the connection UI owns gist selection. */
	}
	viewGistOnGitHub(): void {
		if (this.gistId) {
			window.open(this.client.getGistUrl(this.gistId), "_blank", "noopener");
		}
	}
	syncNow(): void {
		void this.pullAll();
	}

	// --- MCP (no host) ---
	startMcpServer(): void {
		/* not applicable in the PWA */
	}
	stopMcpServer(): void {
		/* not applicable in the PWA */
	}
}
