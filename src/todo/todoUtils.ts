import { EnhancedStore } from "@reduxjs/toolkit";
import path = require("node:path");
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import { getConfig } from "../utilities/config";
import {
	currentFileActions,
	editorFocusAndRecordsActions,
	userActions,
	workspaceActions,
} from "./store";
import {
	CurrentFileSlice,
	StoreState,
	Todo,
	TodoFilesData,
	TodoFilesDataPaths,
	TodoFilesDataPathsEntry,
	TodoPartialInput,
	TodoScope,
	TodoSlice,
} from "./todoTypes";

/**
 * Calculate the number of incomplete todos in the given state.
 *
 * @param state - The slice state array.
 * @return The number of todos in the array.
 */
export function getNumberOfTodos(state: TodoSlice): number {
	return state?.todos.filter((todo) => !todo.completed && !todo.isNote).length ?? 0;
}

/**
 * Calculate the number of notes in the given state.
 *
 * @param state - The slice state array.
 * @return The number of notes in the array.
 */
export function getNumberOfNotes(state: TodoSlice): number {
	return state?.todos.filter((todo) => todo.isNote).length ?? 0;
}


/**
 * Generates a unique ID that does not already exist in the provided array of todos.
 *
 * @param todos - The array of todos to check for existing IDs.
 * @return A unique ID that is not already in use.
 */
export function generateUniqueId(todos: Todo[] | TodoPartialInput[]): number {
	let newId: number;
	const maxRandom = Number.MAX_SAFE_INTEGER / 10;

	do {
		newId = Math.floor(Math.random() * maxRandom);
	} while (todos.some((todo) => todo.id === newId));

	return newId;
}

/**
 * Sorts an array of todos according to the configuration.
 *
 * @param {Todo[]} todos - The array of todos and notes to be sorted.
 * @return {Todo[]} A new array of todos sorted according to the specified rules.
 */
export function sortTodosWithNotes(todos: Todo[]): Todo[] {
	const { taskSortingOptions } = getConfig();

	switch (taskSortingOptions) {
		case "disabled":
			return todos;
		case "sortType1":
			return sortType1(todos);
		case "sortType2":
			return sortType2(todos);
	}
}

/**
 * Sorts an array of todos by their completion status.
 */
function sortType1(todos: Todo[]) {
	return todos.slice().sort((a, b) => {
		const isACompleted = !a.isNote && a.completed;
		const isBCompleted = !b.isNote && b.completed;

		if (a.isNote && b.isNote) {
			return 0;
		} // Both are notes, maintain original order

		if (!a.isNote && !b.isNote) {
			// Both are non-notes
			if (isACompleted === isBCompleted) {
				return 0;
			} // Both completed or both non-completed, maintain original order
			if (isACompleted) {
				return 1;
			} // A is completed, B is not, A goes after B
			return -1; // B is completed, A is not, B goes after A
		}

		if (a.isNote) {
			// A is a note, B is a non-note
			if (!isBCompleted) {
				return 0;
			} // B is not completed, maintain original order
			return -1; // B is completed, note goes before
		}

		if (b.isNote) {
			// A is a non-note, B is a note
			if (!isACompleted) {
				return 0;
			} // A is not completed, maintain original order
			return 1; // A is completed, note goes before
		}

		return 0; // Fallback to maintain original order
	});
}

/**Sorts an array of todos by their completion status
 * within groups defined by note items.
 */
function sortType2(todos: Todo[]) {
	let currentGroup = 0;
	const mappedTodos = todos.map((todo, index) => ({
		originalIndex: index,
		todo,
		group: todo.isNote ? ++currentGroup : currentGroup,
	}));

	const sortedMappedTodos = mappedTodos.sort((a, b) => {
		if (a.group !== b.group) {
			return a.group - b.group;
		}
		if (!a.todo.isNote && !b.todo.isNote) {
			return Number(a.todo.completed) - Number(b.todo.completed);
		}
		return a.originalIndex - b.originalIndex;
	});

	return sortedMappedTodos.map((mappedItem) => mappedItem.todo);
}

