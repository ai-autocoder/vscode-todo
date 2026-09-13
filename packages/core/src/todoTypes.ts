/**
 * Core todo data model — the framework-agnostic shape shared by the VS Code extension
 * and the standalone mobile/PWA companion. This is the canonical definition; the
 * extension's Redux-store-specific types (Slices, StoreState, EditorFocusAndRecordsSlice)
 * live in the extension and are intentionally NOT duplicated here.
 *
 * Anything serialized into a GitHub Gist is built from these types, so they double as the
 * cross-device interop contract.
 */

export interface Todo {
	id: number;
	text: string;
	completed: boolean;
	creationDate: string;
	completionDate?: string;
	isMarkdown: boolean;
	isNote: boolean;
	collapsed?: boolean;
	/**
	 * Optional, normalized list of tags (see {@link normalizeTags}). Absent on items
	 * created before the Tags feature, so existing stored/synced data loads unchanged.
	 */
	tags?: string[];
}

export enum TodoScope {
	user = "user",
	workspace = "workspace",
	currentFile = "currentFile",
}

export type TodoCount = {
	workspace: number;
	user: number;
	currentFile: number;
};

export interface TodoSlice {
	todos: Todo[];
	lastActionType: string;
	numberOfTodos: number;
	numberOfNotes: number;
	scope: TodoScope;
}

export interface CurrentFileSlice extends TodoSlice {
	filePath: string;
	isPinned: boolean;
}

export interface TodoFilesData {
	[filePath: string]: Todo[];
}

export interface TodoFilesDataPathsEntry {
	absPaths: string[];
	relPaths: string[];
}

export interface TodoFilesDataPaths {
	[primaryFilePath: string]: TodoFilesDataPathsEntry;
}

export interface TodoFilesDataPartialInput {
	[filePath: string]: TodoPartialInput[];
}

export type TodoPartialInput = Partial<Omit<Todo, "text">> & Pick<Todo, "text">;

export interface ExportObject {
	user?: Todo[];
	workspace?: Todo[];
	files?: TodoFilesData;
	filesDataPaths?: TodoFilesDataPaths;
}

export interface ImportObject {
	user?: TodoPartialInput[];
	workspace?: TodoPartialInput[];
	files?: TodoFilesDataPartialInput;
	filesDataPaths?: TodoFilesDataPaths;
}

export enum ExportScopes {
	user = "User",
	workspace = "Workspace",
	files = "Files (all)",
	currentFile = "File",
}

export enum MarkdownImportScopes {
	user = "User",
	workspace = "Workspace",
	currentFile = "File",
}

export enum ExportFormats {
	JSON = "json",
	MARKDOWN = "md",
}

export enum ImportFormats {
	JSON = "json",
	MARKDOWN = "md",
}
