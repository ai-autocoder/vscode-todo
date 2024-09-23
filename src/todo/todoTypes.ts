export interface Todo {
	id: number;
	text: string;
	completed: boolean;
	creationDate: string;
	completionDate?: string;
	isMarkdown: boolean;
	isNote: boolean;
}

export enum TodoScope {
	user = "user",
	workspace = "workspace",
	currentFile = "currentFile",
}

export enum Slices {
	unset = "",
	user = "user",
	workspace = "workspace",
	currentFile = "currentFile",
	fileDataInfo = "fileDataInfo",
	actionTracker = "actionTracker",
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

export interface FileDataInfoSlice {
	editorFocusedFilePath: string;
	workspaceFilesWithRecords: Array<{ filePath: string; todoNumber: number }> | [];
	lastActionType: string;
}

export interface StoreState {
	user: TodoSlice;
	workspace: TodoSlice;
	currentFile: CurrentFileSlice;
	fileDataInfo: FileDataInfoSlice;
	actionTracker: ActionTrackerState;
	[key: string]: TodoSlice | ActionTrackerState | CurrentFileSlice | FileDataInfoSlice;
}

// Middleware
export interface ActionTrackerState {
	lastSliceName: Slices;
}

export interface TodoFilesData {
	[filePath: string]: Todo[];
}

export interface TodoFilesDataPartialInput {
	[filePath: string]: TodoPartialInput[];
}

export type TodoPartialInput = Partial<Omit<Todo, "text">> & Pick<Todo, "text">;

export interface ExportObject {
	user?: Todo[];
	workspace?: Todo[];
	files?: TodoFilesData;
}
export interface ImportObject {
	user?: TodoPartialInput[];
	workspace?: TodoPartialInput[];
	files?: TodoFilesDataPartialInput;
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