/**
 * Retrieves workspace files with todo records attached.
 *
 * @param fileData - the data containing files and their todos
 * @return An array of objects containing file paths and todo numbers
 */
export function getWorkspaceFilesWithRecords(
	fileData: TodoFilesData
): Array<{ filePath: string; todoNumber: number }> {
	return Object.entries(fileData).map(([filePath, todos]) => ({
		filePath,
		todoNumber: todos.filter((todo) => !todo.completed && !todo.isNote).length,
	}));
}

/**
 * Sorts the keys in the object by file name.
 *
 * @param data - The data object to be sorted.
 * @returns The sorted data object.
 */
export function sortByFileName(data: TodoFilesData = {}): TodoFilesData {
	const keys = Object.keys(data).sort((a, b) => {
		const fileNameA = a.split(/[\/]/).pop()?.toLowerCase() || "";
		const fileNameB = b.split(/[\/]/).pop()?.toLowerCase() || "";
		return fileNameA.localeCompare(fileNameB);
	});

	const sortedData: TodoFilesData = {};
	for (const key of keys) {
		sortedData[key] = data[key];
	}

	return sortedData;
}

export type FilesDataPathIndexes = {
	absIndex: Record<string, string>;
	relIndex: Record<string, string>;
};

export function normalizeAbsolutePath(filePath: string): string {
	const normalized = path.normalize(filePath);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeRelativePath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const posixPath = path.posix.normalize(normalized);
	return posixPath.startsWith("./") ? posixPath.slice(2) : posixPath;
}

function getWorkspaceFolderPathForFile(filePath: string): string | null {
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
	return folder?.uri.fsPath ?? null;
}

export function getRelativePathIfInsideWorkspace(
	filePath: string,
	workspaceRoot?: string | null
): string | null {
	const root = workspaceRoot ?? getWorkspaceFolderPathForFile(filePath) ?? getWorkspacePath();
	if (!root) {
		return null;
	}

	const relPath = path.relative(root, filePath);
	if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
		return null;
	}

	return normalizeRelativePath(relPath);
}

export function buildFilesDataPathIndexes(
	filesData: TodoFilesData,
	filesDataPaths: TodoFilesDataPaths
): FilesDataPathIndexes {
	const absIndex: Record<string, string> = {};
	const relIndex: Record<string, string> = {};

	for (const primaryKey of Object.keys(filesData)) {
		absIndex[normalizeAbsolutePath(primaryKey)] = primaryKey;
	}

	for (const [primaryKey, entry] of Object.entries(filesDataPaths)) {
		const absPaths = Array.isArray(entry?.absPaths) ? entry.absPaths : [];
		const relPaths = Array.isArray(entry?.relPaths) ? entry.relPaths : [];

		for (const absPath of absPaths) {
			const normalized = normalizeAbsolutePath(absPath);
			if (!(normalized in absIndex)) {
				absIndex[normalized] = primaryKey;
			}
		}

		for (const relPath of relPaths) {
			const normalized = normalizeRelativePath(relPath);
			if (!(normalized in relIndex)) {
				relIndex[normalized] = primaryKey;
			}
		}
	}

	return { absIndex, relIndex };
}

export function resolveFilesDataKey({
	filePath,
	filesData,
	filesDataPaths,
}: {
	filePath: string;
	filesData: TodoFilesData;
	filesDataPaths: TodoFilesDataPaths;
}): { key: string | null; relPath: string | null } {
	const relPath = getRelativePathIfInsideWorkspace(filePath);

	if (Object.prototype.hasOwnProperty.call(filesData, filePath)) {
		return { key: filePath, relPath };
	}

	if (relPath && Object.prototype.hasOwnProperty.call(filesData, relPath)) {
		return { key: relPath, relPath };
	}

	const { absIndex, relIndex } = buildFilesDataPathIndexes(filesData, filesDataPaths);
	const absKey = absIndex[normalizeAbsolutePath(filePath)];
	if (absKey) {
		return { key: absKey, relPath };
	}

	if (relPath) {
		const relKey = relIndex[normalizeRelativePath(relPath)];
		if (relKey) {
			return { key: relKey, relPath };
		}
	}

	return { key: null, relPath };
}

