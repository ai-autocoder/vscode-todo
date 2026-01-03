/**
 * Sync Manager
 * Handles GitHub Gist sync with polling, conflict resolution, and offline support
 */

import * as vscode from "vscode";
import { GitHubApiClient } from "./GitHubApiClient";
import { SyncStorageManager } from "./SyncStorageManager";
import {
	GlobalGistData,
	WorkspaceGistData,
	SyncStatus,
	SyncResult,
	SyncErrorType,
	SyncConstants,
	GistCache,
} from "./syncTypes";
import { isEqual } from "../todo/todoUtils";
import { threeWayMerge, formatMergeSummary, ConflictSet, threeWayMergeWorkspace, formatWorkspaceMergeSummary, mergeWithPreservedPositions } from "./ThreeWayMerge";
import { Todo } from "../todo/todoTypes";
import { ConflictResolutionUI } from "./ConflictResolutionUI";
import { getGistId } from "../utilities/syncConfig";

function cloneData<T>(data: T): T {
	return JSON.parse(JSON.stringify(data)) as T;
}

export class SyncManager {
	private apiClient: GitHubApiClient;
	private storageManager: SyncStorageManager;
	private context: vscode.ExtensionContext;

	// Polling timers
	private userPollTimer: NodeJS.Timeout | undefined;
	private workspacePollTimer: NodeJS.Timeout | undefined;

	// Debounce timers
	private globalDebounceTimer: NodeJS.Timeout | undefined;
	private workspaceDebounceTimer: NodeJS.Timeout | undefined;

	// Status tracking
	private globalStatus: SyncStatus = SyncStatus.Offline;
	private workspaceStatus: SyncStatus = SyncStatus.Offline;

	// Sync operation guards to prevent concurrent sync operations
	private userSyncInProgress: boolean = false;
	private workspaceSyncInProgress: boolean = false;

	// Event emitters for status changes
	private onStatusChangeEmitter = new vscode.EventEmitter<{
		scope: "user" | "workspace";
		status: SyncStatus;
	}>();
	public readonly onStatusChange = this.onStatusChangeEmitter.event;

