/**
 * Sync Types and Interfaces
 * Types for GitHub Gist sync feature (v1.18.0)
 */

import { Todo, TodoFilesData } from "../todo/todoTypes";

/**
 * Sync modes for global scope
 */
export enum GlobalSyncMode {
	/** Local storage (globalState) - this device only */
	Local = "local",
	/** VS Code Settings Sync - syncs via VS Code profile */
	ProfileSync = "profile-sync",
	/** GitHub Gist - syncs via manually-created gist */
	GitHub = "github",
}

/**
 * Sync modes for workspace scope
 */
export enum WorkspaceSyncMode {
	/** Local storage (workspaceState) - this device only */
	Local = "local",
	/** GitHub Gist - syncs via manually-created gist */
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
 * Simplified gist file info for file picker
 */
export interface GistFileInfo {
	/** Filename without directory prefix (e.g., "todos", "Work", "Personal") */
	displayName: string;
	/** Full filename with directory (e.g., "global/todos.json", "workspace/ProjectAlpha.json") */
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
	/** File-specific todos (relative paths as keys) */
	filesData: TodoFilesData;
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
 * Sync configuration settings
 */
export interface SyncSettings {
	/** Global sync mode */
	globalMode: GlobalSyncMode;
	/** Workspace sync mode */
	workspaceMode: WorkspaceSyncMode;
	/** GitHub gist ID (32-char hex string) */
	gistId?: string;
	/** Global file path in gist (e.g., "global/todos.json") */
	globalFile: string;
	/** Workspace file path in gist (e.g., "workspace/ProjectAlpha.json") */
	workspaceFile: string;
	/** Poll interval in seconds (30-600) */
	pollInterval: number;
	/** Whether GitHub sync is enabled */
	githubEnabled: boolean;
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
 * Storage keys for different sync modes
 */
export const StorageKeys = {
	// Global scope
	globalLocal: "globalTodos",
	globalProfileSync: "vscodeTodo.globalTodos",
	globalGistCache: (fileName: string) => `gistCache_global_${fileName}`,

	// Workspace scope
	workspaceLocal: "workspaceTodos",
	workspaceGistCache: (fileName: string) => `gistCache_workspace_${fileName}`,

	// File scope
	filesLocal: "filesData",

	// GitHub auth
	githubToken: "vscodeTodo.sync.githubToken",
} as const;

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
