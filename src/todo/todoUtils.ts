import { EnhancedStore } from "@reduxjs/toolkit";
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
	if (!previousData[oldPath]) {
		return;
	}

	const state = store.getState();
	const { [oldPath]: renamedFileData, ...restOfData } = previousData;
	const newData: TodoFilesData = { ...restOfData, [newPath]: renamedFileData };
	const sortedNewData = sortByFileName(newData);
	context.workspaceState.update("TodoFilesData", sortedNewData);
	store.dispatch(
		editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(sortedNewData || {})
		)
	);
	store.dispatch(
		currentFileActions.loadData({
			filePath: state.editorFocusAndRecords.editorFocusedFilePath,
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

	if (!previousData[filePath]) {
		return;
	}

	const state: StoreState = store.getState();
	const { [filePath]: deletedFileData, ...restOfData } = previousData;
	const newData: TodoFilesData = { ...restOfData };
	context.workspaceState.update("TodoFilesData", newData);
	store.dispatch(
		editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(newData || {})
		)
	);
	if (state.currentFile.filePath === filePath) {
		store.dispatch(
			currentFileActions.loadData({
				filePath: state.editorFocusAndRecords.editorFocusedFilePath,
				data: newData[state.editorFocusAndRecords.editorFocusedFilePath] || [],
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
