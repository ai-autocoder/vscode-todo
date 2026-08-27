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
 * SCOPE: user, workspace and per-file (`currentFile`) todos are all wired end-to-end
 * (mutate → echo → reconcile → pull-on-focus). Per-file lists live inside the workspace gist
 * file's `filesData`, so a `currentFile` edit is written back there and pushed on the workspace
 * timer; `filesData` is always round-tripped even when nothing is selected, because the merge
 * would otherwise read a missing entry as a deletion. With no editor to follow, the selected
 * file changes only via the file list, which lists every path carrying todos in the gist.
 *
 * MCP and the VS Code-only commands (import/export dialogs, sync-mode pickers, gist-id
 * settings) are no-ops or open GitHub directly, since there is no extension host.
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
	isEqual,
	type GistFileInfo,
	type GistSummary,
	type GlobalGistData,
	type WorkspaceGistData,
	type ReducerConfig,
	type TodoSliceState,
	type TodoFilesData,
	type TodoFilesDataPaths,
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
 * (user enters the code on GitHub) → change-gist (the user always picks the gist) →
 * needs-files → connected.
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
	| { phase: "needs-gist" }
	| {
			/**
			 * The gist chooser. Reached right after login (the user always picks — nothing is
			 * auto-adopted), from the file picker, and from the connected state so a persisted
			 * gist can be changed later.
			 */
			phase: "change-gist";
			currentGistId: string;
			current?: GistSummary;
			gists: GistSummary[];
			busy?: boolean;
			message?: string;
	  }
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
	/**
	 * Whether the user has actually been through the workspace-file choice, as opposed to simply
	 * not having one. Without this, "I want no workspace list" is indistinguishable from "never
	 * asked", and the file picker either re-prompts forever or silently never syncs the workspace.
	 */
	private workspaceFileChosen = false;

	private readonly _connection = new BehaviorSubject<GistConnectionState>({
		phase: "disconnected",
	});
	/** Connection flow state for the PWA's connect screen. */
	readonly connection: Observable<GistConnectionState> = this._connection.asObservable();
	/** The gist currently in use, for screens that need to show which one is selected. */
	get currentGistId(): string | undefined {
		return this.gistId;
	}
	/** The files in use, so the picker can preselect them rather than defaulting to the first. */
	get currentUserFile(): string | undefined {
		return this.userFile;
	}
	get currentWorkspaceFile(): string | undefined {
		return this.workspaceFile;
	}
	private connectAbort: AbortController | undefined;

	private user = newUserSlice();
	private workspace = newWorkspaceSlice();

	/**
	 * Per-file todos from the workspace gist file, keyed by the path the extension recorded.
	 * These MUST be round-tripped even when the PWA shows none of them: `reconcileWorkspace`
	 * treats the local value as authoritative under the default prefer-local policy, so pushing
	 * `{}` would delete every per-file list the extension has stored.
	 */
	private filesData: TodoFilesData = {};
	private filesDataPaths: TodoFilesDataPaths = {};

	/**
	 * The file the UI is currently showing. There is no editor in the PWA, so unlike the
	 * extension (where it follows the active editor) it only changes when the user picks a file
	 * from the file list.
	 */
	private currentFile = newCurrentFileSlice();

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
		// "" means the user explicitly chose no workspace file; undefined means they never picked.
		// The distinction decides whether enterFileSelection can resume or must re-prompt.
		const storedWorkspaceFile = await this.tokenStore.getWorkspaceFile();
		this.workspaceFileChosen = storedWorkspaceFile !== undefined;
		this.workspaceFile = storedWorkspaceFile || undefined;
		if (this.gistId) {
			this.engine = this.createEngine(this.gistId);
			await this.rehydrateFromCache();
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
		// Same guard as ready(): without a chosen file there is nothing to reconcile, and the
		// file names may still belong to a gist the user is in the middle of switching away from.
		if (this.token && this.gistId && this.userFile) {
			await this.pullAll();
		}
	}

	// --- inbound message emitters ---

	/**
	 * The file list the UI's `<file-list>` renders, derived from `filesData`. The extension
	 * builds this from the files it has seen in the workspace; the PWA has no workspace on disk,
	 * so every file that carries todos in the gist is listed. Counts match the extension's
	 * (open, non-note todos). Sorted by path so the list is stable across pulls.
	 */
	private filesWithRecords(): Array<{ filePath: string; todoNumber: number }> {
		return Object.entries(this.filesData)
			.map(([filePath, todos]) => ({
				filePath,
				todoNumber: (todos ?? []).filter((t) => !t.completed && !t.isNote).length,
			}))
			.sort((a, b) => a.filePath.localeCompare(b.filePath));
	}

	private emitReload(): void {
		const editorFocusAndRecords: StoreState["editorFocusAndRecords"] = {
			editorFocusedFilePath: this.currentFile.filePath,
			workspaceFilesWithRecords: this.filesWithRecords(),
			filesDataPaths: this.filesDataPaths,
			lastActionType: "",
		};
		const payload: StoreState = {
			user: this.user,
			workspace: this.workspace,
			currentFile: this.currentFile,
			editorFocusAndRecords,
			actionTracker: { lastSliceName: "" as StoreState["actionTracker"]["lastSliceName"] },
		};
		this._messages.next({
			type: MessageActionsToWebview.reloadWebview,
			payload,
			config: this.config,
		});
	}

	private emitScope(scope: TodoScope): void {
		const slice =
			scope === TodoScope.user
				? this.user
				: scope === TodoScope.workspace
					? this.workspace
					: this.currentFile;
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
		this.userPushTimer = setTimeout(
			() => void this.enqueue(() => this.reconcileUser()),
			this.pushDebounceMs
		);
	}

	private scheduleWorkspacePush(): void {
		if (this.workspacePushTimer) {
			clearTimeout(this.workspacePushTimer);
		}
		this.workspacePushTimer = setTimeout(
			() => void this.enqueue(() => this.reconcileWorkspace()),
			this.pushDebounceMs
		);
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
				// Always adopt the reconciled data — it is what the engine just recorded as the
				// merge baseline. Keeping a different local list would make the next reconcile read
				// the difference as a local edit and push it over the gist.
				const changed = !isEqual({ todos: this.user.todos }, { todos: res.data.data.userTodos });
				this.user.todos = res.data.data.userTodos;
				if (changed) {
					this.user.lastActionType = "loadData";
					this.recount(this.user);
					this.emitScope(TodoScope.user);
					// The header's counts ride on the full state payload, so a pull that changed
					// the list has to refresh it too or the badge keeps the pre-pull number.
					this.emitReload();
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
			// Round-trip the per-file todos we last saw: the PWA never edits them, but sending
			// `{}` would make the merge treat them as locally deleted and wipe them from the gist.
			const local: WorkspaceGistData = {
				workspaceTodos: this.workspace.todos,
				filesData: this.filesData,
				filesDataPaths: this.filesDataPaths,
			};
			const res = await engine.reconcileWorkspace(fileName, local);
			if (res.success && res.data) {
				// Always adopt the reconciled data, even when nothing changed remotely: it is what
				// the engine just recorded as the merge baseline, so holding anything else here
				// would make the next reconcile read the difference as a local edit and push it.
				const merged = res.data.data;
				const workspaceChanged = !isEqual(
					{ todos: this.workspace.todos },
					{ todos: merged.workspaceTodos }
				);
				const filesChanged = !isEqual(this.filesData, merged.filesData);

				this.filesData = merged.filesData;
				this.filesDataPaths = merged.filesDataPaths ?? {};
				this.workspace.todos = merged.workspaceTodos;

				if (workspaceChanged) {
					this.workspace.lastActionType = "loadData";
					this.recount(this.workspace);
					this.emitScope(TodoScope.workspace);
				}
				// Per-file todos live in `filesData` and change independently of `workspaceTodos`,
				// so the open file is re-projected off its own comparison.
				if (filesChanged && this.currentFile.filePath) {
					this.currentFile = {
						...this.currentFile,
						todos: [...(this.filesData[this.currentFile.filePath] ?? [])],
						lastActionType: "loadData",
					};
					this.recount(this.currentFile);
					this.emitScope(TodoScope.currentFile);
				}
				if (workspaceChanged || filesChanged) {
					// File list / counts may have changed too.
					this.emitReload();
				}
			}
		} finally {
			this.emitSyncing(false);
		}
	}

	/**
	 * Restores the todos from the persisted sync cache before anything can reconcile.
	 *
	 * Not optional. The cache holds both the last known good data and the merge baseline, but
	 * only the connection settings were being restored on reload — so local state came up empty
	 * against a populated baseline, the reconcile read that as the user having deleted
	 * everything, and it pushed the empty state over the gist. Rehydrating keeps the two halves
	 * in step. Reconciles still run afterwards, so anything stale here is corrected by the pull.
	 */
	private async rehydrateFromCache(): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		if (this.userFile) {
			const cached = await engine.loadCachedUser(this.userFile);
			if (cached) {
				this.user.todos = cached.userTodos;
				this.recount(this.user);
			}
		}
		if (this.workspaceFile) {
			const cached = await engine.loadCachedWorkspace(this.workspaceFile);
			if (cached) {
				this.workspace.todos = cached.workspaceTodos;
				this.filesData = cached.filesData ?? {};
				this.filesDataPaths = cached.filesDataPaths ?? {};
				this.recount(this.workspace);
			}
		}
	}

	/**
	 * Builds the sync engine for a gist. Always goes through here so the IndexedDB-backed
	 * {@link cacheStore} is attached: without it the engine silently falls back to an in-memory
	 * store, every session starts with no merge baseline, and remote changes can never be told
	 * apart from local ones.
	 */
	private createEngine(gistId: string): GistSyncEngine {
		return new GistSyncEngine({ client: this.client, gistId, cacheStore: this.cacheStore });
	}

	/**
	 * Serializes every reconcile. The engine reads a file's cache, diffs, then writes it back;
	 * two overlapping runs would both read the same baseline and the later write would push
	 * against stale state. `ready()`, the focus handler and the debounced pushes can all fire at
	 * once, so the queue is not optional.
	 */
	private syncQueue: Promise<void> = Promise.resolve();

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.syncQueue = this.syncQueue.then(work, work);
		return this.syncQueue;
	}

	private async pullAll(): Promise<void> {
		await this.enqueue(async () => {
			await this.reconcileUser();
			await this.reconcileWorkspace();
		});
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
		} else if (scope === TodoScope.currentFile && this.currentFile.filePath) {
			fn(this.asSliceState(this.currentFile));
			// Per-file todos live inside the workspace gist file, so a currentFile edit is
			// written back into filesData and pushed on the workspace timer.
			this.filesData = { ...this.filesData, [this.currentFile.filePath]: this.currentFile.todos };
			this.recount(this.currentFile);
			this.emitScope(TodoScope.currentFile);
			this.scheduleWorkspacePush();
		}
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
		// Pinning exists to stop the list following the active editor. The PWA has no editor, so
		// the selection is already sticky and there is nothing to pin.
	}
	setCurrentFile(filePath: string): void {
		this.currentFile = {
			...newCurrentFileSlice(),
			filePath,
			todos: filePath ? [...(this.filesData[filePath] ?? [])] : [],
			lastActionType: "loadData",
		};
		this.recount(this.currentFile);
		this.emitScope(TodoScope.currentFile);
		this.emitReload();
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
	 * verification URL) → change-gist, where the user picks or creates the sync gist. Errors
	 * land in the "error" phase instead of throwing, so the UI can offer a retry.
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

			// The user always picks the gist; the PWA never discovers or infers one.
			await this.changeGist();
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
		if (this.gistId && this.gistId !== gistId) {
			await this.resetForNewGist();
		}
		this.gistId = gistId;
		await this.tokenStore.setGistId(gistId);
		this.engine = this.createEngine(gistId);
		this.emitGitHubStatus();
		this._connection.next(await this.enterFileSelection());
		this.emitSyncInfo();
	}

	/**
	 * Drops everything tied to the previous gist before switching. Clearing `cacheStore` is not
	 * optional: its per-file `lastCleanRemoteData` entries are the three-way-merge baselines, so
	 * keeping them would compare one gist's baseline against another gist's content and corrupt
	 * the merge. The file selections go too — they name files in the old gist.
	 */
	private async resetForNewGist(): Promise<void> {
		this.cancelPendingPushes();
		// Wait for any in-flight reconcile before clearing. Cache keys carry only the file name,
		// so a late write from the old gist would otherwise land in the cleared store and be read
		// back as the new gist's baseline — the exact corruption this reset exists to prevent.
		await this.enqueue(async () => {
			await this.cacheStore.clear();
		});
		this.userFile = undefined;
		this.workspaceFile = undefined;
		this.workspaceFileChosen = false;
		await this.tokenStore.clearFileSelections();
		this.user = newUserSlice();
		this.workspace = newWorkspaceSlice();
		this.filesData = {};
		this.filesDataPaths = {};
		this.currentFile = newCurrentFileSlice();
		this.emitReload();
	}

	private cancelPendingPushes(): void {
		if (this.userPushTimer) {
			clearTimeout(this.userPushTimer);
			this.userPushTimer = undefined;
		}
		if (this.workspacePushTimer) {
			clearTimeout(this.workspacePushTimer);
			this.workspacePushTimer = undefined;
		}
	}

	/**
	 * Enters the gist picker, listing the account's gists so the user can choose or create one.
	 * Every gist is offered regardless of its description — the PWA never infers which gist to
	 * use. Listing failures are non-fatal: pasting an id still works.
	 */
	async changeGist(): Promise<void> {
		const currentGistId = this.gistId ?? "";
		this._connection.next({
			phase: "change-gist",
			currentGistId,
			gists: [],
			busy: true,
		});
		const listed = await this.client.listGists();
		const gists = listed.success ? (listed.data ?? []) : [];
		const current = gists.find((g) => g.id === currentGistId);
		this._connection.next({
			phase: "change-gist",
			currentGistId,
			current,
			gists,
			message: listed.success ? undefined : listed.error?.message,
		});
	}

	/** Leaves the picker without changing anything. */
	async cancelChangeGist(): Promise<void> {
		this._connection.next(
			this.gistId && this.userFile
				? { phase: "connected", userFile: this.userFile, workspaceFile: this.workspaceFile }
				: await this.enterFileSelection()
		);
	}

	/**
	 * Dismisses the file picker, keeping the current selection. Only meaningful once a session
	 * exists — during first-time setup there is nothing to go back to, so the picker stays.
	 */
	cancelFileSelection(): void {
		if (this.gistId && this.userFile) {
			this._connection.next({
				phase: "connected",
				userFile: this.userFile,
				workspaceFile: this.workspaceFile,
			});
		}
	}

	/** True once a session exists, so the picker can offer Cancel rather than trapping the user. */
	get canCancelFileSelection(): boolean {
		return !!this.gistId && !!this.userFile;
	}

	/** Switches to an existing gist (from the list or a pasted id). */
	async selectGist(gistId: string): Promise<void> {
		const trimmed = gistId.trim();
		if (!GIST_ID_REGEX.test(trimmed)) {
			this.updateChangeGist({ message: "Invalid gist id — expected 32 hex characters." });
			return;
		}
		if (trimmed === this.gistId) {
			await this.cancelChangeGist();
			return;
		}
		this.updateChangeGist({ busy: true, message: undefined });
		const gist = await this.client.fetchGist(trimmed);
		if (!gist.success) {
			this.updateChangeGist({
				busy: false,
				message: gist.error?.message ?? "Could not open that gist.",
			});
			return;
		}
		await this.useGist(trimmed);
	}

	/**
	 * Creates a fresh secret sync gist and switches to it.
	 *
	 * The new gist is stamped with {@link SYNC_GIST_DESCRIPTION} purely for interop: the VS Code
	 * extension still finds its gist by description, so a differently-described one could never
	 * be picked up on that side. The PWA itself never reads the description — it only ever uses
	 * the gist the user selected.
	 */
	async createSyncGist(): Promise<void> {
		this.updateChangeGist({ busy: true, message: undefined });
		const seed: GlobalGistData = { userTodos: [] };
		const created = await this.client.createGist(
			SYNC_GIST_DESCRIPTION,
			{ [DefaultFileNames.user]: JSON.stringify(seed, null, 2) },
			false
		);
		if (!created.success || !created.data) {
			this.updateChangeGist({
				busy: false,
				message: created.error?.message ?? "Could not create the gist.",
			});
			return;
		}
		await this.useGist(created.data.id);
	}

	/** Patches the current change-gist state; ignored if the user has already moved on. */
	private updateChangeGist(patch: Partial<Extract<GistConnectionState, { phase: "change-gist" }>>): void {
		const state = this._connection.value;
		if (state.phase !== "change-gist") {
			return;
		}
		this._connection.next({ ...state, ...patch });
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
		// Resume only when the stored selection still matches the gist. A workspace file that is
		// no longer there (or was never chosen while the gist offers one) has to go back to the
		// picker: skipping it on the strength of the user file alone left the session permanently
		// connected with no workspace file, and no way to reach the picker to choose one.
		const userFileValid = !!this.userFile && users.some((f) => f.fullPath === this.userFile);
		const workspaceFileValid = this.workspaceFile
			? workspaces.some((f) => f.fullPath === this.workspaceFile)
			: this.workspaceFileChosen || workspaces.length === 0;
		if (userFileValid && workspaceFileValid) {
			return { phase: "connected", userFile: this.userFile!, workspaceFile: this.workspaceFile };
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
		// Persist unconditionally, including the empty string: writing only when a file was chosen
		// left a previous selection behind when the user picked "None", and left nothing stored at
		// all on the first run, so the workspace file never survived a reload.
		await this.tokenStore.setWorkspaceFile(this.workspaceFile ?? "");
		this.workspaceFileChosen = true;
		// A newly chosen workspace file has no cached baseline or todos on this device yet, so
		// load whatever a previous session stored for it before the first reconcile runs.
		await this.rehydrateFromCache();
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
		this.cancelPendingPushes();
		this.token = undefined;
		this.gistId = undefined;
		this.userFile = undefined;
		this.workspaceFile = undefined;
		this.workspaceFileChosen = false;
		this.engine = undefined;
		await this.tokenStore.clear();
		// Same ordering hazard as resetForNewGist: let any in-flight reconcile finish first.
		await this.enqueue(async () => {
			await this.cacheStore.clear();
		});
		this.user = newUserSlice();
		this.workspace = newWorkspaceSlice();
		this.filesData = {};
		this.filesDataPaths = {};
		this.currentFile = newCurrentFileSlice();
		this._connection.next({ phase: "disconnected" });
		this.emitReload();
		this.emitGitHubStatus();
		this.emitSyncInfo();
	}

	/**
	 * The header's "Change GitHub Gist list..." action, for both scopes.
	 *
	 * The extension opens a VS Code quick-pick per scope; the PWA has no host dialogs, so both
	 * route to the file picker that the connection flow already uses, which chooses the user and
	 * workspace files together. These were no-ops, so the menu item looked broken.
	 */
	setUserFile(): void {
		void this.enterFileSelectionFromApp();
	}
	setWorkspaceFile(): void {
		void this.enterFileSelectionFromApp();
	}

	/** Reopens the file picker from the connected app, surfacing any listing failure. */
	private async enterFileSelectionFromApp(): Promise<void> {
		const gistId = this.gistId;
		if (!gistId) {
			// No gist yet — the gist chooser is the right screen, and it leads to the file picker.
			await this.changeGist();
			return;
		}
		const [userFiles, workspaceFiles] = await Promise.all([
			this.client.listFiles(gistId, "user"),
			this.client.listFiles(gistId, "workspace"),
		]);
		if (!userFiles.success || !workspaceFiles.success) {
			this._connection.next({
				phase: "error",
				message:
					userFiles.error?.message ?? workspaceFiles.error?.message ?? "Failed to list gist files.",
			});
			return;
		}
		this._connection.next({
			phase: "needs-files",
			userFiles: userFiles.data ?? [],
			workspaceFiles: workspaceFiles.data ?? [],
		});
	}
	openGistIdSettings(): void {
		// No VS Code settings in the PWA — the header's "Gist: Set ID" action opens the picker,
		// which is the only way to change a gist once one has been persisted.
		void this.changeGist();
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