function addUniquePath(
	list: string[],
	value: string,
	normalize: (value: string) => string
): void {
	const normalizedValue = normalize(value);
	if (list.some((item) => normalize(item) === normalizedValue)) {
		return;
	}
	list.push(value);
}

function removeNormalizedPath(
	list: string[],
	value: string,
	normalize: (value: string) => string
): string[] {
	const normalizedValue = normalize(value);
	return list.filter((item) => normalize(item) !== normalizedValue);
}

function normalizePathEntry(entry?: TodoFilesDataPathsEntry): {
	absPaths: string[];
	relPaths: string[];
} {
	const absPaths: string[] = [];
	const relPaths: string[] = [];

	if (entry && Array.isArray(entry.absPaths)) {
		for (const absPath of entry.absPaths) {
			addUniquePath(absPaths, absPath, normalizeAbsolutePath);
		}
	}

	if (entry && Array.isArray(entry.relPaths)) {
		for (const relPath of entry.relPaths) {
			const normalizedRel = normalizeRelativePath(relPath);
			addUniquePath(relPaths, normalizedRel, normalizeRelativePath);
		}
	}

	return { absPaths, relPaths };
}

export function ensureFilesDataPaths(
	filesData: TodoFilesData,
	filesDataPaths: TodoFilesDataPaths | undefined,
	workspaceRoot?: string | null
): TodoFilesDataPaths {
	const updated: TodoFilesDataPaths = {};
	const source = filesDataPaths ?? {};

	for (const primaryKey of Object.keys(filesData)) {
		const entry = normalizePathEntry(source[primaryKey]);

		if (path.isAbsolute(primaryKey)) {
			addUniquePath(entry.absPaths, primaryKey, normalizeAbsolutePath);
			const relPath = getRelativePathIfInsideWorkspace(primaryKey, workspaceRoot);
			if (relPath) {
				addUniquePath(entry.relPaths, relPath, normalizeRelativePath);
			}
		} else {
			const normalizedRel = normalizeRelativePath(primaryKey);
			addUniquePath(entry.relPaths, normalizedRel, normalizeRelativePath);
		}

		updated[primaryKey] = entry;
	}

	return updated;
}

export function upsertFilesDataPathEntry({
	filesDataPaths,
	primaryKey,
	absPath,
	relPath,
}: {
	filesDataPaths: TodoFilesDataPaths;
	primaryKey: string;
	absPath: string;
	relPath: string | null;
}): void {
	const entry = filesDataPaths[primaryKey] ?? { absPaths: [], relPaths: [] };

	addUniquePath(entry.absPaths, primaryKey, normalizeAbsolutePath);
	addUniquePath(entry.absPaths, absPath, normalizeAbsolutePath);

	if (relPath) {
		const normalizedRel = normalizeRelativePath(relPath);
		addUniquePath(entry.relPaths, normalizedRel, normalizeRelativePath);
	}

	filesDataPaths[primaryKey] = entry;
}

export function getWorkspacePath() {
	// Check if there is any workspace folder open
	if (!vscode.workspace.workspaceFolders) {
		return null; // No workspace open
	}

	// Retrieve the path of the first workspace folder
	const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;

	return workspacePath;
}

