/**
 * Sync types and interfaces for the GitHub Gist sync feature. These describe the exact
 * on-gist data shapes and the local cache structure, so they are the interop contract
 * between the VS Code extension and the mobile/PWA companion.
 */

import { Todo, TodoFilesData, TodoFilesDataPaths } from "./todoTypes";
// Type-only import (erased at runtime, so no circular dependency). ConflictSet is defined
// canonically in threeWayMerge; we reuse it here for WorkspaceMergeResult.
import type { ConflictSet } from "./threeWayMerge";

/**
 * Sync modes for global scope
 */
export enum GlobalSyncMode {
	/** Local storage (globalState) - this device only */
	Local = "local",
	/** VS Code Settings Sync - syncs via VS Code profile */
	ProfileSync = "profile-sync",
	/** GitHub Gist - syncs via GitHub Gist */
	GitHub = "github",
}

/**
 * Sync modes for workspace scope
 */
export enum WorkspaceSyncMode {
	/** Local storage (workspaceState) - this device only */
	Local = "local",
	/** GitHub Gist - syncs via GitHub Gist */
	GitHub = "github",
}

/**
 * Sync status indicators
 */
export enum SyncStatus {
	/** Synced and up-to-date */
	Synced = "synced",
	/** Unsaved changes pending sync */
	Dirty = "dirty",
	/** Sync in progress */
	Syncing = "syncing",
	/** Error occurred */
	Error = "error",
	/** Offline/not connected */
	Offline = "offline",
}

/**
 * GitHub Gist API response structure
 */
export interface GistResponse {
	id: string;
	description: string;
	public: boolean;
	files: {
		[filename: string]: {
			filename: string;
			type: string;
			language: string;
			raw_url: string;
			size: number;
			content?: string;
			truncated?: boolean;
		};
	};
	created_at: string;
	updated_at: string;
	owner: {
		login: string;
		id: number;
	};
}

/**
 * Summary info for gist picker
 */
export interface GistSummary {
	id: string;
	description: string;
	isPublic: boolean;
	filesCount: number;
	updatedAt: string;
}

/**
 * Simplified gist file info for file picker
 */
export interface GistFileInfo {
	/** Filename without directory prefix (e.g., "todos", "Work", "Personal") */
	displayName: string;
	/** Full filename with directory (e.g., "user-todos.json", "workspace-ProjectAlpha.json") */
	fullPath: string;
	/** File size in bytes */
	size: number;
}

/**
 * Global scope data structure stored in gist
 */
export interface GlobalGistData {
	/** Global todo items */
	userTodos: Todo[];
}

/**
 * Workspace scope data structure stored in gist
 */
export interface WorkspaceGistData {
	/** Workspace todo items */
	workspaceTodos: Todo[];
	/** File-specific todos (absolute primary paths as keys) */
	filesData: TodoFilesData;
	/** Optional file path aliases for cross-device mapping */
	filesDataPaths?: TodoFilesDataPaths;
}

/**
 * Local cache structure for gist data
 */
export interface GistCache<T> {
	/** Cached data (may include local modifications if isDirty=true) */
	data: T;
	/** Last known clean remote state (used to detect actual remote changes) */
	lastCleanRemoteData?: T;
	/** ISO timestamp of last successful sync */
	lastSynced: string;
	/** Whether there are unsaved local changes */
	isDirty: boolean;
}

/**
 * Sync error types
 */
export enum SyncErrorType {
	NetworkError = "network",
	AuthError = "auth",
	NotFoundError = "not-found",
	RateLimitError = "rate-limit",
	ConflictError = "conflict",
	InvalidGistIdError = "invalid-gist-id",
	FileNotFoundError = "file-not-found",
	ValidationError = "validation",
	UnknownError = "unknown",
}

/**
 * Sync error with details
 */
export interface SyncError {
	type: SyncErrorType;
	message: string;
	/** Underlying error object */
	error?: Error;
	/** Timestamp of error */
	timestamp: string;
	/** Whether the operation can be retried */
	retryable: boolean;
}

/**
 * Sync operation result
 */
export interface SyncResult<T = void> {
	success: boolean;
	data?: T;
	error?: SyncError;
}

/**
 * Directory prefixes for gist files
 * NOTE: GitHub Gist does not support actual directories (no forward slashes allowed)
 * Using hyphen separator instead to organize files logically
 */
export const GistDirectories = {
	user: "user-",
	workspace: "workspace-",
} as const;

/**
 * Default file names
 */
export const DefaultFileNames = {
	user: "user-todos.json",
	workspace: (workspaceName: string) => `workspace-${workspaceName}.json`,
} as const;

/** Description the extension stamps on the sync gist; used for auto-discovery. */
export const SYNC_GIST_DESCRIPTION = "VS Code Todo Sync";

/**
 * Validation regex for gist ID (32-char hex)
 */
export const GIST_ID_REGEX = /^[a-f0-9]{32}$/i;

/**
 * Validation regex for file names (no illegal filesystem characters)
 */
export const FILE_NAME_REGEX = /^[^\\/:*?"<>|]+$/;

/**
 * GitHub API endpoints
 */
export const GitHubAPI = {
	gists: "https://api.github.com/gists",
	gist: (id: string) => `https://api.github.com/gists/${id}`,
} as const;

/**
 * Workspace-specific merge result for three-way merge
 */
export interface WorkspaceMergeResult {
	/** Workspace todos that were successfully auto-merged */
	autoMergedWorkspaceTodos: Todo[];
	/** Files data that was successfully auto-merged */
	autoMergedFilesData: TodoFilesData;
	/** Files path aliases that were successfully auto-merged */
	autoMergedFilesDataPaths: TodoFilesDataPaths;
	/** Workspace todo conflicts that require user resolution */
	workspaceConflicts: ConflictSet[];
	/** File path conflicts (file added/removed/modified in conflicting ways) */
	fileConflicts: FileConflictSet[];
}

/**
 * Represents a conflict in the filesData dictionary
 */
export interface FileConflictSet {
	/** The file path that has a conflict */
	filePath: string;
	/** The base version (from lastCleanRemoteData), null if didn't exist in base */
	base: Todo[] | null;
	/** The local version, null if deleted locally */
	local: Todo[] | null;
	/** The remote version, null if deleted remotely */
	remote: Todo[] | null;
	/** Type of conflict detected */
	conflictType: "file-added-both" | "file-edit-edit" | "file-edit-delete" | "file-delete-edit";
}

/**
 * Sync configuration constants
 */
export const SyncConstants = {
	/** Minimum poll interval in seconds */
	minPollInterval: 30,
	/** Maximum poll interval in seconds */
	maxPollInterval: 600,
	/** Default poll interval in seconds */
	defaultPollInterval: 180,
	/** Debounce delay for local changes in milliseconds */
	debounceDelay: 3000,
	/** GitHub OAuth scope required */
	githubScope: "gist",
	/** Retry delay for rate limit errors in milliseconds */
	rateLimitRetryDelay: 900000, // 15 minutes
} as const;
