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
import { threeWayMerge, formatMergeSummary, ConflictSet } from "./ThreeWayMerge";
import { Todo } from "../todo/todoTypes";
import { ConflictResolutionUI } from "./ConflictResolutionUI";

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
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const gistId = config.get<string>("github.gistId");

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

			// Download and parse remote content for comparison
			const fileResult = await this.apiClient.readFile(gistId, fileName);
			if (!fileResult.success || !fileResult.data) {
				// File not found - treat as empty
				if (fileResult.error?.type === SyncErrorType.FileNotFoundError) {
					if (cache.isDirty) {
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

			// Content-based comparison - compare with last known clean remote state
			let hasRemoteChanges: boolean;
			if (cache.lastCleanRemoteData) {
				// Compare remote with last known clean remote (not current cache which includes local changes)
				hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData.userTodos);
			} else {
				// Backwards compatibility: first time with new code, don't know last clean state
				// Treat as potentially changed and update lastCleanRemoteData on download/upload
				hasRemoteChanges = !isEqual(remoteData.userTodos, cache.data.userTodos);
			}

			// Check if both have changes - if so, perform three-way merge
			if (hasRemoteChanges && cache.isDirty) {
				console.log(`[SyncManager] Both remote and local have changes - performing three-way merge`);

				// Use last clean remote as base for three-way merge
				const base = cache.lastCleanRemoteData?.userTodos || [];
				const local = cache.data.userTodos;
				const remote = remoteData.userTodos;

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

					// Apply user's conflict resolutions
					const finalMerged = [...mergeResult.autoMerged, ...resolution];

					// Upload merged result
					console.log(`[SyncManager] Uploading merged result (${finalMerged.length} todos)`);
					const updatedCache: GistCache<GlobalGistData> = {
						data: { userTodos: finalMerged },
						lastCleanRemoteData: { userTodos: finalMerged },
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
				const updatedCache: GistCache<GlobalGistData> = {
					data: { userTodos: mergeResult.autoMerged },
					lastCleanRemoteData: { userTodos: mergeResult.autoMerged },
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
			if (cache.isDirty) {
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
				const cache: GistCache<GlobalGistData> = {
					data: emptyData,
					lastCleanRemoteData: emptyData,
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
			const cache: GistCache<GlobalGistData> = {
				data,
				lastCleanRemoteData: data,
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

			// Download and parse remote content for comparison
			const fileResult = await this.apiClient.readFile(gistId, fileName);
			if (!fileResult.success || !fileResult.data) {
				// File not found - treat as empty
				if (fileResult.error?.type === SyncErrorType.FileNotFoundError) {
					if (cache.isDirty) {
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

			// Content-based comparison - compare with last known clean remote state
			let hasRemoteChanges: boolean;
			if (cache.lastCleanRemoteData) {
				// Compare remote with last known clean remote (not current cache which includes local changes)
				const workspaceTodosChanged = !isEqual(remoteData.workspaceTodos, cache.lastCleanRemoteData.workspaceTodos);
				const filesDataChanged = !isEqual(remoteData.filesData, cache.lastCleanRemoteData.filesData);
				hasRemoteChanges = workspaceTodosChanged || filesDataChanged;
			} else {
				// Backwards compatibility: first time with new code, don't know last clean state
				// Treat as potentially changed and update lastCleanRemoteData on download/upload
				const workspaceTodosChanged = !isEqual(remoteData.workspaceTodos, cache.data.workspaceTodos);
				const filesDataChanged = !isEqual(remoteData.filesData, cache.data.filesData);
				hasRemoteChanges = workspaceTodosChanged || filesDataChanged;
			}

			// TRUE CONFLICT: Both remote and local have different content
			if (hasRemoteChanges && cache.isDirty) {
				console.log(`[SyncManager] Workspace conflict detected - both remote and local have changes`);
				const choice = await vscode.window.showWarningMessage(
					"Workspace Sync Conflict: Both local and remote data have changes.",
					{ modal: true },
					"Keep Remote",
					"Keep Local",
					"View Gist"
				);

				if (choice === "Keep Local") {
					// Upload local changes, overwrite remote
					console.log(`[SyncManager] User chose to keep local workspace changes`);
					return await this.uploadWorkspace(gistId, fileName, cache);
				} else if (choice === "View Gist") {
					// Open gist in browser for manual resolution
					console.log(`[SyncManager] User chose to view gist`);
					await vscode.env.openExternal(
						vscode.Uri.parse(`https://gist.github.com/${gistId}`)
					);
					this.updateStatus("workspace", SyncStatus.Error);
					return {
						success: false,
						error: {
							type: SyncErrorType.UnknownError,
							message: "User chose to manually resolve conflict",
							timestamp: new Date().toISOString(),
							retryable: true,
						},
					};
				} else {
					// Keep Remote (or user closed dialog)
					console.log(`[SyncManager] User chose to keep remote workspace changes`);
					return await this.downloadWorkspace(gistId, fileName);
				}
			}

			// Remote has changes, local is clean
			if (hasRemoteChanges) {
				console.log(`[SyncManager] Workspace remote changes detected, downloading`);
				return await this.downloadWorkspace(gistId, fileName);
			}

			// Local has changes, upload to remote
			if (cache.isDirty) {
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
				const cache: GistCache<WorkspaceGistData> = {
					data: emptyData,
					lastCleanRemoteData: emptyData,
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
			const cache: GistCache<WorkspaceGistData> = {
				data,
				lastCleanRemoteData: data,
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
