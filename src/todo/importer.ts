import path = require("node:path");
import fs = require("fs/promises");
import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import LogChannel from "../utilities/LogChannel";
import { currentFileActions, fileDataInfoActions, userActions, workspaceActions } from "./store";
import { ExportImportData, StoreState, Todo, TodoFilesData, TodoSlice } from "./todoTypes";
import {
	generateUniqueId,
	getWorkspaceFilesWithRecords,
	isEqual,
	persist,
	sortByFileName,
} from "./todoUtils";
import assert = require("node:assert");

enum ImportFormats {
	JSON = "json",
}

async function importCommand(
	context: ExtensionContext,
	format: ImportFormats,
	store: EnhancedStore<StoreState>
) {
	const selectedFile = await selectImportFile(context, format);

	if (!selectedFile || !selectedFile.description?.trim()) {
		vscode.window.showInformationMessage("File selection cancelled.");
		return;
	}

	const rawImportData = await importData(format, selectedFile.description);
	if (!rawImportData) {
		return;
	}
	const state = store.getState();
	if (rawImportData.user?.length) {
		const previousData = state.user.todos;
		const newData = processAndMergeTodos(previousData, rawImportData.user);
		if (!isEqual(previousData, newData)) {
			store.dispatch(
				userActions.loadData({
					data: newData,
				})
			);
			vscode.window.showInformationMessage("User data imported");
			LogChannel.log("User data imported");
		} else {
			vscode.window.showInformationMessage("User data not changed");
			LogChannel.log("User data not changed");
		}
	}
	if (rawImportData.workspace?.length) {
		const previousData = state.workspace.todos;
		const newData = processAndMergeTodos(state.workspace.todos, rawImportData.workspace);
		if (!isEqual(previousData, newData)) {
			store.dispatch(
				workspaceActions.loadData({
					data: newData,
				})
			);
			vscode.window.showInformationMessage("Workspace data imported");
			LogChannel.log("Workspace data imported");
		} else {
			vscode.window.showInformationMessage("Workspace data not changed");
			LogChannel.log("Workspace data not changed");
		}
	}
	if (isTodoFilesData(rawImportData.files)) {
		const previousData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) || {};
		const newData = processAndMergeFilesData(previousData, rawImportData.files);
		const sortedResult = sortByFileName(newData);

		if (!isEqual(previousData, sortedResult)) {
			context.workspaceState.update("TodoFilesData", sortedResult);
			// Update the store
			store.dispatch(
				fileDataInfoActions.setWorkspaceFilesWithRecords(
					getWorkspaceFilesWithRecords(sortedResult || {})
				)
			);
			store.dispatch(
				currentFileActions.loadData({
					filePath: state.fileDataInfo.editorFocusedFilePath,
					data: sortedResult[state.fileDataInfo.editorFocusedFilePath] || [],
				})
			);
			vscode.window.showInformationMessage("Files data imported");
			LogChannel.log("Files data imported");
		} else {
			vscode.window.showInformationMessage("Files data not changed");
			LogChannel.log("Files data not changed");
		}
	}
}

async function selectImportFile(
	context: ExtensionContext,
	format: ImportFormats
): Promise<vscode.QuickPickItem | undefined> {
	const files = await vscode.workspace.findFiles(`*.{${format}}`, "**/node_modules/**");
	if (files.length === 0) {
		vscode.window.showInformationMessage("No files found in the workspace.");
		return undefined;
	}

	const fileQuickPicks = files.map((file) => ({
		label: vscode.workspace.asRelativePath(file),
		description: file.fsPath,
	}));

	return vscode.window.showQuickPick(fileQuickPicks, {
		placeHolder: "Select a file to import data from",
	});
}

async function importData(format: ImportFormats, selectedImportFilePath: string) {
	const fileData = await readFileAsync(selectedImportFilePath);
	if (!fileData) {
		return null;
	}
	const parsedData = parseData(fileData, format);

	if (!isExportImportData(parsedData)) {
		return null;
	}

	return parsedData;
}

async function readFileAsync(filePath: string) {
	try {
		return fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error instanceof Error) {
			const errorText = `Error reading file: ${error.message}`;
			vscode.window.showErrorMessage(errorText);
			LogChannel.log(errorText);
		}
		return null;
	}
}

function parseData(data: string, format: ImportFormats): unknown {
	switch (format) {
		case "json":
			return JSON.parse(data);
	}
}

function isTodoArray(array: any): array is Todo[] {
	return Array.isArray(array) && array.some(isTodo);
}

