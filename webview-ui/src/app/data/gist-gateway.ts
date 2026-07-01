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

import { BehaviorSubject, Observable, Subject } from "rxjs";
import {
	GistClient,
	GistSyncEngine,
	DeviceFlowClient,
	DeviceFlowError,
	IndexedDbCacheStore,
	IndexedDbTokenStore,
	SYNC_GIST_DESCRIPTION,
	DefaultFileNames,
	GIST_ID_REGEX,
	type GistFileInfo,
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

/**
 * The connection flow as a state machine, driven by {@link GistGateway.connectGitHub} /
 * {@link GistGateway.submitGistId} / {@link GistGateway.chooseFiles} and observed by the PWA's
 * connect screen. Phases advance: disconnected → requesting-code → awaiting-authorization
 * (user enters the code on GitHub) → discovering → (needs-gist →) needs-files → connected.
 */
export type GistConnectionState =
	| { phase: "disconnected" }
	| { phase: "requesting-code" }
	| {
			phase: "awaiting-authorization";
			userCode: string;
			verificationUri: string;
			expiresIn: number;
	  }
	| { phase: "discovering" }
	| { phase: "needs-gist" }
	| { phase: "needs-files"; userFiles: GistFileInfo[]; workspaceFiles: GistFileInfo[] }
	| { phase: "connected"; userFile: string; workspaceFile?: string }
	| { phase: "error"; message: string };

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
	private userFile: string | undefined;
	private workspaceFile: string | undefined;

	private readonly _connection = new BehaviorSubject<GistConnectionState>({
		phase: "disconnected",
	});
	/** Connection flow state for the PWA's connect screen. */
	readonly connection: Observable<GistConnectionState> = this._connection.asObservable();
	private connectAbort: AbortController | undefined;

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

	/**
	 * Restores a persisted session (token + gist + file selections) and reports the resulting
	 * connection phase. The PWA shell calls this once at startup to decide whether to show the
	 * connect screen or the app.
	 */
	async restoreSession(): Promise<GistConnectionState> {
		this.token = await this.tokenStore.getToken();
		this.gistId = await this.tokenStore.getGistId();
		this.userFile = await this.tokenStore.getUserFile();
		this.workspaceFile = await this.tokenStore.getWorkspaceFile();
		if (this.gistId) {
			this.engine = new GistSyncEngine({ client: this.client, gistId: this.gistId });
		}

		let state: GistConnectionState;
		if (!this.token) {
			state = { phase: "disconnected" };
		} else if (!this.gistId) {
			state = { phase: "needs-gist" };
		} else if (!this.userFile) {
			state = await this.enterFileSelection();
		} else {
			state = { phase: "connected", userFile: this.userFile, workspaceFile: this.workspaceFile };
		}
		this._connection.next(state);
		this.emitGitHubStatus();
		this.emitSyncInfo();
		return state;
	}

	async ready(): Promise<void> {
		this.emitReload();
		this.emitGitHubStatus();
		this.emitSyncInfo();
		if (this.token && this.gistId && this.userFile) {
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
		const configured = !!this.token && !!this.gistId && !!this.userFile;
		const info: GitHubSyncInfo = {
			isGitHubSyncEnabled: configured,
			userSyncEnabled: configured,
			workspaceSyncEnabled: configured && !!this.workspaceFile,
			userSyncMode: "github",
			workspaceSyncMode: "github",
			userFile: this.userFile ?? DefaultFileNames.user,
			workspaceFile: this.workspaceFile ?? "",
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
		const engine = this.engine;
		const fileName = this.userFile;
		if (!engine || !fileName) {
			return;
		}
		this.emitSyncing(true);
		try {
			const local: GlobalGistData = { userTodos: this.user.todos };
			const res = await engine.reconcileUser(fileName, local);
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
		const engine = this.engine;
		const fileName = this.workspaceFile;
		if (!engine || !fileName) {
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
			const res = await engine.reconcileWorkspace(fileName, local);
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
	 * Runs the GitHub Device Flow, advancing {@link connection} through the phases the connect
	 * screen renders: requesting-code → awaiting-authorization (shows `user_code` +
	 * verification URL) → discovering → needs-gist | needs-files. Errors land in the "error"
	 * phase instead of throwing, so the UI can offer a retry.
	 */
	async connectGitHub(): Promise<void> {
		this.connectAbort?.abort();
		this.connectAbort = new AbortController();
		try {
			this._connection.next({ phase: "requesting-code" });
			const code = await this.deviceFlow.requestDeviceCode();
			this._connection.next({
				phase: "awaiting-authorization",
				userCode: code.user_code,
				verificationUri: code.verification_uri,
				expiresIn: code.expires_in,
			});
			const token = await this.deviceFlow.pollForToken(code.device_code, code.interval, {
				signal: this.connectAbort.signal,
			});

			this.token = token;
			await this.tokenStore.setToken(token);
			this.emitGitHubStatus();

			this._connection.next({ phase: "discovering" });
			const found = await this.client.findGistByDescription(SYNC_GIST_DESCRIPTION);
			if (found.success && found.data) {
				await this.useGist(found.data.id);
			} else {
				this._connection.next({ phase: "needs-gist" });
			}
		} catch (error) {
			if (error instanceof DeviceFlowError && error.code === "cancelled") {
				this._connection.next({ phase: "disconnected" });
				return;
			}
			const message = error instanceof Error ? error.message : "Connection failed.";
			this._connection.next({ phase: "error", message });
		}
	}

	/** Aborts an in-progress device-flow authorization and returns to the disconnected phase. */
	cancelConnect(): void {
		this.connectAbort?.abort();
	}

	/** Manual gist selection (paste the 32-hex id) for when auto-discovery finds nothing. */
	async submitGistId(gistId: string): Promise<void> {
		const trimmed = gistId.trim();
		if (!GIST_ID_REGEX.test(trimmed)) {
			this._connection.next({ phase: "error", message: "Invalid gist id — expected 32 hex characters." });
			return;
		}
		const gist = await this.client.fetchGist(trimmed);
		if (!gist.success) {
			this._connection.next({
				phase: "error",
				message: gist.error?.message ?? "Could not open that gist.",
			});
			return;
		}
		await this.useGist(trimmed);
	}

	/** Persists the gist id, then moves to file selection (or straight to connected). */
	private async useGist(gistId: string): Promise<void> {
		this.gistId = gistId;
		await this.tokenStore.setGistId(gistId);
		this.engine = new GistSyncEngine({ client: this.client, gistId });
		this.emitGitHubStatus();
		this._connection.next(await this.enterFileSelection());
		this.emitSyncInfo();
	}

	/**
	 * Lists the gist's `user-*`/`workspace-*` files. If a previously chosen user file is still
	 * present the session resumes as connected; otherwise the picker phase is returned.
	 */
	private async enterFileSelection(): Promise<GistConnectionState> {
		const gistId = this.gistId;
		if (!gistId) {
			return { phase: "needs-gist" };
		}
		const [userFiles, workspaceFiles] = await Promise.all([
			this.client.listFiles(gistId, "user"),
			this.client.listFiles(gistId, "workspace"),
		]);
		if (!userFiles.success || !workspaceFiles.success) {
			return {
				phase: "error",
				message: userFiles.error?.message ?? workspaceFiles.error?.message ?? "Failed to list gist files.",
			};
		}
		const users = userFiles.data ?? [];
		const workspaces = workspaceFiles.data ?? [];
		if (this.userFile && users.some((f) => f.fullPath === this.userFile)) {
			return { phase: "connected", userFile: this.userFile, workspaceFile: this.workspaceFile };
		}
		return { phase: "needs-files", userFiles: users, workspaceFiles: workspaces };
	}

	/**
	 * Persists the chosen files and completes the connection. A user file that doesn't exist
	 * yet is fine — the sync engine seeds missing files on first reconcile. Pass an empty
	 * workspace file to sync the user list only.
	 */
	async chooseFiles(userFile: string, workspaceFile?: string): Promise<void> {
		this.userFile = userFile || DefaultFileNames.user;
		await this.tokenStore.setUserFile(this.userFile);
		this.workspaceFile = workspaceFile || undefined;
		if (this.workspaceFile) {
			await this.tokenStore.setWorkspaceFile(this.workspaceFile);
		}
		this._connection.next({
			phase: "connected",
			userFile: this.userFile,
			workspaceFile: this.workspaceFile,
		});
		this.emitGitHubStatus();
		this.emitSyncInfo();
		await this.pullAll();
	}

	async disconnectGitHub(): Promise<void> {
		this.connectAbort?.abort();
		this.token = undefined;
		this.gistId = undefined;
		this.userFile = undefined;
		this.workspaceFile = undefined;
		this.engine = undefined;
		await this.tokenStore.clear();
		await this.cacheStore.clear();
		this.user = newUserSlice();
		this.workspace = newWorkspaceSlice();
		this._connection.next({ phase: "disconnected" });
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
