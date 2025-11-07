/**
 * Sync Storage Manager
 * Handles mode-specific data isolation and storage operations
 */

import * as vscode from "vscode";
import { Todo, TodoFilesData } from "../todo/todoTypes";
import {
	GlobalSyncMode,
	WorkspaceSyncMode,
	GlobalGistData,
	WorkspaceGistData,
	GistCache,
	StorageKeys,
} from "./syncTypes";

/**
 * Storage manager with data isolation per sync mode
 * Each mode maintains completely separate data storage
 */
export class SyncStorageManager {
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	/**
	 * Get global todos based on current sync mode
	 */
	public async getGlobalTodos(mode: GlobalSyncMode, fileName?: string): Promise<Todo[]> {
		switch (mode) {
			case GlobalSyncMode.Local:
				return this.getFromGlobalState<Todo[]>(StorageKeys.globalLocal, []);

			case GlobalSyncMode.ProfileSync:
				return this.getFromSettings<Todo[]>(StorageKeys.globalProfileSync, []);

			case GlobalSyncMode.GitHub:
				if (!fileName) {
					throw new Error("File name required for GitHub mode");
				}
				const cache = await this.getGlobalGistCache(fileName);
				return cache?.data.userTodos || [];

			default:
				return [];
		}
	}

	/**
	 * Set global todos based on current sync mode
	 */
	public async setGlobalTodos(mode: GlobalSyncMode, todos: Todo[], fileName?: string): Promise<void> {
		switch (mode) {
			case GlobalSyncMode.Local:
				await this.setToGlobalState(StorageKeys.globalLocal, todos);
				break;

			case GlobalSyncMode.ProfileSync:
				await this.setToSettings(StorageKeys.globalProfileSync, todos);
				break;

			case GlobalSyncMode.GitHub:
				if (!fileName) {
					throw new Error("File name required for GitHub mode");
				}
				// Update cache and mark as dirty
				const cache = (await this.getGlobalGistCache(fileName)) || this.createEmptyGlobalCache();
				cache.data.userTodos = todos;
				cache.isDirty = true;
				await this.setGlobalGistCache(fileName, cache);
				break;
		}
	}

	/**
	 * Get workspace todos based on current sync mode
	 */
	public async getWorkspaceTodos(mode: WorkspaceSyncMode, fileName?: string): Promise<Todo[]> {
		switch (mode) {
			case WorkspaceSyncMode.Local:
				return this.getFromWorkspaceState<Todo[]>(StorageKeys.workspaceLocal, []);

			case WorkspaceSyncMode.GitHub:
				if (!fileName) {
					throw new Error("File name required for GitHub mode");
				}
				const cache = await this.getWorkspaceGistCache(fileName);
				return cache?.data.workspaceTodos || [];

			default:
				return [];
		}
	}

	/**
	 * Set workspace todos based on current sync mode
	 */
	public async setWorkspaceTodos(mode: WorkspaceSyncMode, todos: Todo[], fileName?: string): Promise<void> {
		switch (mode) {
			case WorkspaceSyncMode.Local:
				await this.setToWorkspaceState(StorageKeys.workspaceLocal, todos);
				break;

			case WorkspaceSyncMode.GitHub:
				if (!fileName) {
					throw new Error("File name required for GitHub mode");
				}
				// Update cache and mark as dirty
				const cache = (await this.getWorkspaceGistCache(fileName)) || this.createEmptyWorkspaceCache();
				cache.data.workspaceTodos = todos;
				cache.isDirty = true;
				await this.setWorkspaceGistCache(fileName, cache);
				break;
		}
	}

	/**
	 * Get file data (always from workspace scope)
	 */
	public async getFilesData(mode: WorkspaceSyncMode, fileName?: string): Promise<TodoFilesData> {
		switch (mode) {
			case WorkspaceSyncMode.Local:
				return this.getFromWorkspaceState<TodoFilesData>(StorageKeys.filesLocal, {});

			case WorkspaceSyncMode.GitHub:
				if (!fileName) {
					throw new Error("File name required for GitHub mode");
				}
				const cache = await this.getWorkspaceGistCache(fileName);
				return cache?.data.filesData || {};

			default:
				return {};
		}
	}