export function isEqual(a: Object, b: Object) {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function updateDataForRenamedFile({
	context,
	oldPath,
	newPath,
	store,
}: {
	context: ExtensionContext;
	oldPath: string;
	newPath: string;
	store: EnhancedStore;
}) {
	const previousData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) || {};
	const previousPaths =
		(context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) || {};
	const resolved = resolveFilesDataKey({
		filePath: oldPath,
		filesData: previousData,
		filesDataPaths: previousPaths,
	});
	if (!resolved.key) {
		return;
	}

	const oldRelPath = getRelativePathIfInsideWorkspace(oldPath);
	const newRelPath = getRelativePathIfInsideWorkspace(newPath);
	let newData: TodoFilesData = { ...previousData };
	let newPaths: TodoFilesDataPaths = { ...previousPaths };

	const updateEntryPaths = (entry: TodoFilesDataPathsEntry) => {
		entry.absPaths = removeNormalizedPath(entry.absPaths, oldPath, normalizeAbsolutePath);
		addUniquePath(entry.absPaths, newPath, normalizeAbsolutePath);

		if (oldRelPath) {
			entry.relPaths = removeNormalizedPath(entry.relPaths, oldRelPath, normalizeRelativePath);
		}
		if (newRelPath) {
			addUniquePath(entry.relPaths, newRelPath, normalizeRelativePath);
		}
	};

	if (resolved.key === oldPath && Object.prototype.hasOwnProperty.call(previousData, oldPath)) {
		const { [oldPath]: renamedFileData, ...restOfData } = previousData;
		newData = { ...restOfData, [newPath]: renamedFileData };
		const entry = normalizePathEntry(newPaths[oldPath]);
		delete newPaths[oldPath];
		updateEntryPaths(entry);
		newPaths[newPath] = entry;
		upsertFilesDataPathEntry({
			filesDataPaths: newPaths,
			primaryKey: newPath,
			absPath: newPath,
			relPath: newRelPath,
		});
	} else {
		const entry = normalizePathEntry(newPaths[resolved.key]);
		updateEntryPaths(entry);
		newPaths[resolved.key] = entry;
	}

	const sortedNewData = sortByFileName(newData);
	newPaths = ensureFilesDataPaths(sortedNewData, newPaths, getWorkspacePath());
	context.workspaceState.update("TodoFilesData", sortedNewData);
	context.workspaceState.update("TodoFilesDataPaths", newPaths);
	store.dispatch(
		editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(sortedNewData || {})
		)
	);
	const state = store.getState();
	const targetFilePath = state.editorFocusAndRecords.editorFocusedFilePath;
	const targetResolved = resolveFilesDataKey({
		filePath: targetFilePath,
		filesData: sortedNewData,
		filesDataPaths: newPaths,
	});
	store.dispatch(
		currentFileActions.loadData({
			filePath: targetFilePath,
			data: targetResolved.key ? sortedNewData[targetResolved.key] ?? [] : [],
		})
	);
}

export function removeDataForDeletedFile({
	filePath,
	context,
	store,
}: {
	filePath: string;
	context: ExtensionContext;
	store: EnhancedStore;
}) {
	const previousData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) || {};
	const previousPaths =
		(context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) || {};
	const resolved = resolveFilesDataKey({
		filePath,
		filesData: previousData,
		filesDataPaths: previousPaths,
	});
	if (!resolved.key) {
		return;
	}

	const relPath = resolved.relPath ?? getRelativePathIfInsideWorkspace(filePath);
	let newData: TodoFilesData = { ...previousData };
	let newPaths: TodoFilesDataPaths = { ...previousPaths };
	const entry = normalizePathEntry(newPaths[resolved.key]);

	entry.absPaths = removeNormalizedPath(entry.absPaths, filePath, normalizeAbsolutePath);
	if (relPath) {
		entry.relPaths = removeNormalizedPath(entry.relPaths, relPath, normalizeRelativePath);
	}

	if (resolved.key === filePath) {
		if (entry.absPaths.length > 0) {
			const promotedKey = entry.absPaths[0];
			if (promotedKey !== resolved.key && Object.prototype.hasOwnProperty.call(newData, resolved.key)) {
				const { [resolved.key]: deletedFileData, ...restOfData } = newData;
				newData = { ...restOfData, [promotedKey]: deletedFileData };
				delete newPaths[resolved.key];
				newPaths[promotedKey] = entry;
				const promotedRelPath = getRelativePathIfInsideWorkspace(promotedKey);
				upsertFilesDataPathEntry({
					filesDataPaths: newPaths,
					primaryKey: promotedKey,
					absPath: promotedKey,
					relPath: promotedRelPath,
				});
			} else {
				newPaths[resolved.key] = entry;
			}
		} else {
			delete newData[resolved.key];
			delete newPaths[resolved.key];
		}
	} else if (entry.absPaths.length === 0 && entry.relPaths.length === 0) {
		delete newPaths[resolved.key];
	} else {
		newPaths[resolved.key] = entry;
	}

	const sortedData = sortByFileName(newData);
	newPaths = ensureFilesDataPaths(sortedData, newPaths, getWorkspacePath());
	context.workspaceState.update("TodoFilesData", sortedData);
	context.workspaceState.update("TodoFilesDataPaths", newPaths);
	store.dispatch(
		editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(sortedData || {})
		)
	);
	const state: StoreState = store.getState();
	if (state.currentFile.filePath === filePath) {
		const targetFilePath = state.editorFocusAndRecords.editorFocusedFilePath;
		const targetResolved = resolveFilesDataKey({
			filePath: targetFilePath,
			filesData: sortedData,
			filesDataPaths: newPaths,
		});
		store.dispatch(
			currentFileActions.loadData({
				filePath: targetFilePath,
				data: targetResolved.key ? sortedData[targetResolved.key] ?? [] : [],
			})
		);
	}
}

