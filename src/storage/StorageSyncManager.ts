import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { Buffer } from "node:buffer";
import LogChannel from "../utilities/LogChannel";
import {
	currentFileActions,
	editorFocusAndRecordsActions,
	userActions,
	workspaceActions,
} from "../todo/store";
import {
	CurrentFileSlice,
	StoreState,
	Todo,
	TodoFilesChange,
	TodoFilesData,
	TodoFilesDataPaths,
	TodoFilesState,
	TodoScope,
	TodoSlice,
} from "../todo/todoTypes";
import {
	ensureFilesDataPaths,
	getRelativePathIfInsideWorkspace,
	getWorkspacePath,
	getWorkspaceFilesWithRecords,
	isEqual,
	resolveFilesDataKey,
	sortByFileName,
	upsertFilesDataPathEntry,
} from "../todo/todoUtils";
import { SyncStorageManager } from "../sync/SyncStorageManager";
import {
	GlobalGistData,
	GlobalSyncMode,
	WorkspaceGistData,
	WorkspaceSyncMode,
} from "../sync/syncTypes";
import type { SyncedStore } from "../sync/SyncManager";

type WorkspacePersistedData = {
	workspaceTodos: Todo[];
	filesData: TodoFilesData;
	filesDataPaths: TodoFilesDataPaths;
};

type GlobalPersistedData = {
	userTodos: Todo[];
};

/**
 * The two storages persists write to. The workspace scope and the per-file lists share one: both
 * write `workspaceData.json`, each carrying the other's half from `cachedWorkspaceData`, and in
 * GitHub mode the same gist cache entry.
 */
type PersistStorage = "user" | "workspace";

/** The `globalState` keys VS Code Settings Sync carries in Profile Sync mode. */
const PROFILE_SYNC_KEYS: readonly string[] = ["TodoData"];

/**
 * How often Profile Sync mode looks for a user list that Settings Sync delivered. VS Code updates
 * the memento in place and raises no event, so it has to be looked at. A look that finds the
 * object this window last saw does nothing; any other object is compared by content, which is
 * what keeps this window's own writes from being reloaded, since VS Code hands back a copy.
 */
const PROFILE_SYNC_CHECK_INTERVAL_MS = 2000;

/**
 * `files` with `fileState`'s list stored under the file's key, or removed when the list is
 * empty, and the file's path aliases recorded. Returns new maps and leaves `files` untouched.
 */
function withFileTodos(files: TodoFilesState, fileState: CurrentFileSlice): TodoFilesState {
	const filesData = { ...files.filesData };
	const filesDataPaths = ensureFilesDataPaths(filesData, files.filesDataPaths, getWorkspacePath());
	const resolved = resolveFilesDataKey({
		filePath: fileState.filePath,
		filesData,
		filesDataPaths,
	});
	const primaryKey = resolved.key ?? fileState.filePath;

	filesData[primaryKey] = fileState.todos;
	const sorted = sortByFileName(filesData);
	if (fileState.todos.length === 0) {
		delete sorted[primaryKey];
		delete filesDataPaths[primaryKey];
	} else {
		upsertFilesDataPathEntry({
			filesDataPaths,
			primaryKey,
			absPath: fileState.filePath,
			relPath: getRelativePathIfInsideWorkspace(fileState.filePath),
		});
	}
	return { filesData: sorted, filesDataPaths };
}

