import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import { getConfig } from "../utilities/config";
import { currentFileActions, fileDataInfoActions } from "./store";
import { CurrentFileSlice, Todo, TodoFilesData, TodoScope, TodoSlice } from "./todoTypes";

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
 * Persists the provided slice state to the extension context.
 */
export function persist(state: TodoSlice | CurrentFileSlice, context: ExtensionContext): void {
	switch (state.scope) {
		case TodoScope.user:
			context.globalState.update("TodoData", state.todos);
			break;
		case TodoScope.workspace:
			context.workspaceState.update("TodoData", state.todos);
			break;
		case TodoScope.currentFile: {
			const currentFileState = state as CurrentFileSlice;

			const data = (context.workspaceState.get("TodoFilesData") as TodoFilesData) || {};

			const updatedData: TodoFilesData = {
				...data,
				[currentFileState.filePath]: currentFileState.todos,
			};

			const sortedResult = sortByFileName(updatedData);

			// Only keep the entry if the todos array is not empty
			if (currentFileState.todos.length === 0) {
				delete sortedResult[currentFileState.filePath];
			}

			context.workspaceState.update("TodoFilesData", sortedResult);
			break;
		}
	}
}

/**
 * Generates a unique ID for a todo, prefixed based on the todo scope ('1' for user, '2' for workspace).
 *
 * @param {TodoSlice} state - State containing todos.
 * @param {TodoScope} scope - Scope of the todo (user or workspace).
 * @return {number} Prefixed unique ID within safe integer range.
 */
export function generateUniqueId(todos: Todo[]): number {
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

		if (a.isNote && b.isNote) return 0; // Both are notes, maintain original order

		if (!a.isNote && !b.isNote) {
			// Both are non-notes
			if (isACompleted === isBCompleted) return 0; // Both completed or both non-completed, maintain original order
			if (isACompleted) return 1; // A is completed, B is not, A goes after B
			return -1; // B is completed, A is not, B goes after A
		}

		if (a.isNote) {
			// A is a note, B is a non-note
			if (!isBCompleted) return 0; // B is not completed, maintain original order
			return -1; // B is completed, note goes before
		}

		if (b.isNote) {
			// A is a non-note, B is a note
			if (!isACompleted) return 0; // A is not completed, maintain original order
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
		const fileNameA =
			a
				.split(/[\\\/]/)
				.pop()
				?.toLowerCase() || "";
		const fileNameB =
			b
				.split(/[\\\/]/)
				.pop()
				?.toLowerCase() || "";
		return fileNameA.localeCompare(fileNameB);
	});

	const sortedData: TodoFilesData = {};
	for (const key of keys) {
		sortedData[key] = data[key];
	}

	return sortedData;
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
	if (!previousData[oldPath]) return;

	const state = store.getState();
	const { [oldPath]: renamedFileData, ...restOfData } = previousData;
	const newData: TodoFilesData = { ...restOfData, [newPath]: renamedFileData };
	const sortedNewData = sortByFileName(newData);
	context.workspaceState.update("TodoFilesData", sortedNewData);
	store.dispatch(
		fileDataInfoActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(sortedNewData || {})
		)
	);
	store.dispatch(
		currentFileActions.loadData({
			filePath: state.fileDataInfo.editorFocusedFilePath,
			data: sortedNewData[state.fileDataInfo.editorFocusedFilePath] || [],
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

	if (!previousData[filePath]) return;

	const state = store.getState();
	const { [filePath]: deletedFileData, ...restOfData } = previousData;
	const newData: TodoFilesData = { ...restOfData };
	context.workspaceState.update("TodoFilesData", newData);
	store.dispatch(
		fileDataInfoActions.setWorkspaceFilesWithRecords(getWorkspaceFilesWithRecords(newData || {}))
	);
	if (state.currentFile.filePath === filePath) {
		store.dispatch(
			currentFileActions.loadData({
				filePath: state.fileDataInfo.editorFocusedFilePath,
				data: newData[state.fileDataInfo.editorFocusedFilePath] || [],
			})
		);
	}
}
