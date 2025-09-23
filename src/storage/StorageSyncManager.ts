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
	TodoFilesData,
	TodoScope,
	TodoSlice,
} from "../todo/todoTypes";
import { getWorkspaceFilesWithRecords, isEqual, sortByFileName } from "../todo/todoUtils";

type WorkspacePersistedData = {
	workspaceTodos: Todo[];
	filesData: TodoFilesData;
};

type GlobalPersistedData = {
	userTodos: Todo[];
};

export default class StorageSyncManager {
	private readonly workspaceDataFileName = "workspaceData.json";
	private readonly globalDataFileName = "globalData.json";
	private workspaceDataUri: vscode.Uri | undefined;
	private globalDataUri: vscode.Uri | undefined;
	private ignoreWorkspaceWatcher = false;
	private ignoreGlobalWatcher = false;
	private readonly suppressedScopes = new Set<TodoScope>();
	private cachedWorkspaceData: WorkspacePersistedData = { workspaceTodos: [], filesData: {} };
	private cachedGlobalData: GlobalPersistedData = { userTodos: [] };

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: EnhancedStore<StoreState>
	) {}

	public async initialize(): Promise<void> {
		await this.ensureGlobalStorageInitialized();
		await this.ensureWorkspaceStorageInitialized();
		this.registerWatchers();
	}

	public getWorkspaceTodos(): Todo[] {
		return this.cachedWorkspaceData.workspaceTodos;
	}

	public getWorkspaceFilesData(): TodoFilesData {
		return this.cachedWorkspaceData.filesData;
	}

	public getUserTodos(): Todo[] {
		return this.cachedGlobalData.userTodos;
	}

	public suppressNextPersistForScope(scope: TodoScope): void {
		this.suppressedScopes.add(scope);
	}

	public async persistSlice(state: TodoSlice | CurrentFileSlice): Promise<void> {
		if (this.suppressedScopes.has(state.scope)) {
			this.suppressedScopes.delete(state.scope);
			return;
		}

		try {
			switch (state.scope) {
				case TodoScope.user: {
					await this.context.globalState.update("TodoData", state.todos);
					await this.writeGlobalData({ userTodos: state.todos });
					break;
				}
				case TodoScope.workspace: {
					await this.context.workspaceState.update("TodoData", state.todos);
					await this.writeWorkspaceData({
						workspaceTodos: state.todos,
						filesData: this.cachedWorkspaceData.filesData,
					});
					break;
				}
				case TodoScope.currentFile: {
					const currentFileState = state as CurrentFileSlice;
					const previousData = { ...this.cachedWorkspaceData.filesData };

					previousData[currentFileState.filePath] = currentFileState.todos;
					const sortedResult = sortByFileName(previousData);
					if (currentFileState.todos.length === 0) {
						delete sortedResult[currentFileState.filePath];
					}

					await this.context.workspaceState.update("TodoFilesData", sortedResult);
					await this.writeWorkspaceData({
						workspaceTodos: this.cachedWorkspaceData.workspaceTodos,
						filesData: sortedResult,
					});
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
			this.updateWorkspaceCache({
				workspaceTodos: (this.context.workspaceState.get("TodoData") as Todo[]) ?? [],
				filesData: sortByFileName((this.context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {}),
			});
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
				this.updateWorkspaceCache(existing);
			} else {
				const initialData: WorkspacePersistedData = {
					workspaceTodos: (this.context.workspaceState.get("TodoData") as Todo[]) ?? [],
					filesData: sortByFileName(
						(this.context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {}
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
			this.context.subscriptions.push(
				workspaceWatcher,
				workspaceWatcher.onDidChange(() => void this.handleWorkspaceFileChange()),
				workspaceWatcher.onDidCreate(() => void this.handleWorkspaceFileChange()),
				workspaceWatcher.onDidDelete(() => void this.handleWorkspaceFileDelete())
			);
		}

		if (this.globalDataUri) {
			const globalWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(this.context.globalStorageUri, this.globalDataFileName)
			);
			this.context.subscriptions.push(
				globalWatcher,
				globalWatcher.onDidChange(() => void this.handleGlobalFileChange()),
				globalWatcher.onDidCreate(() => void this.handleGlobalFileChange()),
				globalWatcher.onDidDelete(() => void this.handleGlobalFileDelete())
			);
		}
	}

	private async handleWorkspaceFileChange(): Promise<void> {
		if (this.ignoreWorkspaceWatcher) {
			return;
		}

		const data = await this.tryReadWorkspaceData();
		if (!data) {
			return;
		}

		if (this.isSameWorkspaceData(this.cachedWorkspaceData, data)) {
			return;
		}

		this.updateWorkspaceCache(data);
		await this.context.workspaceState.update("TodoData", this.cachedWorkspaceData.workspaceTodos);
		await this.context.workspaceState.update(
			"TodoFilesData",
			this.cachedWorkspaceData.filesData
		);

		this.suppressNextPersistForScope(TodoScope.workspace);
		this.suppressNextPersistForScope(TodoScope.currentFile);

		this.store.dispatch(
			workspaceActions.loadData({ data: this.cachedWorkspaceData.workspaceTodos })
		);
		this.store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
				getWorkspaceFilesWithRecords(this.cachedWorkspaceData.filesData)
			)
		);

		const currentState = this.store.getState();
		const targetFilePath =
			currentState.currentFile.filePath ||
			currentState.editorFocusAndRecords.editorFocusedFilePath;

		if (targetFilePath) {
			const todos = this.cachedWorkspaceData.filesData[targetFilePath] ?? [];
			this.store.dispatch(
				currentFileActions.loadData({
					filePath: targetFilePath,
					data: todos,
				})
			);
		}
	}

	private async handleWorkspaceFileDelete(): Promise<void> {
		if (this.ignoreWorkspaceWatcher) {
			return;
		}

		await this.writeWorkspaceData(this.cachedWorkspaceData);
	}

	private async handleGlobalFileChange(): Promise<void> {
		if (this.ignoreGlobalWatcher) {
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
		await this.context.globalState.update("TodoData", this.cachedGlobalData.userTodos);
		this.suppressNextPersistForScope(TodoScope.user);
		this.store.dispatch(userActions.loadData({ data: this.cachedGlobalData.userTodos }));
	}

	private async handleGlobalFileDelete(): Promise<void> {
		if (this.ignoreGlobalWatcher) {
			return;
		}

		await this.writeGlobalData(this.cachedGlobalData);
	}

	private async writeWorkspaceData(data: WorkspacePersistedData): Promise<void> {
		if (!this.workspaceDataUri) {
			return;
		}

		try {
			this.ignoreWorkspaceWatcher = true;
			const payload: WorkspacePersistedData = {
				workspaceTodos: Array.isArray(data.workspaceTodos) ? data.workspaceTodos : [],
				filesData: sortByFileName(data.filesData ?? {}),
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
		} finally {
			this.ignoreWorkspaceWatcher = false;
		}
	}

	private async writeGlobalData(data: GlobalPersistedData): Promise<void> {
		if (!this.globalDataUri) {
			return;
		}

		try {
			this.ignoreGlobalWatcher = true;
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
		} finally {
			this.ignoreGlobalWatcher = false;
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
		return isEqual(a.workspaceTodos, b.workspaceTodos) && isEqual(a.filesData, b.filesData);
	}

	private updateWorkspaceCache(data: WorkspacePersistedData): void {
		this.cachedWorkspaceData = {
			workspaceTodos: Array.isArray(data.workspaceTodos) ? data.workspaceTodos : [],
			filesData: sortByFileName(data.filesData ?? {}),
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