export default class StorageSyncManager implements SyncedStore {
	private readonly workspaceDataFileName = "workspaceData.json";
	private readonly globalDataFileName = "globalData.json";
	private workspaceDataUri: vscode.Uri | undefined;
	private globalDataUri: vscode.Uri | undefined;
	private readonly suppressedScopes = new Set<TodoScope>();
private cachedWorkspaceData: WorkspacePersistedData = {
	workspaceTodos: [],
	filesData: {},
	filesDataPaths: {},
};
	private cachedGlobalData: GlobalPersistedData = { userTodos: [] };
	/**
	 * The `globalState.TodoData` value this window last wrote or loaded. A different object there
	 * means Settings Sync or another window has replaced it; see {@link checkSyncedUserTodos}.
	 */
	private seenUserTodoData: unknown;
	/** User-scope persists accepted and not yet finished; see {@link loadSyncedUserTodos}. */
	private pendingUserPersists = 0;
	/**
	 * Whether this window last knew the mode as Profile Sync: from activation, the file watcher or
	 * the last look for a changed `TodoData`.
	 */
	private watchedProfileSync = false;
	private syncStorageManager: SyncStorageManager;
	/** Tail of each storage's writes in progress; see {@link exclusive}. */
	private readonly writeTails: Record<PersistStorage, Promise<void>> = {
		user: Promise.resolve(),
		workspace: Promise.resolve(),
	};
	/** Per-file changes accepted but not yet started, oldest first; see {@link updateFiles}. */
	private readonly queuedFilesChanges: TodoFilesChange[] = [];
	private readonly filesUpdated = new vscode.EventEmitter<void>();
	/**
	 * Fires when a change from {@link updateFiles} has changed the stored lists. A slice persist
	 * does not fire it. For a store edit the store subscriber schedules the push itself; an MCP
	 * write to a file that is not shown persists a slice outside the store, and nothing
	 * schedules its push.
	 */
	public readonly onDidUpdateFiles = this.filesUpdated.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: EnhancedStore<StoreState>
	) {
		this.syncStorageManager = new SyncStorageManager(context);
	}

	public async initialize(): Promise<void> {
		this.updateKeysForSync();
		await this.ensureGlobalStorageInitialized();
		await this.ensureWorkspaceStorageInitialized();
		this.registerWatchers();
	}

	/**
	 * Call after the user sync mode changes. The user list is registered with Settings Sync only
	 * while in Profile Sync mode: registered only at activation, choosing Profile Sync did nothing
	 * until a restart, and leaving it kept uploading this machine's list over the other machines'.
	 *
	 * Leaving Profile Sync, the list is taken from `TodoData`, which can be ahead of this window
	 * when Settings Sync has delivered a list the next look has not loaded yet, and
	 * `globalData.json`, which the other modes load, is written from it: in Profile Sync a list
	 * loaded from `TodoData` does not reach the file. Leaving another mode, the file is already
	 * the newest copy, since a Local write reaches it before other windows' `TodoData`, and
	 * writing this window's `TodoData` over it could undo another window's edit. Nothing is
	 * written to `TodoData`: entering Profile Sync must not upload a list this window failed to
	 * load.
	 *
	 * @param previousMode the user sync mode before the change
	 */
	public async userSyncModeChanged(previousMode: string): Promise<void> {
		this.updateKeysForSync();
		if (previousMode !== "profile-sync") {
			return;
		}
		await this.exclusive("user", async () => {
			this.takeUserTodoData();
			const onDisk = await this.tryReadGlobalData();
			if (!onDisk || !isEqual(onDisk.userTodos, this.cachedGlobalData.userTodos)) {
				await this.writeGlobalData(this.cachedGlobalData);
			}
		});
	}

	/**
	 * Takes the user list from `TodoData`. Returns whether that changed the list this window
	 * held; the store and the file are left to the caller.
	 */
	private takeUserTodoData(): boolean {
		const stored = this.context.globalState.get<unknown>("TodoData");
		if (!Array.isArray(stored)) {
			return false;
		}
		this.seenUserTodoData = stored;
		const changed = !isEqual(stored, this.cachedGlobalData.userTodos);
		this.updateGlobalCache({ userTodos: stored as Todo[] });
		return changed;
	}

	private updateKeysForSync(): void {
		const globalState = this.context.globalState;
		if (typeof globalState.setKeysForSync === "function") {
			globalState.setKeysForSync(this.isProfileSync() ? PROFILE_SYNC_KEYS : []);
		}
	}

	public async getWorkspaceTodos(): Promise<Todo[]> {
		const workspaceSyncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (workspaceSyncMode === "github") {
			const workspaceMode = WorkspaceSyncMode.GitHub;
			const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
			const workspaceName = vscode.workspace.name || "default";
			const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
			return await this.syncStorageManager.getWorkspaceTodos(workspaceMode, fileName);
		}

		return this.cachedWorkspaceData.workspaceTodos;
	}

	public async getWorkspaceFilesData(): Promise<TodoFilesData> {
		const workspaceSyncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (workspaceSyncMode === "github") {
			const workspaceMode = WorkspaceSyncMode.GitHub;
			const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
			const workspaceName = vscode.workspace.name || "default";
			const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
			return await this.syncStorageManager.getFilesData(workspaceMode, fileName);
		}

		return this.cachedWorkspaceData.filesData;
	}

	public async getWorkspaceFilesDataPaths(): Promise<TodoFilesDataPaths> {
		const workspaceSyncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (workspaceSyncMode === "github") {
			const workspaceMode = WorkspaceSyncMode.GitHub;
			const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
			const workspaceName = vscode.workspace.name || "default";
			const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
			return await this.syncStorageManager.getFilesDataPaths(workspaceMode, fileName);
		}

		return this.cachedWorkspaceData.filesDataPaths;
	}

	public async getUserTodos(): Promise<Todo[]> {
		const userSyncMode = this.context.globalState.get<string>("syncMode", "profile-local");

		if (userSyncMode === "github") {
			const globalMode = GlobalSyncMode.GitHub;
			const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
			const fileName = config.get<string>("github.userFile", "user-todos.json");
			return await this.syncStorageManager.getGlobalTodos(globalMode, fileName);
		}

		return this.cachedGlobalData.userTodos;
	}

	public suppressNextPersistForScope(scope: TodoScope): void {
		this.suppressedScopes.add(scope);
	}

	/**
	 * Stores a slice. Resolves when the write has finished, or was suppressed or failed (a
	 * failure is logged, never thrown).
	 *
	 * Persists run one at a time per storage (see {@link exclusive}). Each one reads what is
	 * stored, changes it and writes it back, and they overlap: the store subscriber does not
	 * wait for its persist, and concurrent MCP calls each wait only for their own. When two
	 * overlapped, both read the same state and the later write dropped the earlier one's change.
	 * Two agent calls that added to `x.ts` and `y.ts` both reported success, and only `y.ts` was
	 * stored. A per-file slice is stored through {@link updateFiles}.
	 */
	public async persistSlice(state: TodoSlice | CurrentFileSlice): Promise<void> {
		if (this.suppressedScopes.has(state.scope)) {
			this.suppressedScopes.delete(state.scope);
			return;
		}

		// Where the write goes is settled now, with the edit: a mode switch while it waits must
		// not send it to the other mode's storage.
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const userSyncMode = this.context.globalState.get<string>("syncMode", "profile-local");
		const workspaceSyncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (state.scope === TodoScope.currentFile) {
			const fileState = state as CurrentFileSlice;
			return this.queueFilesChange(
				(files) => withFileTodos(files, fileState),
				config,
				workspaceSyncMode
			);
		}

		if (state.scope !== TodoScope.user) {
			return this.exclusive("workspace", () =>
				this.writeSlice(state, config, userSyncMode, workspaceSyncMode)
			);
		}
		this.pendingUserPersists++;
		return this.exclusive("user", async () => {
			try {
				await this.writeSlice(state, config, userSyncMode, workspaceSyncMode);
			} finally {
				this.pendingUserPersists--;
			}
		});
	}

	/**
	 * Applies `change` to the per-file lists and stores the result. Resolves when the write has
	 * finished or failed (a failure is logged, never thrown). Every change to the per-file lists
	 * goes through here: a slice persist, and a file rename, delete or import.
	 *
	 * The lists are kept in more than one place: the `TodoFilesData` memento, which the rest of
	 * the extension reads, and the storage this writes (`workspaceData.json` and its cache, or
	 * in GitHub mode the gist cache). A write rebuilds the lists from the storage, not the
	 * memento, so a change made only to the memento was undone by the next per-file persist.
	 * Renaming the open file therefore deleted its list, left it under the old name or kept it
	 * under both, depending on which file the next persist was for.
	 *
	 * `change` is applied twice. At the call it is applied to the memento, before anything is
	 * awaited, because a tab switch and the MCP tools read the memento and write back what they
	 * read: a tab switch that read the old list while the change waited its turn would persist
	 * the old list after it. In its turn in the write queue it is applied to the storage.
	 */
	public updateFiles(change: TodoFilesChange): Promise<void> {
		return this.queueFilesChange(
			change,
			vscode.workspace.getConfiguration("vscodeTodo.sync"),
			this.context.workspaceState.get<string>("syncMode", "local"),
			() => this.filesUpdated.fire()
		);
	}

	private queueFilesChange(
		change: TodoFilesChange,
		config: vscode.WorkspaceConfiguration,
		workspaceSyncMode: string,
		onStored?: () => void
	): Promise<void> {
		try {
			this.showFiles(change(this.shownFiles())).catch((error: unknown) =>
				this.logShowFilesFailure(error)
			);
			// Only once its result is shown: queued changes are replayed over each memento write.
			this.queuedFilesChanges.push(change);
		} catch (error) {
			this.logShowFilesFailure(error);
		}

		return this.exclusive("workspace", async () => {
			const index = this.queuedFilesChanges.indexOf(change);
			if (index !== -1) {
				this.queuedFilesChanges.splice(index, 1);
			}
			if (await this.writeFiles(change, config, workspaceSyncMode)) {
				onStored?.();
			}
		});
	}

	// ---------------------------------------------------------------------------
	// The store side of a GitHub sync; see `SyncedStore` in SyncManager.ts.
	// ---------------------------------------------------------------------------

	public async whenIdle<T>(storage: PersistStorage, read: () => T): Promise<T> {
		for (;;) {
			const tail = this.writeTails[storage];
			await tail;
			// Every `exclusive` call replaces the tail, so an unchanged one means nothing was
			// queued while this waited. `read` runs now, in the same turn as the check.
			if (tail === this.writeTails[storage]) {
				return read();
			}
		}
	}

	public shownUser(fileName: string): GlobalGistData | undefined {
		if (!this.showsGistFile("user", fileName)) {
			return undefined;
		}
		return { userTodos: this.store.getState().user.todos };
	}

	public shownWorkspace(fileName: string): WorkspaceGistData | undefined {
		if (!this.showsGistFile("workspace", fileName)) {
			return undefined;
		}
		// Copied: a sync holds this across awaits as the base of its fold, and the memento hands
		// out the object it holds.
		const files = JSON.parse(JSON.stringify(this.shownFiles())) as TodoFilesState;
		return {
			workspaceTodos: this.store.getState().workspace.todos,
			filesData: files.filesData,
			filesDataPaths: files.filesDataPaths,
		};
	}

	public showUser(
		fileName: string,
		fold: (shown: GlobalGistData) => GlobalGistData | undefined
	): Promise<GlobalGistData | undefined> {
		const shown = this.shownUser(fileName);
		const data = shown && fold(shown);
		if (!data) {
			return Promise.resolve(undefined);
		}
		const todos = JSON.parse(JSON.stringify(data.userTodos)) as Todo[];
		this.suppressNextPersistForScope(TodoScope.user);
		this.store.dispatch(userActions.loadData({ data: todos }));
		return this.exclusive("user", async () => {
			const stored = await this.syncStorageManager.getGlobalTodos(GlobalSyncMode.GitHub, fileName);
			if (!isEqual(stored, todos)) {
				await this.syncStorageManager.setGlobalTodos(GlobalSyncMode.GitHub, todos, fileName);
			}
		}).then(() => data);
	}

	/**
	 * Workspace counterpart of {@link showUser}, for the workspace slice, the per-file lists and
	 * the open file's slice. The per-file lists go through {@link queueFilesChange}, so the memento
	 * holds them at once and the gist cache in their turn, like any other change to them.
	 *
	 * The path aliases are stored as the gist has them, in the memento too, since one change
	 * writes both. Completed with `ensureFilesDataPaths`, as the editor-focus slice gets them, they
	 * would differ from the baseline and push after every pull. What completing adds is each
	 * primary key's own paths, which resolving a file's key matches anyway.
	 */
	public showWorkspace(
		fileName: string,
		fold: (shown: WorkspaceGistData) => WorkspaceGistData | undefined
	): Promise<WorkspaceGistData | undefined> {
		const shown = this.shownWorkspace(fileName);
		const data = shown && fold(shown);
		if (!data) {
			return Promise.resolve(undefined);
		}
		const copy = JSON.parse(JSON.stringify(data)) as WorkspaceGistData;
		const files: TodoFilesState = {
			filesData: sortByFileName(copy.filesData ?? {}),
			filesDataPaths: copy.filesDataPaths ?? {},
		};

		this.suppressNextPersistForScope(TodoScope.workspace);
		this.store.dispatch(workspaceActions.loadData({ data: copy.workspaceTodos }));
		const filesStored = this.queueFilesChange(
			() => ({ filesData: { ...files.filesData }, filesDataPaths: { ...files.filesDataPaths } }),
			vscode.workspace.getConfiguration("vscodeTodo.sync"),
			"github"
		);

		const filesDataPaths = ensureFilesDataPaths(
			files.filesData,
			files.filesDataPaths,
			getWorkspacePath()
		);
		this.store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords({
				workspaceFilesWithRecords: getWorkspaceFilesWithRecords(files.filesData),
				filesDataPaths,
			})
		);
		const state = this.store.getState();
		const targetFilePath =
			state.currentFile.filePath || state.editorFocusAndRecords.editorFocusedFilePath;
		if (targetFilePath) {
			const resolved = resolveFilesDataKey({
				filePath: targetFilePath,
				filesData: files.filesData,
				filesDataPaths,
			});
			this.suppressNextPersistForScope(TodoScope.currentFile);
			this.store.dispatch(
				currentFileActions.loadData({
					filePath: targetFilePath,
					data: resolved.key ? files.filesData[resolved.key] ?? [] : [],
				})
			);
		}

		const todosStored = this.exclusive("workspace", async () => {
			const stored = await this.syncStorageManager.getWorkspaceTodos(
				WorkspaceSyncMode.GitHub,
				fileName
			);
			if (!isEqual(stored, copy.workspaceTodos)) {
				await this.syncStorageManager.setWorkspaceTodos(
					WorkspaceSyncMode.GitHub,
					copy.workspaceTodos,
					fileName
				);
			}
		});
		return Promise.all([filesStored, todosStored]).then(() => data);
	}

	/**
	 * Whether the store shows the gist file `fileName` for the scope. It does not once the scope
	 * has left GitHub mode or moved to another file, and a sync started before either must not
	 * load its result over the list the store shows instead.
	 */
	private showsGistFile(scope: "user" | "workspace", fileName: string): boolean {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		if (scope === "user") {
			return (
				this.context.globalState.get<string>("syncMode", "profile-local") === "github" &&
				config.get<string>("github.userFile", "user-todos.json") === fileName
			);
		}
		const workspaceName = vscode.workspace.name || "default";
		const shownFile =
			config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
		return (
			this.context.workspaceState.get<string>("syncMode", "local") === "github" &&
			shownFile === fileName
		);
	}

	/**
	 * Returns whether the change altered the stored lists, including when storing them then
	 * failed part way: the gist cache may already hold half of it.
	 */
	private async writeFiles(
		change: TodoFilesChange,
		config: vscode.WorkspaceConfiguration,
		workspaceSyncMode: string
	): Promise<boolean> {
		let changed = false;
		try {
			const workspaceMode = WorkspaceSyncMode.GitHub;
			const workspaceName = vscode.workspace.name || "default";
			const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
			// In GitHub mode the gist cache is the base, not the memento: a pull writes the cache
			// first and the memento only once the store reloads. `SyncStorageManager` returns
			// copies, so a sync holding the cache's data as its snapshot is not affected.
			const base: TodoFilesState =
				workspaceSyncMode === "github"
					? {
							filesData: await this.syncStorageManager.getFilesData(workspaceMode, fileName),
							filesDataPaths: await this.syncStorageManager.getFilesDataPaths(
								workspaceMode,
								fileName
							),
						}
					: {
							filesData: this.cachedWorkspaceData.filesData,
							filesDataPaths: this.cachedWorkspaceData.filesDataPaths,
						};
			const stored = change(base);

			this.updateWorkspaceCache({
				workspaceTodos: this.cachedWorkspaceData.workspaceTodos,
				...stored,
			});
			// Changes still queued behind this one have already put their results in the memento
			// (see queueFilesChange); writing only this one's result would hide them until their
			// turn.
			await this.showFiles(
				this.queuedFilesChanges.reduce((files, queued) => queued(files), stored)
			);

			// A change that left the lists as they were has nothing to store. Renaming a file
			// that has no list must not rewrite the storage, nor, in GitHub mode, leave the gist
			// cache marked as owing a push.
			if (
				isEqual(base.filesData, stored.filesData) &&
				isEqual(base.filesDataPaths, stored.filesDataPaths)
			) {
				return false;
			}
			changed = true;

			if (workspaceSyncMode === "github") {
				// Write to gist cache
				await this.syncStorageManager.setFilesData(workspaceMode, stored.filesData, fileName);
				await this.syncStorageManager.setFilesDataPaths(
					workspaceMode,
					stored.filesDataPaths,
					fileName
				);
			} else {
				// Write to local file
				await this.writeWorkspaceData({
					workspaceTodos: this.cachedWorkspaceData.workspaceTodos,
					...stored,
				});
			}
			return true;
		} catch (error) {
			LogChannel.log(
				`[StorageSync] Failed to persist the per-file lists: ${this.describeError(error)}`
			);
			return changed;
		}
	}

	private async writeSlice(
		state: TodoSlice,
		config: vscode.WorkspaceConfiguration,
		userSyncMode: string,
		workspaceSyncMode: string
	): Promise<void> {
		try {
			switch (state.scope) {
				case TodoScope.user: {
					if (userSyncMode === "github") {
						// Write to gist cache. `TodoData` keeps the profile's own list, the one Profile
						// Sync mode loads and uploads, so the gist list does not go there.
						const globalMode = GlobalSyncMode.GitHub;
						const fileName = config.get<string>("github.userFile", "user-todos.json");
						await this.syncStorageManager.setGlobalTodos(globalMode, state.todos, fileName);
					} else {
						// Write to local file. The cache takes the list first: a failed file write
						// must not leave it behind `TodoData`, which a reload would then undo.
						this.updateGlobalCache({ userTodos: state.todos });
						await this.setUserTodoData(state.todos);
						await this.writeGlobalData({ userTodos: state.todos });
					}
					break;
				}
				case TodoScope.workspace: {
					await this.context.workspaceState.update("TodoData", state.todos);

					if (workspaceSyncMode === "github") {
						// Write to gist cache
						const workspaceMode = WorkspaceSyncMode.GitHub;
						const workspaceName = vscode.workspace.name || "default";
						const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
						await this.syncStorageManager.setWorkspaceTodos(workspaceMode, state.todos, fileName);
					} else {
						// Write to local file
						await this.writeWorkspaceData({
							workspaceTodos: state.todos,
							filesData: this.cachedWorkspaceData.filesData,
							filesDataPaths: this.cachedWorkspaceData.filesDataPaths,
						});
					}
					break;
				}
				default:
					break;
			}
		} catch (error) {
			LogChannel.log(
				`[StorageSync] Failed to persist ${state.scope} data: ${this.describeError(error)}`
			);
		}
	}

	private logShowFilesFailure(error: unknown): void {
		LogChannel.log(
			`[StorageSync] Failed to update the per-file lists: ${this.describeError(error)}`
		);
	}

	/** A storage file watcher's callback: runs `handler` in the storage's write queue. */
	private onStorageFileEvent(storage: PersistStorage, handler: () => Promise<void>): () => void {
		return () => {
			// The queue's tail swallows failures to keep the queue going, so log them here.
			this.exclusive(storage, handler).catch((error: unknown) =>
				LogChannel.log(
					`[StorageSync] Failed to handle a change to the ${storage} data file: ${this.describeError(error)}`
				)
			);
		};
	}

	/**
	 * Runs `work` once every write to `storage` queued before it has finished: persists, and
	 * the storage file watchers, which read the file and write the cache and the mementos. A
	 * watcher running between a persist's cache update and its file write would read the older
	 * file as an outside change and load it over the edit.
	 */
	private exclusive(storage: PersistStorage, work: () => Promise<void>): Promise<void> {
		const run = this.writeTails[storage].then(work);
		this.writeTails[storage] = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	/** The per-file lists as the rest of the extension reads them: the memento. */
	private shownFiles(): TodoFilesState {
		return {
			filesData: this.context.workspaceState.get<TodoFilesData>("TodoFilesData") ?? {},
			filesDataPaths:
				this.context.workspaceState.get<TodoFilesDataPaths>("TodoFilesDataPaths") ?? {},
		};
	}

	/**
	 * Replaces the memento's per-file lists. A VS Code memento holds the new value as soon as
	 * `update` is called, so readers see it at once; the promise resolves when VS Code's storage
	 * has accepted it. Not `async`, so a value `update` refuses throws at the call.
	 */
	private showFiles(files: TodoFilesState): Promise<unknown> {
		return Promise.all([
			this.context.workspaceState.update("TodoFilesData", files.filesData),
			this.context.workspaceState.update("TodoFilesDataPaths", files.filesDataPaths),
		]);
	}

	/**
	 * Loads the user list. In Profile Sync mode it comes from `globalState.TodoData`, the key
	 * Settings Sync carries, and `globalData.json` is rewritten from it. That file is this
	 * machine's alone, so it is older whenever another machine has changed the list since this one
	 * last ran; loading it and writing it over `TodoData` handed Settings Sync this machine's old
	 * list to upload, and the other machine's change was lost on both. Every other mode loads the
	 * file, as before. `TodoData` is taken before the storage directory is touched, in every
	 * mode, so a failure there leaves the list it holds rather than an empty one for the next edit
	 * to store, or for Profile Sync to upload.
	 */
	private async ensureGlobalStorageInitialized(): Promise<void> {
		const stored = this.context.globalState.get<unknown>("TodoData");
		if (Array.isArray(stored)) {
			this.updateGlobalCache({ userTodos: stored as Todo[] });
		}
		const synced = this.syncedUserTodos();
		this.seenUserTodoData = synced;
		this.watchedProfileSync = synced !== undefined;

		try {
			const globalRoot = this.context.globalStorageUri;
			await vscode.workspace.fs.createDirectory(globalRoot);
			this.globalDataUri = vscode.Uri.joinPath(globalRoot, this.globalDataFileName);
			const existing = await this.tryReadGlobalData();

			if (synced) {
				if (!existing || !isEqual(existing.userTodos, synced)) {
					await this.writeGlobalData({ userTodos: synced });
				}
				return;
			}

			if (existing) {
				this.updateGlobalCache(existing);
			} else {
				const initialData: GlobalPersistedData = {
					userTodos: this.cachedGlobalData.userTodos,
				};
				this.updateGlobalCache(initialData);
				await this.writeGlobalData(initialData);
			}

			await this.setUserTodoData(this.cachedGlobalData.userTodos);
		} catch (error) {
			LogChannel.log(
				`[StorageSync] Failed to prepare global storage: ${this.describeError(error)}`
			);
		}
	}

	private async ensureWorkspaceStorageInitialized(): Promise<void> {
		const workspaceRoot = this.context.storageUri;
		if (!workspaceRoot) {
			const rawFilesData = sortByFileName(
				(this.context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {}
			);
			const rawFilesDataPaths =
				(this.context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) ?? {};
			const filesDataPaths = ensureFilesDataPaths(
				rawFilesData,
				rawFilesDataPaths,
				getWorkspacePath()
			);
			this.updateWorkspaceCache({
				workspaceTodos: (this.context.workspaceState.get("TodoData") as Todo[]) ?? [],
				filesData: rawFilesData,
				filesDataPaths,
			});
			void this.context.workspaceState.update("TodoFilesDataPaths", filesDataPaths);
			LogChannel.log(
				"[StorageSync] Workspace storage path not available. Workspace sync is disabled."
			);
			return;
		}

		try {
			await vscode.workspace.fs.createDirectory(workspaceRoot);
			this.workspaceDataUri = vscode.Uri.joinPath(workspaceRoot, this.workspaceDataFileName);
			const existing = await this.tryReadWorkspaceData();

			if (existing) {
				const filesDataPaths = ensureFilesDataPaths(
					existing.filesData,
					existing.filesDataPaths,
					getWorkspacePath()
				);
				this.updateWorkspaceCache({
					workspaceTodos: existing.workspaceTodos,
					filesData: existing.filesData,
					filesDataPaths,
				});
			} else {
				const initialData: WorkspacePersistedData = {
					workspaceTodos: (this.context.workspaceState.get("TodoData") as Todo[]) ?? [],
					filesData: sortByFileName(
						(this.context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {}
					),
					filesDataPaths: ensureFilesDataPaths(
						sortByFileName(
							(this.context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {}
						),
						(this.context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) ?? {},
						getWorkspacePath()
					),
				};
				this.updateWorkspaceCache(initialData);
				await this.writeWorkspaceData(initialData);
			}

			await this.context.workspaceState.update("TodoData", this.cachedWorkspaceData.workspaceTodos);
			await this.context.workspaceState.update(
				"TodoFilesData",
				this.cachedWorkspaceData.filesData
			);
			await this.context.workspaceState.update(
				"TodoFilesDataPaths",
				this.cachedWorkspaceData.filesDataPaths
			);
		} catch (error) {
			LogChannel.log(
				`[StorageSync] Failed to prepare workspace storage: ${this.describeError(error)}`
			);
		}
	}

	private registerWatchers(): void {
		if (this.workspaceDataUri && this.context.storageUri) {
			const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(this.context.storageUri, this.workspaceDataFileName)
			);
			const onChange = this.onStorageFileEvent("workspace", () =>
				this.handleWorkspaceFileChange()
			);
			this.context.subscriptions.push(
				workspaceWatcher,
				workspaceWatcher.onDidChange(onChange),
				workspaceWatcher.onDidCreate(onChange),
				workspaceWatcher.onDidDelete(
					this.onStorageFileEvent("workspace", () => this.handleWorkspaceFileDelete())
				)
			);
		}

		if (this.globalDataUri) {
			const globalWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(this.context.globalStorageUri, this.globalDataFileName)
			);
			const onChange = this.onStorageFileEvent("user", () => this.handleGlobalFileChange());
			this.context.subscriptions.push(
				globalWatcher,
				globalWatcher.onDidChange(onChange),
				globalWatcher.onDidCreate(onChange),
				globalWatcher.onDidDelete(
					this.onStorageFileEvent("user", () => this.handleGlobalFileDelete())
				)
			);
		}
	}

	private async handleWorkspaceFileChange(): Promise<void> {
		const data = await this.tryReadWorkspaceData();
		if (!data) {
			return;
		}

		const filesDataPaths = ensureFilesDataPaths(
			data.filesData,
			data.filesDataPaths,
			getWorkspacePath()
		);
		const normalizedData: WorkspacePersistedData = {
			workspaceTodos: data.workspaceTodos,
			filesData: data.filesData,
			filesDataPaths,
		};

		// Our own writes arrive here too, after they finish. Running in the write queue, they
		// find the file equal to the cache.
		if (this.isSameWorkspaceData(this.cachedWorkspaceData, normalizedData)) {
			return;
		}

		this.updateWorkspaceCache(normalizedData);
		await this.context.workspaceState.update("TodoData", this.cachedWorkspaceData.workspaceTodos);
		await this.context.workspaceState.update(
			"TodoFilesData",
			this.cachedWorkspaceData.filesData
		);
		await this.context.workspaceState.update(
			"TodoFilesDataPaths",
			this.cachedWorkspaceData.filesDataPaths
		);

		this.suppressNextPersistForScope(TodoScope.workspace);
		this.suppressNextPersistForScope(TodoScope.currentFile);

		this.store.dispatch(
			workspaceActions.loadData({ data: this.cachedWorkspaceData.workspaceTodos })
		);
		this.store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
				{
					workspaceFilesWithRecords: getWorkspaceFilesWithRecords(this.cachedWorkspaceData.filesData),
					filesDataPaths: this.cachedWorkspaceData.filesDataPaths,
				}
			)
		);

		const currentState = this.store.getState();
		const targetFilePath =
			currentState.currentFile.filePath ||
			currentState.editorFocusAndRecords.editorFocusedFilePath;

		if (targetFilePath) {
			const resolved = resolveFilesDataKey({
				filePath: targetFilePath,
				filesData: this.cachedWorkspaceData.filesData,
				filesDataPaths: this.cachedWorkspaceData.filesDataPaths,
			});
			const todos = resolved.key ? this.cachedWorkspaceData.filesData[resolved.key] ?? [] : [];
			this.store.dispatch(
				currentFileActions.loadData({
					filePath: targetFilePath,
					data: todos,
				})
			);
		}
	}

	private async handleWorkspaceFileDelete(): Promise<void> {
		await this.writeWorkspaceData(this.cachedWorkspaceData);
	}

	private async handleGlobalFileChange(): Promise<void> {
		// In Profile Sync mode the list is `TodoData`, which Settings Sync carries and every
		// persist writes before the file; the file is left alone. Loading it would put an older
		// list in `TodoData` when another window's write lands after a newer one, and Settings
		// Sync would upload it. Rewriting it from `TodoData` is no better: another window's
		// change reaches this window's memento later than its file, so this window's copy can be
		// the older one. That window's change is loaded by the next look for a changed `TodoData`,
		// or, if that window leaves Profile Sync first, by the look that finds the mode gone.
		if (this.isProfileSync()) {
			this.watchedProfileSync = true;
			return;
		}

		const data = await this.tryReadGlobalData();
		if (!data) {
			return;
		}

		if (isEqual(data.userTodos, this.cachedGlobalData.userTodos)) {
			return;
		}

		this.updateGlobalCache(data);
		await this.setUserTodoData(this.cachedGlobalData.userTodos);
		this.suppressNextPersistForScope(TodoScope.user);
		this.store.dispatch(userActions.loadData({ data: this.cachedGlobalData.userTodos }));
	}

	private isProfileSync(): boolean {
		return this.context.globalState.get<string>("syncMode", "profile-local") === "profile-sync";
	}

	/** `globalState.TodoData` in Profile Sync mode, where it is the user list's source of truth. */
	private syncedUserTodos(): Todo[] | undefined {
		if (!this.isProfileSync()) {
			return undefined;
		}
		const synced = this.context.globalState.get<unknown>("TodoData");
		return Array.isArray(synced) ? (synced as Todo[]) : undefined;
	}

	private setUserTodoData(todos: Todo[]): Thenable<void> {
		this.seenUserTodoData = todos;
		return this.context.globalState.update("TodoData", todos);
	}

	/**
	 * Settings Sync writes a list another machine uploaded straight into `globalState.TodoData`,
	 * and so does another window on this machine. Without a reload the store kept the older
	 * list, and the next edit wrote it back over the newer one, which Settings Sync then uploaded.
	 *
	 * Call once the store holds the loaded lists and its subscriber is attached. A reload
	 * dispatched before then is overwritten by the initial load, and the persist suppression it
	 * sets is never used up, so it would drop the first edit. It looks once at the call, for a
	 * list delivered since {@link initialize}.
	 */
	public watchSyncedUserTodos(): void {
		const timer = setInterval(
			() => void this.checkSyncedUserTodos(),
			PROFILE_SYNC_CHECK_INTERVAL_MS
		);
		this.context.subscriptions.push(
			{ dispose: () => clearInterval(timer) },
			vscode.window.onDidChangeWindowState((state) => {
				if (state.focused) {
					void this.checkSyncedUserTodos();
				}
			})
		);
		// Also a mode left since `initialize` loaded the list in Profile Sync.
		this.watchedProfileSync = this.watchedProfileSync || this.isProfileSync();
		void this.checkSyncedUserTodos();
	}

	/**
	 * Loads `TodoData` if it is no longer the value this window last wrote or loaded.
	 *
	 * The mode is shared by every window on the machine, so another window can leave Profile
	 * Sync. The file watcher ignored that window's last write, since this window was still in
	 * Profile Sync, and the mode change arrives with the `TodoData` of that write, which from then
	 * on nothing loads. So once this window finds the mode gone, it takes the list from
	 * `TodoData` a last time. Not from the file: in Profile Sync a list loaded from `TodoData` is
	 * not written to the file, so the file can be the older copy.
	 */
	private checkSyncedUserTodos(): Promise<void> {
		const profileSync = this.isProfileSync();
		const left = this.watchedProfileSync && !profileSync;
		this.watchedProfileSync = profileSync;
		if (left) {
			return this.logUserQueueFailure(
				this.exclusive("user", async () => this.leaveProfileSync()),
				"the user list after leaving Profile Sync"
			);
		}

		const synced = this.syncedUserTodos();
		if (!synced || synced === this.seenUserTodoData) {
			return Promise.resolve();
		}
		return this.logUserQueueFailure(
			this.exclusive("user", async () => this.loadSyncedUserTodos()),
			"the synced user list"
		);
	}

	/**
	 * Run in the user queue. An edit queued behind it stores what the store shows, which settles
	 * the lists by itself, so it is left to win. The store is reloaded unless the mode is now
	 * GitHub, where it shows the gist list and the next edit would push the profile's list to the
	 * gist. The file is not written: the window that changed the mode has written it from
	 * `TodoData` (see {@link userSyncModeChanged}), and a later write to it in Local mode can reach
	 * this window before its `TodoData` does, so this window's copy could be the older one.
	 */
	private leaveProfileSync(): void {
		if (this.pendingUserPersists > 0) {
			return;
		}
		if (
			this.takeUserTodoData() &&
			this.context.globalState.get<string>("syncMode", "profile-local") !== "github"
		) {
			this.suppressNextPersistForScope(TodoScope.user);
			this.store.dispatch(userActions.loadData({ data: this.cachedGlobalData.userTodos }));
		}
	}

	/** The queue's tail swallows failures to keep the queue going, so they are logged here. */
	private logUserQueueFailure(work: Promise<void>, what: string): Promise<void> {
		return work.catch((error: unknown) =>
			LogChannel.log(`[StorageSync] Failed to load ${what}: ${this.describeError(error)}`)
		);
	}

	/**
	 * Profile Sync mode: loads `TodoData` into the store when it differs from what this window
	 * holds. Run in the user write queue, so it reads `TodoData` after any persist in progress
	 * has written it. `globalData.json` is not written: in this mode nothing loads it, and
	 * activation and the next mode change write it from `TodoData`.
	 *
	 * An edit whose persist is still queued behind this is left to win. Loading over it showed
	 * the delivered list while the persist then stored the edit, so the two stayed apart until the
	 * next edit stored the shown list and dropped the first. The look after that persist finds
	 * `TodoData` settled on the edit.
	 */
	private loadSyncedUserTodos(): void {
		const synced = this.syncedUserTodos();
		if (!synced || synced === this.seenUserTodoData || this.pendingUserPersists > 0) {
			return;
		}
		this.seenUserTodoData = synced;
		if (isEqual(synced, this.cachedGlobalData.userTodos)) {
			return;
		}
		this.updateGlobalCache({ userTodos: synced });
		this.suppressNextPersistForScope(TodoScope.user);
		this.store.dispatch(userActions.loadData({ data: synced }));
	}

	private async handleGlobalFileDelete(): Promise<void> {
		await this.writeGlobalData(this.cachedGlobalData);
	}

	private async writeWorkspaceData(data: WorkspacePersistedData): Promise<void> {
		if (!this.workspaceDataUri) {
			return;
		}

		try {
			const payload: WorkspacePersistedData = {
				workspaceTodos: Array.isArray(data.workspaceTodos) ? data.workspaceTodos : [],
				filesData: sortByFileName(data.filesData ?? {}),
				filesDataPaths: data.filesDataPaths ?? {},
			};
			await vscode.workspace.fs.writeFile(
				this.workspaceDataUri,
				Buffer.from(JSON.stringify(payload), "utf8")
			);
			this.updateWorkspaceCache(payload);
		} catch (error) {
			LogChannel.log(
				`[StorageSync] Failed to write workspace data: ${this.describeError(error)}`
			);
		}
	}

	private async writeGlobalData(data: GlobalPersistedData): Promise<void> {
		if (!this.globalDataUri) {
			return;
		}

		try {
			const payload: GlobalPersistedData = {
				userTodos: Array.isArray(data.userTodos) ? data.userTodos : [],
			};
			await vscode.workspace.fs.writeFile(
				this.globalDataUri,
				Buffer.from(JSON.stringify(payload), "utf8")
			);
			this.updateGlobalCache(payload);
		} catch (error) {
			LogChannel.log(
				`[StorageSync] Failed to write global data: ${this.describeError(error)}`
			);
		}
	}

	private async tryReadWorkspaceData(): Promise<WorkspacePersistedData | undefined> {
		if (!this.workspaceDataUri) {
			return undefined;
		}

		try {
			const data = await vscode.workspace.fs.readFile(this.workspaceDataUri);
			if (!data?.length) {
				return undefined;
			}

			const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as Partial<
				WorkspacePersistedData
			>;

			return {
				workspaceTodos: Array.isArray(parsed.workspaceTodos) ? parsed.workspaceTodos : [],
				filesData:
					typeof parsed.filesData === "object" && parsed.filesData !== null
						? (parsed.filesData as TodoFilesData)
						: {},
				filesDataPaths:
					typeof parsed.filesDataPaths === "object" && parsed.filesDataPaths !== null
						? (parsed.filesDataPaths as TodoFilesDataPaths)
						: {},
			};
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
				return undefined;
			}

			LogChannel.log(
				`[StorageSync] Failed to read workspace data: ${this.describeError(error)}`
			);
			return undefined;
		}
	}

	private async tryReadGlobalData(): Promise<GlobalPersistedData | undefined> {
		if (!this.globalDataUri) {
			return undefined;
		}

		try {
			const data = await vscode.workspace.fs.readFile(this.globalDataUri);
			if (!data?.length) {
				return undefined;
			}

			const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as Partial<
				GlobalPersistedData
			>;

			return {
				userTodos: Array.isArray(parsed.userTodos) ? parsed.userTodos : [],
			};
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
				return undefined;
			}

			LogChannel.log(
				`[StorageSync] Failed to read global data: ${this.describeError(error)}`
			);
			return undefined;
		}
	}

	private isSameWorkspaceData(
		a: WorkspacePersistedData,
		b: WorkspacePersistedData
	): boolean {
		return (
			isEqual(a.workspaceTodos, b.workspaceTodos) &&
			isEqual(a.filesData, b.filesData) &&
			isEqual(a.filesDataPaths, b.filesDataPaths)
		);
	}

	private updateWorkspaceCache(data: WorkspacePersistedData): void {
		this.cachedWorkspaceData = {
			workspaceTodos: Array.isArray(data.workspaceTodos) ? data.workspaceTodos : [],
			filesData: sortByFileName(data.filesData ?? {}),
			filesDataPaths: data.filesDataPaths ?? {},
		};
	}

	private updateGlobalCache(data: GlobalPersistedData): void {
		this.cachedGlobalData = {
			userTodos: Array.isArray(data.userTodos) ? data.userTodos : [],
		};
	}

	private describeError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}
}