	/**
	 * Set file data (always from workspace scope)
	 */
	public async setFilesData(mode: WorkspaceSyncMode, filesData: TodoFilesData, fileName?: string): Promise<void> {
		switch (mode) {
			case WorkspaceSyncMode.Local:
				await this.setToWorkspaceState(StorageKeys.filesLocal, filesData);
				break;

			case WorkspaceSyncMode.GitHub:
				if (!fileName) {
					throw new Error("File name required for GitHub mode");
				}
				// Update cache and mark as dirty
				const cache = (await this.getWorkspaceGistCache(fileName)) || this.createEmptyWorkspaceCache();
				cache.data.filesData = filesData;
				cache.isDirty = true;
				await this.setWorkspaceGistCache(fileName, cache);
				break;
		}
	}

	/**
	 * Get global gist cache
	 */
	public async getGlobalGistCache(fileName: string): Promise<GistCache<GlobalGistData> | undefined> {
		const key = StorageKeys.globalGistCache(fileName);
		return this.getFromGlobalState<GistCache<GlobalGistData>>(key, undefined);
	}

	/**
	 * Set global gist cache
	 */
	public async setGlobalGistCache(fileName: string, cache: GistCache<GlobalGistData>): Promise<void> {
		const key = StorageKeys.globalGistCache(fileName);
		await this.setToGlobalState(key, cache);
	}

	/**
	 * Get workspace gist cache
	 */
	public async getWorkspaceGistCache(fileName: string): Promise<GistCache<WorkspaceGistData> | undefined> {
		const key = StorageKeys.workspaceGistCache(fileName);
		return this.getFromWorkspaceState<GistCache<WorkspaceGistData>>(key, undefined);
	}

	/**
	 * Set workspace gist cache
	 */
	public async setWorkspaceGistCache(fileName: string, cache: GistCache<WorkspaceGistData>): Promise<void> {
		const key = StorageKeys.workspaceGistCache(fileName);
		await this.setToWorkspaceState(key, cache);
	}

	/**
	 * Clear cache for specific file
	 */
	public async clearGlobalCache(fileName: string): Promise<void> {
		const key = StorageKeys.globalGistCache(fileName);
		await this.context.globalState.update(key, undefined);
	}

	/**
	 * Clear workspace cache for specific file
	 */
	public async clearWorkspaceCache(fileName: string): Promise<void> {
		const key = StorageKeys.workspaceGistCache(fileName);
		await this.context.workspaceState.update(key, undefined);
	}

	/**
	 * Create empty global cache
	 */
	private createEmptyGlobalCache(): GistCache<GlobalGistData> {
		return {
			data: {
					userTodos: [],
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};
	}

	/**
	 * Create empty workspace cache
	 */
	private createEmptyWorkspaceCache(): GistCache<WorkspaceGistData> {
		return {
			data: {
					workspaceTodos: [],
				filesData: {},
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};
	}

	/**
	 * Helper: Get from global state with defined default
	 */
	private getFromGlobalState<T>(key: string, defaultValue: T): T;
	/**
	 * Helper: Get from global state with undefined default
	 */
	private getFromGlobalState<T>(key: string, defaultValue: undefined): T | undefined;
	/**
	 * Implementation
	 */
	private getFromGlobalState<T>(key: string, defaultValue: T | undefined): T | undefined {
		return this.context.globalState.get<T>(key) ?? defaultValue;
	}

	/**
	 * Helper: Set to global state
	 */
	private async setToGlobalState<T>(key: string, value: T): Promise<void> {
		await this.context.globalState.update(key, value);
	}

	/**
	 * Helper: Get from workspace state with defined default
	 */
	private getFromWorkspaceState<T>(key: string, defaultValue: T): T;
	/**
	 * Helper: Get from workspace state with undefined default
	 */
	private getFromWorkspaceState<T>(key: string, defaultValue: undefined): T | undefined;
	/**
	 * Implementation
	 */
	private getFromWorkspaceState<T>(key: string, defaultValue: T | undefined): T | undefined {
		return this.context.workspaceState.get<T>(key) ?? defaultValue;
	}

	/**
	 * Helper: Set to workspace state
	 */
	private async setToWorkspaceState<T>(key: string, value: T): Promise<void> {
		await this.context.workspaceState.update(key, value);
	}

	/**
	 * Helper: Get from VS Code settings
	 */
	private getFromSettings<T>(key: string, defaultValue: T): T {
		return vscode.workspace.getConfiguration().get<T>(key, defaultValue);
	}

	/**
	 * Helper: Set to VS Code settings
	 */
	private async setToSettings<T>(key: string, value: T): Promise<void> {
		await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
	}
}