function isTodo(todo: any): todo is Todo {
	return todo && typeof todo === "object" && "text" in todo;
}

function isTodoFilesData(files: any): files is TodoFilesData {
	if (typeof files !== "object" || files === null) {
		return false;
	}
	return Object.entries(files).some(([key, value]) => key.trim() !== "" && isTodoArray(value));
}

function isExportImportData(parsedData: any): parsedData is ExportImportData {
	if (typeof parsedData !== "object" || parsedData === null) {
		vscode.window.showErrorMessage("Imported data is not in the correct format");
		LogChannel.log("Imported data is not in the correct format");
		return false;
	}
	return (
		(parsedData.user !== undefined && isTodoArray(parsedData.user)) ||
		(parsedData.workspace !== undefined && isTodoArray(parsedData.workspace)) ||
		(parsedData.files !== undefined && isTodoFilesData(parsedData.files))
	);
}

function filterValidTodos(todos: Todo[]): Todo[] {
	return todos.filter((todo) => todo?.text?.trim());
}

function initMissingTodoProperties(validImportData: Todo[], previousData: Todo[]): Todo[] {
	return validImportData.map((todo) => ({
		...todo,
		id: todo.id,
		text: todo.text.trim(),
		completed: todo.completed ?? false,
		isMarkdown: todo.isMarkdown ?? false,
		isNote: todo.isNote ?? false,
		creationDate: todo.creationDate ?? new Date().toISOString(),
		completionDate: todo.completed ? todo.completionDate ?? new Date().toISOString() : undefined,
	}));
}

function mergeTodoArrays(previousTodos: Todo[], importedTodos: Todo[]): Todo[] {
	const lookupMap = new Map<number, Todo>();
	previousTodos.forEach((todo) => {
		lookupMap.set(todo.id, { ...todo });
	});
	importedTodos.forEach((todo) => {
		// Check if the ID is present in the imported todo
		if (!todo.id) {
			todo.id = generateUniqueId(Array.from(lookupMap.values()));
		}
		if (lookupMap.has(todo.id)) {
			// If the ID exists in the lookup map, merge properties
			lookupMap.set(todo.id, { ...lookupMap.get(todo.id), ...todo });
		} else {
			// If the ID does not exist, add the new todo object
			lookupMap.set(todo.id, { ...todo });
		}
	});
	return Array.from(lookupMap.values());
}

function mergeTodoFilesData(
	previousData: TodoFilesData,
	validImportData: TodoFilesData
): TodoFilesData {
	const lookupMap = new Map<string, Todo[]>();
	for (const filePath in previousData) {
		lookupMap.set(filePath, [...previousData[filePath]]);
	}

	for (const filePath in validImportData) {
		if (
			lookupMap.has(filePath) &&
			Array.isArray(lookupMap.get(filePath)) &&
			lookupMap.get(filePath)!.length > 0
		) {
			// If a todos record for the file path exists in the lookup map, merge the todo arrays
			const previousTodos = lookupMap.get(filePath);
			const validImportTodos = validImportData[filePath];
			const mergedTodos = mergeTodoArrays(previousTodos!, validImportTodos);
			lookupMap.set(filePath, [...mergedTodos]);
		} else {
			// If a record for the file path does not exists, add it
			lookupMap.set(filePath, [...validImportData[filePath]]);
		}
	}
	return Object.fromEntries(lookupMap);
}

function processAndMergeTodos(previousData: Todo[], rawImportData: Todo[]) {
	const validImportData: Todo[] = filterValidTodos(rawImportData);
	const mergedTodos: Todo[] = mergeTodoArrays(previousData, validImportData);
	return initMissingTodoProperties(mergedTodos, previousData);
}

function processAndMergeFilesData(previousData: TodoFilesData, rawImportData: TodoFilesData) {
	const validImportData = filterValidFilesData(rawImportData);
	return mergeTodoFilesData(previousData, validImportData);
}

function filterValidFilesData(rawImportData: TodoFilesData): TodoFilesData {
	const filteredData: TodoFilesData = {};

	for (const filePath in rawImportData) {
		if (typeof filePath === "string" && filePath.trim()) {
			const validTodos = filterValidTodos(rawImportData[filePath]);
			if (validTodos.length > 0) {
				filteredData[filePath] = validTodos;
			}
		}
	}

	return filteredData;
}

let tests = {
	filterValidFilesData,
	isTodoFilesData,
	isTodoArray,
	isExportImportData,
};
if (process.env.NODE_ENV !== "test") {
	// @ts-ignore
	tests = {};
}

export { importCommand, ImportFormats, tests };