	// Event emitter for data downloads
	private onDataDownloadedEmitter = new vscode.EventEmitter<{
		scope: "user" | "workspace";
	}>();
	public readonly onDataDownloaded = this.onDataDownloadedEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.apiClient = new GitHubApiClient(context);
		this.storageManager = new SyncStorageManager(context);
	}

	/**
	 * Start polling for a scope
	 */
	public startPolling(scope: "user" | "workspace", intervalSeconds: number): void {
		this.stopPolling(scope);

		const interval = Math.max(
			SyncConstants.minPollInterval,
			Math.min(intervalSeconds, SyncConstants.maxPollInterval)
		);

		const pollFn = () => this.sync(scope);

		if (scope === "user") {
			this.userPollTimer = setInterval(pollFn, interval * 1000);
		} else {
			this.workspacePollTimer = setInterval(pollFn, interval * 1000);
		}

		// Initial sync
		void this.sync(scope);
	}

	/**
	 * Stop polling for a scope
	 */
	public stopPolling(scope: "user" | "workspace"): void {
		if (scope === "user" && this.userPollTimer) {
			clearInterval(this.userPollTimer);
			this.userPollTimer = undefined;
		} else if (scope === "workspace" && this.workspacePollTimer) {
			clearInterval(this.workspacePollTimer);
			this.workspacePollTimer = undefined;
		}
	}

	/**
	 * Trigger debounced sync after local changes
	 */
	public triggerDebounceSync(scope: "user" | "workspace"): void {
		if (scope === "user") {
			if (this.globalDebounceTimer) {
				clearTimeout(this.globalDebounceTimer);
			}
			this.globalDebounceTimer = setTimeout(() => {
				void this.sync("user");
			}, SyncConstants.debounceDelay);
		} else {
			if (this.workspaceDebounceTimer) {
				clearTimeout(this.workspaceDebounceTimer);
			}
			this.workspaceDebounceTimer = setTimeout(() => {
				void this.sync("workspace");
			}, SyncConstants.debounceDelay);
		}
	}

	/**
	 * Perform immediate sync for a scope
	 */
	public async sync(scope: "user" | "workspace"): Promise<SyncResult<void>> {
		const gistId = getGistId();

		if (!gistId) {
			return {
				success: false,
				error: {
					type: SyncErrorType.InvalidGistIdError,
					message: "Gist ID not configured",
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		if (scope === "user") {
			return await this.syncUser(gistId);
		} else {
			return await this.syncWorkspace(gistId);
		}
	}

	/**
	 * Sync global scope
	 */
	private async syncUser(gistId: string): Promise<SyncResult<void>> {
		// Guard: prevent concurrent sync operations
		if (this.userSyncInProgress) {
			console.log(`[SyncManager] User sync already in progress, skipping`);
			return { success: true };
		}

		this.userSyncInProgress = true;
		this.updateStatus("user", SyncStatus.Syncing);

		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const fileName = config.get<string>("github.userFile", "user-todos.json");

		try {
			// Get local cache
			const cache = await this.storageManager.getGlobalGistCache(fileName);

			// Fetch remote gist
			const gistResult = await this.apiClient.fetchGist(gistId);
			if (!gistResult.success || !gistResult.data) {
				this.updateStatus("user", SyncStatus.Error);
				return { success: false, error: gistResult.error };
			}

	
			// If no cache, download from remote
			if (!cache) {
				return await this.downloadUser(gistId, fileName);
			}

			const cachedTodos = Array.isArray(cache.data.userTodos) ? cache.data.userTodos : [];
			const cachedCleanTodos = Array.isArray(cache.lastCleanRemoteData?.userTodos)
				? cache.lastCleanRemoteData?.userTodos
				: undefined;
			const localHasChanges = cache.isDirty && (!cachedCleanTodos || !isEqual(cachedTodos, cachedCleanTodos));

			if (cache.isDirty && !localHasChanges) {
				cache.isDirty = false;
				await this.storageManager.setGlobalGistCache(fileName, cache);
			}

			// Download and parse remote content for comparison
			const fileResult = await this.apiClient.readFile(gistId, fileName);
			if (!fileResult.success || !fileResult.data) {
				// File not found - treat as empty
				if (fileResult.error?.type === SyncErrorType.FileNotFoundError) {
					if (localHasChanges) {
						// Local has changes, upload to create file
						return await this.uploadUser(gistId, fileName, cache);
					}
					// Both empty, in sync
					this.updateStatus("user", SyncStatus.Synced);
					return { success: true };
				}
				this.updateStatus("user", SyncStatus.Error);
				return { success: false, error: fileResult.error };
			}

			let remoteData: GlobalGistData;
			try {
				remoteData = JSON.parse(fileResult.data);
			} catch (error) {
				this.updateStatus("user", SyncStatus.Error);
				return {
					success: false,
					error: {
						type: SyncErrorType.UnknownError,
						message: "Failed to parse remote gist data",
						error: error instanceof Error ? error : undefined,
						timestamp: new Date().toISOString(),
						retryable: false,
					},
				};
			}

			const remoteTodos = Array.isArray(remoteData.userTodos) ? remoteData.userTodos : [];

			// Content-based comparison - compare with last known clean remote state
			let hasRemoteChanges: boolean;
			if (cachedCleanTodos) {
				// Compare remote with last known clean remote (not current cache which includes local changes)
				hasRemoteChanges = !isEqual(remoteTodos, cachedCleanTodos);
			} else {
				// Backwards compatibility: first time with new code, don't know last clean state
				// Treat as potentially changed and update lastCleanRemoteData on download/upload
				hasRemoteChanges = !isEqual(remoteTodos, cachedTodos);
			}

			// Check if both have changes - if so, perform three-way merge
			if (hasRemoteChanges && localHasChanges) {
				console.log(`[SyncManager] Both remote and local have changes - performing three-way merge`);

				// Use last clean remote as base for three-way merge
				const base = cachedCleanTodos || [];
				const local = cachedTodos;
				const remote = remoteTodos;

				const mergeResult = threeWayMerge(base, local, remote);

				// If there are conflicts, show conflict resolution dialog
				if (mergeResult.conflicts.length > 0) {
					console.log(`[SyncManager] ${mergeResult.conflicts.length} conflicts detected`);
					const resolution = await this.showConflictDialog(mergeResult.conflicts, mergeResult.autoMerged, base);

					if (!resolution) {
						// User cancelled or closed dialog
						this.updateStatus("user", SyncStatus.Error);
						return {
							success: false,
							error: {
								type: SyncErrorType.UnknownError,
								message: "User cancelled conflict resolution",
								timestamp: new Date().toISOString(),
								retryable: true,
							},
						};
					}

					// Apply user's conflict resolutions while preserving positions
					const finalMerged = mergeWithPreservedPositions(mergeResult.autoMerged, resolution, base);

					// Upload merged result
					console.log(`[SyncManager] Uploading merged result (${finalMerged.length} todos)`);
					const updatedCleanData = cloneData({ userTodos: finalMerged });
					const updatedCache: GistCache<GlobalGistData> = {
						data: { userTodos: finalMerged },
						lastCleanRemoteData: updatedCleanData,
						lastSynced: new Date().toISOString(),
						isDirty: false,
					};
					const conflictUploadResult = await this.uploadUser(gistId, fileName, updatedCache);

					// Fire data downloaded event to trigger UI update
					if (conflictUploadResult.success) {
						this.onDataDownloadedEmitter.fire({ scope: "user" });
					}

					return conflictUploadResult;
				}

				// No conflicts - auto-merge successful!
				const summary = formatMergeSummary(mergeResult, base);
				console.log(`[SyncManager] Auto-merge successful: ${summary}`);

				// Upload merged result
				const updatedCleanData = cloneData({ userTodos: mergeResult.autoMerged });
				const updatedCache: GistCache<GlobalGistData> = {
					data: { userTodos: mergeResult.autoMerged },
					lastCleanRemoteData: updatedCleanData,
					lastSynced: new Date().toISOString(),
					isDirty: false,
				};

				const uploadResult = await this.uploadUser(gistId, fileName, updatedCache);

				// Show success notification and fire event to update UI
				if (uploadResult.success) {
					vscode.window.showInformationMessage(`Sync successful: ${summary}`);
					this.onDataDownloadedEmitter.fire({ scope: "user" });
				}

				return uploadResult;
			}

			// Remote has changes, local is clean
			if (hasRemoteChanges) {
				console.log(`[SyncManager] Remote changes detected, downloading`);
				return await this.downloadUser(gistId, fileName);
			}

			// Local has changes, upload to remote
			if (localHasChanges) {
				console.log(`[SyncManager] Local changes detected, uploading`);
				return await this.uploadUser(gistId, fileName, cache);
			}

			// Both in sync
			this.updateStatus("user", SyncStatus.Synced);
			return { success: true };
		} catch (error) {
			this.updateStatus("user", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.UnknownError,
					message: error instanceof Error ? error.message : "Unknown error",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		} finally {
			this.userSyncInProgress = false;
		}
	}

	/**
	 * Download global data from gist
	 */
	private async downloadUser(gistId: string, fileName: string): Promise<SyncResult<void>> {
		const fileResult = await this.apiClient.readFile(gistId, fileName);
		if (!fileResult.success || !fileResult.data) {
			// File not found - create empty file
			if (fileResult.error?.type === SyncErrorType.FileNotFoundError) {
				const emptyData: GlobalGistData = {
						userTodos: [],
				};
				const cleanData = cloneData(emptyData);
				const cache: GistCache<GlobalGistData> = {
					data: emptyData,
					lastCleanRemoteData: cleanData,
					lastSynced: new Date().toISOString(),
					isDirty: true,
					};
				await this.storageManager.setGlobalGistCache(fileName, cache);
				this.updateStatus("user", SyncStatus.Dirty);
				// Emit data downloaded event for new empty file
				this.onDataDownloadedEmitter.fire({ scope: "user" });
				return { success: true };
			}

			this.updateStatus("user", SyncStatus.Error);
			return { success: false, error: fileResult.error };
		}

		try {
			const data: GlobalGistData = JSON.parse(fileResult.data);
			const cleanData = cloneData(data);
			const cache: GistCache<GlobalGistData> = {
				data,
				lastCleanRemoteData: cleanData,
				lastSynced: new Date().toISOString(),
				isDirty: false,
			};
			await this.storageManager.setGlobalGistCache(fileName, cache);
			this.updateStatus("user", SyncStatus.Synced);
			// Emit data downloaded event
			this.onDataDownloadedEmitter.fire({ scope: "user" });
			return { success: true };
		} catch (error) {
			this.updateStatus("user", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.UnknownError,
					message: "Failed to parse gist data",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}
	}

	/**
	 * Upload global data to gist
	 */
	private async uploadUser(gistId: string, fileName: string, cache: GistCache<GlobalGistData>): Promise<SyncResult<void>> {
		// Validate cache structure
		if (!cache || !cache.data) {
			this.updateStatus("user", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.ValidationError,
					message: `Invalid cache structure: cache=${!!cache}, cache.data=${!!(cache?.data)}`,
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}


		// Ensure userTodos is initialized
		if (!cache.data.userTodos) {
			cache.data.userTodos = [];
		}

		// Serialize with pretty-printing
		const content = JSON.stringify(cache.data, null, 2);

		// Validate serialized content is not empty
		if (!content || content.trim().length === 0) {
			this.updateStatus("user", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.ValidationError,
					message: `Failed to serialize data: content length=${content?.length ?? 0}, trimmed length=${content?.trim().length ?? 0}`,
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		const writeResult = await this.apiClient.writeFile(gistId, fileName, content);
		if (!writeResult.success || !writeResult.data) {
			this.updateStatus("user", SyncStatus.Error);
			return { success: false, error: writeResult.error };
		}

		// Update cache
		cache.lastSynced = new Date().toISOString();
		cache.isDirty = false;
		// After successful upload, current data becomes the new clean remote state
		cache.lastCleanRemoteData = JSON.parse(JSON.stringify(cache.data));
		await this.storageManager.setGlobalGistCache(fileName, cache);

		this.updateStatus("user", SyncStatus.Synced);
		return { success: true };
	}

	/**
	 * Sync workspace scope
	 */
	private async syncWorkspace(gistId: string): Promise<SyncResult<void>> {
		// Guard: prevent concurrent sync operations
		if (this.workspaceSyncInProgress) {
			console.log(`[SyncManager] Workspace sync already in progress, skipping`);
			return { success: true };
		}

		this.workspaceSyncInProgress = true;
		this.updateStatus("workspace", SyncStatus.Syncing);

		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const workspaceName = vscode.workspace.name || "default";
		const fileName = config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;

		try {
			// Get local cache
			const cache = await this.storageManager.getWorkspaceGistCache(fileName);

			// Fetch remote gist
			const gistResult = await this.apiClient.fetchGist(gistId);
			if (!gistResult.success || !gistResult.data) {
				this.updateStatus("workspace", SyncStatus.Error);
				return { success: false, error: gistResult.error };
			}

	
			// If no cache, download from remote
			if (!cache) {
				return await this.downloadWorkspace(gistId, fileName);
			}

			const cachedWorkspaceTodos = Array.isArray(cache.data.workspaceTodos)
				? cache.data.workspaceTodos
				: [];
			const cachedFilesData =
				typeof cache.data.filesData === "object" && cache.data.filesData !== null
					? cache.data.filesData
					: {};
			const cachedCleanWorkspaceTodos = Array.isArray(cache.lastCleanRemoteData?.workspaceTodos)
				? cache.lastCleanRemoteData?.workspaceTodos
				: undefined;
			const cachedCleanFilesData =
				typeof cache.lastCleanRemoteData?.filesData === "object" &&
				cache.lastCleanRemoteData?.filesData !== null
					? cache.lastCleanRemoteData?.filesData
					: undefined;
			const localHasChanges =
				cache.isDirty &&
				(!cachedCleanWorkspaceTodos ||
					!cachedCleanFilesData ||
					!isEqual(cachedWorkspaceTodos, cachedCleanWorkspaceTodos) ||
					!isEqual(cachedFilesData, cachedCleanFilesData));

			if (cache.isDirty && !localHasChanges) {
				cache.isDirty = false;
				await this.storageManager.setWorkspaceGistCache(fileName, cache);
			}

			// Download and parse remote content for comparison
			const fileResult = await this.apiClient.readFile(gistId, fileName);
			if (!fileResult.success || !fileResult.data) {
				// File not found - treat as empty
				if (fileResult.error?.type === SyncErrorType.FileNotFoundError) {
					if (localHasChanges) {
						// Local has changes, upload to create file
						return await this.uploadWorkspace(gistId, fileName, cache);
					}
					// Both empty, in sync
					this.updateStatus("workspace", SyncStatus.Synced);
					return { success: true };
				}
				this.updateStatus("workspace", SyncStatus.Error);
				return { success: false, error: fileResult.error };
			}

			let remoteData: WorkspaceGistData;
			try {
				remoteData = JSON.parse(fileResult.data);
			} catch (error) {
				this.updateStatus("workspace", SyncStatus.Error);
				return {
					success: false,
					error: {
						type: SyncErrorType.UnknownError,
						message: "Failed to parse remote gist data",
						error: error instanceof Error ? error : undefined,
						timestamp: new Date().toISOString(),
						retryable: false,
					},
				};
			}

			const remoteWorkspaceTodos = Array.isArray(remoteData.workspaceTodos)
				? remoteData.workspaceTodos
				: [];
			const remoteFilesData =
				typeof remoteData.filesData === "object" && remoteData.filesData !== null
					? remoteData.filesData
					: {};

			// Content-based comparison - compare with last known clean remote state
			let hasRemoteChanges: boolean;
			if (cachedCleanWorkspaceTodos && cachedCleanFilesData) {
				// Compare remote with last known clean remote (not current cache which includes local changes)
				const workspaceTodosChanged = !isEqual(remoteWorkspaceTodos, cachedCleanWorkspaceTodos);
				const filesDataChanged = !isEqual(remoteFilesData, cachedCleanFilesData);
				hasRemoteChanges = workspaceTodosChanged || filesDataChanged;
			} else {
				// Backwards compatibility: first time with new code, don't know last clean state
				// Treat as potentially changed and update lastCleanRemoteData on download/upload
				const workspaceTodosChanged = !isEqual(remoteWorkspaceTodos, cachedWorkspaceTodos);
				const filesDataChanged = !isEqual(remoteFilesData, cachedFilesData);
				hasRemoteChanges = workspaceTodosChanged || filesDataChanged;
			}

			// TRUE CONFLICT: Both remote and local have different content - perform three-way merge
			if (hasRemoteChanges && localHasChanges) {
				console.log(`[SyncManager] Workspace: Both remote and local have changes - performing three-way merge`);

				// Use last clean remote as base for three-way merge
				const baseWorkspaceTodos = cachedCleanWorkspaceTodos || [];
				const baseFilesData = cachedCleanFilesData || {};
				const localWorkspaceTodos = cachedWorkspaceTodos;
				const localFilesData = cachedFilesData;

				const mergeResult = threeWayMergeWorkspace(
					baseWorkspaceTodos,
					localWorkspaceTodos,
					remoteWorkspaceTodos,
					baseFilesData,
					localFilesData,
					remoteFilesData
				);

				// Check if there are any conflicts (workspace or file-level)
				const hasConflicts = mergeResult.workspaceConflicts.length > 0 || mergeResult.fileConflicts.length > 0;

				if (hasConflicts) {
					console.log(
						`[SyncManager] Workspace: ${mergeResult.workspaceConflicts.length} todo conflicts, ${mergeResult.fileConflicts.length} file conflicts detected`
					);

					// For now, handle workspace todo conflicts using existing UI
					// File conflicts require new UI - for Phase 1, show simplified dialog
					if (mergeResult.fileConflicts.length > 0) {
						// Show file conflict dialog
						const fileChoice = await vscode.window.showWarningMessage(
							`Workspace Sync: ${mergeResult.fileConflicts.length} file path conflict(s) detected.`,
							{ modal: true },
							"Keep Local Files",
							"Keep Remote Files",
							"View Gist"
						);

						if (fileChoice === "View Gist") {
							const gistIdValue = getGistId();
							if (gistIdValue) {
								await vscode.env.openExternal(
									vscode.Uri.parse(`https://gist.github.com/${gistIdValue}`)
								);
							}
							this.updateStatus("workspace", SyncStatus.Error);
							return {
								success: false,
								error: {
									type: SyncErrorType.ConflictError,
									message: "User chose to manually resolve file conflicts",
									timestamp: new Date().toISOString(),
									retryable: true,
								},
							};
						}

						// Apply file conflict resolution
						if (fileChoice === "Keep Local Files") {
							for (const conflict of mergeResult.fileConflicts) {
								if (conflict.local) {
									mergeResult.autoMergedFilesData[conflict.filePath] = conflict.local;
								}
							}
						} else {
							// Keep Remote Files (or user closed dialog)
							for (const conflict of mergeResult.fileConflicts) {
								if (conflict.remote) {
									mergeResult.autoMergedFilesData[conflict.filePath] = conflict.remote;
								}
							}
						}
					}

					// Handle workspace todo conflicts
					if (mergeResult.workspaceConflicts.length > 0) {
						const resolution = await this.showConflictDialog(
							mergeResult.workspaceConflicts,
							mergeResult.autoMergedWorkspaceTodos,
							baseWorkspaceTodos
						);

						if (!resolution) {
							// User cancelled conflict resolution
							this.updateStatus("workspace", SyncStatus.Error);
							return {
								success: false,
								error: {
									type: SyncErrorType.ConflictError,
									message: "User cancelled workspace conflict resolution",
									timestamp: new Date().toISOString(),
									retryable: true,
								},
							};
						}

						// Apply user's conflict resolutions while preserving positions
						mergeResult.autoMergedWorkspaceTodos = mergeWithPreservedPositions(
							mergeResult.autoMergedWorkspaceTodos,
							resolution,
							baseWorkspaceTodos
						);
					}

					// Upload merged result
					console.log(
						`[SyncManager] Workspace: Uploading merged result (${mergeResult.autoMergedWorkspaceTodos.length} todos, ${Object.keys(mergeResult.autoMergedFilesData).length} files)`
					);
					const finalMerged: WorkspaceGistData = {
						workspaceTodos: mergeResult.autoMergedWorkspaceTodos,
						filesData: mergeResult.autoMergedFilesData,
					};
					const updatedCleanData = cloneData(finalMerged);
					const updatedCache: GistCache<WorkspaceGistData> = {
						data: finalMerged,
						lastCleanRemoteData: updatedCleanData,
						lastSynced: new Date().toISOString(),
						isDirty: false,
					};
					const conflictUploadResult = await this.uploadWorkspace(gistId, fileName, updatedCache);

					// Fire data downloaded event to trigger UI update
					if (conflictUploadResult.success) {
						this.onDataDownloadedEmitter.fire({ scope: "workspace" });
					}

					return conflictUploadResult;
				}

				// No conflicts - auto-merge successful!
				const summary = formatWorkspaceMergeSummary(mergeResult, baseWorkspaceTodos, baseFilesData);
				console.log(`[SyncManager] Workspace: Auto-merge successful: ${summary}`);

				// Upload merged result
				const finalMerged: WorkspaceGistData = {
					workspaceTodos: mergeResult.autoMergedWorkspaceTodos,
					filesData: mergeResult.autoMergedFilesData,
				};
				const updatedCleanData = cloneData(finalMerged);
				const updatedCache: GistCache<WorkspaceGistData> = {
					data: finalMerged,
					lastCleanRemoteData: updatedCleanData,
					lastSynced: new Date().toISOString(),
					isDirty: false,
				};

				const uploadResult = await this.uploadWorkspace(gistId, fileName, updatedCache);

				// Show success notification and fire event to update UI
				if (uploadResult.success) {
					vscode.window.showInformationMessage(`Workspace sync successful: ${summary}`);
					this.onDataDownloadedEmitter.fire({ scope: "workspace" });
				}

				return uploadResult;
			}

			// Remote has changes, local is clean
			if (hasRemoteChanges) {
				console.log(`[SyncManager] Workspace remote changes detected, downloading`);
				return await this.downloadWorkspace(gistId, fileName);
			}

			// Local has changes, upload to remote
			if (localHasChanges) {
				console.log(`[SyncManager] Workspace local changes detected, uploading`);
				return await this.uploadWorkspace(gistId, fileName, cache);
			}

			// Both in sync
			this.updateStatus("workspace", SyncStatus.Synced);
			return { success: true };
		} catch (error) {
			this.updateStatus("workspace", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.UnknownError,
					message: error instanceof Error ? error.message : "Unknown error",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		} finally {
			this.workspaceSyncInProgress = false;
		}
	}

	/**
	 * Download workspace data from gist
	 */
	private async downloadWorkspace(gistId: string, fileName: string): Promise<SyncResult<void>> {
		const fileResult = await this.apiClient.readFile(gistId, fileName);
		if (!fileResult.success || !fileResult.data) {
			// File not found - create empty file
			if (fileResult.error?.type === SyncErrorType.FileNotFoundError) {
				const emptyData: WorkspaceGistData = {
						workspaceTodos: [],
					filesData: {},
				};
				const cleanData = cloneData(emptyData);
				const cache: GistCache<WorkspaceGistData> = {
					data: emptyData,
					lastCleanRemoteData: cleanData,
					lastSynced: new Date().toISOString(),
					isDirty: true,
					};
				await this.storageManager.setWorkspaceGistCache(fileName, cache);
				this.updateStatus("workspace", SyncStatus.Dirty);
				// Emit data downloaded event for new empty file
				this.onDataDownloadedEmitter.fire({ scope: "workspace" });
				return { success: true };
			}

			this.updateStatus("workspace", SyncStatus.Error);
			return { success: false, error: fileResult.error };
		}

		try {
			const data: WorkspaceGistData = JSON.parse(fileResult.data);
			const cleanData = cloneData(data);
			const cache: GistCache<WorkspaceGistData> = {
				data,
				lastCleanRemoteData: cleanData,
				lastSynced: new Date().toISOString(),
				isDirty: false,
			};
			await this.storageManager.setWorkspaceGistCache(fileName, cache);
			this.updateStatus("workspace", SyncStatus.Synced);
			// Emit data downloaded event
			this.onDataDownloadedEmitter.fire({ scope: "workspace" });
			return { success: true };
		} catch (error) {
			this.updateStatus("workspace", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.UnknownError,
					message: "Failed to parse gist data",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}
	}

	/**
	 * Upload workspace data to gist
	 */
	private async uploadWorkspace(gistId: string, fileName: string, cache: GistCache<WorkspaceGistData>): Promise<SyncResult<void>> {
		// Sort filesData keys lexicographically for stable serialization
		const sortedFilesData: typeof cache.data.filesData = {};
		Object.keys(cache.data.filesData)
			.sort()
			.forEach((key) => {
				sortedFilesData[key] = cache.data.filesData[key];
			});
		cache.data.filesData = sortedFilesData;

		// Serialize with pretty-printing
		const content = JSON.stringify(cache.data, null, 2);

		// Validate serialized content is not empty
		if (!content || content.trim().length === 0) {
			this.updateStatus("workspace", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.ValidationError,
					message: "Failed to serialize data: content is empty",
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		const writeResult = await this.apiClient.writeFile(gistId, fileName, content);
		if (!writeResult.success || !writeResult.data) {
			this.updateStatus("workspace", SyncStatus.Error);
			return { success: false, error: writeResult.error };
		}

		// Update cache
		cache.lastSynced = new Date().toISOString();
		cache.isDirty = false;
		// After successful upload, current data becomes the new clean remote state
		cache.lastCleanRemoteData = JSON.parse(JSON.stringify(cache.data));
		await this.storageManager.setWorkspaceGistCache(fileName, cache);

		this.updateStatus("workspace", SyncStatus.Synced);
		return { success: true };
	}

	/**
	 * Get current sync status
	 */
	public getStatus(scope: "user" | "workspace"): SyncStatus {
		return scope === "user" ? this.globalStatus : this.workspaceStatus;
	}

	/**
	 * Update sync status and emit event
	 */
	private updateStatus(scope: "user" | "workspace", status: SyncStatus): void {
		if (scope === "user") {
			this.globalStatus = status;
		} else {
			this.workspaceStatus = status;
		}
		this.onStatusChangeEmitter.fire({ scope, status });
	}

	/**
	 * Show conflict resolution dialog to the user
	 * Returns array of resolved todos, or null if user cancelled
	 */
	private async showConflictDialog(
		conflicts: ConflictSet[],
		autoMerged: Todo[],
		base: Todo[]
	): Promise<Todo[] | null> {
		// Use enhanced conflict resolution UI
		return await ConflictResolutionUI.resolveConflicts(conflicts, autoMerged, base);
	}

	/**
	 * Dispose timers and resources
	 */
	public dispose(): void {
		this.stopPolling("user");
		this.stopPolling("workspace");
		if (this.globalDebounceTimer) {
			clearTimeout(this.globalDebounceTimer);
		}
		if (this.workspaceDebounceTimer) {
			clearTimeout(this.workspaceDebounceTimer);
		}
		this.onStatusChangeEmitter.dispose();
		this.onDataDownloadedEmitter.dispose();
	}
}
