/**
 * Sync types for the extension.
 *
 * The on-gist data shapes, the local cache shape, the error/result types and the GitHub API
 * shapes are the **interop contract** with the PWA, so they live in `@vsc-todo/core` and are
 * only re-exported here. This file used to hold a second, hand-maintained copy; the two drifted
 * (core learned `GistResponse.truncated`, core's `GistCache.isDirty` carries a warning the
 * extension's did not) and a type contract that differs between two peers syncing the same file
 * is a contract in name only. Keep importing from `./syncTypes` — the re-export keeps the call
 * sites short — but add new shared shapes to the core module, not here.
 *
 * Only genuinely host-specific things are defined below: the VS Code memento/secret keys.
 */

export {
	GlobalSyncMode,
	WorkspaceSyncMode,
	SyncStatus,
	SyncErrorType,
	GistDirectories,
	DefaultFileNames,
	SYNC_GIST_DESCRIPTION,
	GIST_ID_REGEX,
	FILE_NAME_REGEX,
	GitHubAPI,
	SyncConstants,
} from "../core";

export type {
	GistResponse,
	GistSummary,
	GistFileInfo,
	GlobalGistData,
	WorkspaceGistData,
	GistCache,
	SyncError,
	SyncResult,
	WorkspaceMergeResult,
	FileConflictSet,
	ConflictSet,
} from "../core";

/**
 * Storage keys for different sync modes.
 *
 * Extension-only: these name VS Code mementos and secrets. The two `gistCache_*` keys are
 * deliberately the same strings {@link GistSyncEngine} builds for its own {@link CacheStore}
 * (`gistCache_<scope>_<fileName>`), so the engine reads and writes the cache entries this
 * extension has always used — no migration, and `syncInfo` keeps working.
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
	filesPathsLocal: "filesDataPaths",

	// GitHub auth
	githubToken: "vscodeTodo.sync.githubToken",
} as const;