export function assertNever(x: never, message?: string): never {
	const err = new Error(message ?? "Unexpected value. Should have been never.");
	//Cut off first line of the stack so that it points to the assertNever call
	err.stack = err.stack?.split("\n").slice(1).join("\n");
	throw err;
}

export function deleteCompletedTodos(store: EnhancedStore) {
	const { autoDeleteCompletedAfterDays } = getConfig();
	if (autoDeleteCompletedAfterDays <= 0) {
		return;
	}

	const now = new Date();
	const userState = store.getState().user;
	const workspaceState = store.getState().workspace;

	const getTodosToDelete = (todos: Todo[]) => {
		return todos.filter((todo) => {
			if (!todo.isNote && todo.completed && todo.completionDate) {
				const completionDate = new Date(todo.completionDate);
				const diffInDays = (now.getTime() - completionDate.getTime()) / (1000 * 3600 * 24);
				return diffInDays > autoDeleteCompletedAfterDays;
			}
			return false;
		});
	};

	const userTodosToDelete = getTodosToDelete(userState.todos);
	const workspaceTodosToDelete = getTodosToDelete(workspaceState.todos);

	if (userTodosToDelete.length > 0) {
		store.dispatch(userActions.deleteTodos({ ids: userTodosToDelete.map((todo) => todo.id) }));
	}

	if (workspaceTodosToDelete.length > 0) {
		store.dispatch(
			workspaceActions.deleteTodos({ ids: workspaceTodosToDelete.map((todo) => todo.id) })
		);
	}
}

export function deleteCompletedTodosCurrentFile(store: EnhancedStore) {
	const { autoDeleteCompletedAfterDays } = getConfig();
	if (autoDeleteCompletedAfterDays <= 0) {
		return;
	}

	const now = new Date();
	const currentFileState = store.getState().currentFile;

	const getTodosToDelete = (todos: Todo[]) => {
		return todos.filter((todo) => {
			if (!todo.isNote && todo.completed && todo.completionDate) {
				const completionDate = new Date(todo.completionDate);
				const diffInDays = (now.getTime() - completionDate.getTime()) / (1000 * 3600 * 24);
				return diffInDays > autoDeleteCompletedAfterDays;
			}
			return false;
		});
	};

	const currentFileTodosToDelete = getTodosToDelete(currentFileState.todos);

	if (currentFileTodosToDelete.length > 0) {
		store.dispatch(
			currentFileActions.deleteTodos({ ids: currentFileTodosToDelete.map((todo) => todo.id) })
		);
	}
}
