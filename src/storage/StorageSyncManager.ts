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
import { GlobalSyncMode, WorkspaceSyncMode } from "../sync/syncTypes";

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

export default class StorageSyncManager {
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
		await this.ensureGlobalStorageInitialized();
		await this.ensureWorkspaceStorageInitialized();
		this.registerWatchers();
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

		return this.exclusive(state.scope === TodoScope.user ? "user" : "workspace", () =>
			this.writeSlice(state, config, userSyncMode, workspaceSyncMode)
		);
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
					await this.context.globalState.update("TodoData", state.todos);

					if (userSyncMode === "github") {
						// Write to gist cache
						const globalMode = GlobalSyncMode.GitHub;
						const fileName = config.get<string>("github.userFile", "user-todos.json");
						await this.syncStorageManager.setGlobalTodos(globalMode, state.todos, fileName);
					} else {
						// Write to local file
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

	private async ensureGlobalStorageInitialized(): Promise<void> {
		try {
			const globalRoot = this.context.globalStorageUri;
			await vscode.workspace.fs.createDirectory(globalRoot);
			this.globalDataUri = vscode.Uri.joinPath(globalRoot, this.globalDataFileName);
			const existing = await this.tryReadGlobalData();

			if (existing) {
				this.updateGlobalCache(existing);
			} else {
				const initialData: GlobalPersistedData = {
					userTodos: (this.context.globalState.get("TodoData") as Todo[]) ?? [],
				};
				this.updateGlobalCache(initialData);
				await this.writeGlobalData(initialData);
			}

			await this.context.globalState.update("TodoData", this.cachedGlobalData.userTodos);
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
		const data = await this.tryReadGlobalData();
		if (!data) {
			return;
		}

		if (isEqual(data.userTodos, this.cachedGlobalData.userTodos)) {
			return;
		}

		this.updateGlobalCache(data);
		await this.context.globalState.update("TodoData", this.cachedGlobalData.userTodos);
		this.suppressNextPersistForScope(TodoScope.user);
		this.store.dispatch(userActions.loadData({ data: this.cachedGlobalData.userTodos }));
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
