/**
 * Todo types for the extension.
 *
 * The data model itself is the cross-device interop contract — everything serialized into a
 * GitHub Gist is built from it — so it lives in `@vsc-todo/core` and is re-exported here rather
 * than kept as a second copy. Only the Redux-store-specific types below are extension-only.
 *
 * Import from here as before; add new *shared* shapes to `packages/core/src/todoTypes.ts`.
 */

import { RootState } from "./store";
import { TodoFilesDataPaths } from "../core";

export {
	TodoScope,
	ExportScopes,
	MarkdownImportScopes,
	ExportFormats,
	ImportFormats,
} from "../core";

export type {
	Todo,
	TodoCount,
	TodoSlice,
	CurrentFileSlice,
	TodoFilesData,
	TodoFilesDataPathsEntry,
	TodoFilesDataPaths,
	TodoFilesDataPartialInput,
	TodoPartialInput,
	ExportObject,
	ImportObject,
} from "../core";

// --- Redux-store-specific (extension only) ---

export enum Slices {
	unset = "",
	user = "user",
	workspace = "workspace",
	currentFile = "currentFile",
	editorFocusAndRecords = "editorFocusAndRecords",
	actionTracker = "actionTracker",
}

export interface EditorFocusAndRecordsSlice {
	editorFocusedFilePath: string;
	workspaceFilesWithRecords: Array<{ filePath: string; todoNumber: number }> | [];
	filesDataPaths: TodoFilesDataPaths;
	lastActionType: string;
}

export interface StoreState extends RootState {}

// Middleware
export interface ActionTrackerState {
	lastSliceName: Slices;
}
