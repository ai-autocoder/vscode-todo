import path = require("node:path");
import fs = require("fs/promises");
import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import LogChannel from "../utilities/LogChannel";
import {
	currentFileActions,
	editorFocusAndRecordsActions,
	userActions,
	workspaceActions,
} from "./store";
import {
	ImportFormats,
	ImportObject,
	MarkdownImportScopes,
	StoreState,
	Todo,
	TodoFilesData,
	TodoFilesDataPartialInput,
	TodoPartialInput,
} from "./todoTypes";
import {
	generateUniqueId,
	getWorkspaceFilesWithRecords,
	isEqual,
	sortByFileName,
} from "./todoUtils";

async function importCommand(
	context: ExtensionContext,
	format: ImportFormats,
	store: EnhancedStore<StoreState>
) {
	const selectedFile = await getImportFile(format);
	if (!selectedFile || !selectedFile.description?.trim()) {
		vscode.window.showInformationMessage("File selection cancelled.");
		return;
	}

	const rawImportData = await importData(format, selectedFile.description, store.getState());
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
	if (isTodoFilesDataPartialInput(rawImportData.files)) {
		const previousData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) || {};
		const newData = processAndMergeFilesData(previousData, rawImportData.files);
		const sortedResult = sortByFileName(newData);

		if (!isEqual(previousData, sortedResult)) {
			context.workspaceState.update("TodoFilesData", sortedResult);
			// Update the store
			store.dispatch(
				editorFocusAndRecordsActions.setWorkspaceFilesWithRecords(
					getWorkspaceFilesWithRecords(sortedResult || {})
				)
			);
			store.dispatch(
				currentFileActions.loadData({
					filePath: state.editorFocusAndRecords.editorFocusedFilePath,
					data: sortedResult[state.editorFocusAndRecords.editorFocusedFilePath] || [],
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

async function getImportFile(format: ImportFormats): Promise<vscode.QuickPickItem | undefined> {
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

async function importData(
	format: ImportFormats,
	selectedImportFilePath: string,
	state: StoreState
) {
	const fileData = await readFileAsync(selectedImportFilePath);
	if (!fileData) {
		return null;
	}

	let scope: MarkdownImportScopes | undefined;
	if (format === ImportFormats.MARKDOWN) {
		scope = await getImportScope(state);
		if (!scope) {
			vscode.window.showInformationMessage("Import cancelled.");
			return;
		}
	}

	const parsedData = parseData({ data: fileData, format, scope, state });

	if (!isImportObject(parsedData)) {
		vscode.window.showInformationMessage("Imported data is not in the correct format.");
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

function parseData({
	data,
	format,
	scope,
	state,
}: {
	data: string;
	format: ImportFormats;
	scope?: MarkdownImportScopes;
	state: StoreState;
}): unknown {
	switch (format) {
		case ImportFormats.JSON:
			return JSON.parse(data);
		case ImportFormats.MARKDOWN:
			return parseMarkdown(data, scope as MarkdownImportScopes, state);
		default:
			return undefined;
	}
}

function isTodoPartialInput(array: any): array is TodoPartialInput[] {
	return Array.isArray(array) && array.some(isTodo);
}

function isTodo(todo: any): todo is TodoPartialInput {
	return todo && typeof todo === "object" && "text" in todo;
}

function isTodoFilesDataPartialInput(files: any): files is TodoFilesDataPartialInput {
	if (typeof files !== "object" || files === null) {
		return false;
	}
	return Object.entries(files).some(
		([key, value]) => key.trim() !== "" && isTodoPartialInput(value)
	);
}

function isImportObject(parsedData: any): parsedData is ImportObject {
	if (typeof parsedData !== "object" || parsedData === null) {
		vscode.window.showErrorMessage("Imported data is not in the correct format");
		LogChannel.log("Imported data is not in the correct format");
		return false;
	}
	return (
		(parsedData.user !== undefined && isTodoPartialInput(parsedData.user)) ||
		(parsedData.workspace !== undefined && isTodoPartialInput(parsedData.workspace)) ||
		(parsedData.files !== undefined && isTodoFilesDataPartialInput(parsedData.files))
	);
}

function filterValidTodos(todos: TodoPartialInput[]): TodoPartialInput[] {
	return todos.filter((todo) => todo?.text?.trim());
}

function initMissingTodoProperties(validImportData: TodoPartialInput[]): Todo[] {
    return validImportData.map((todo) => ({
        ...todo,
        id: todo.id || generateUniqueId(validImportData),
        text: todo.text.trim(),
        completed: todo.completed ?? false,
        isMarkdown: todo.isMarkdown ?? false,
        isNote: todo.isNote ?? false,
        collapsed: todo.collapsed ?? false,
        creationDate: todo.creationDate ?? new Date().toISOString(),
        completionDate: todo.completed ? (todo.completionDate ?? new Date().toISOString()) : undefined,
    }));
}

function mergeTodoArrays(
	previousTodos: Todo[],
	importedTodos: TodoPartialInput[]
): TodoPartialInput[] {
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
			const existingTodo = lookupMap.get(todo.id)!;
			// If the ID exists in the lookup map, merge properties
			lookupMap.set(todo.id, { ...existingTodo, ...todo });
		} else {
			// If the ID does not exist, add the new todo object
			lookupMap.set(todo.id, { ...(todo as Todo) });
		}
	});
	return Array.from(lookupMap.values());
}

function mergeTodoFilesData(
	previousData: TodoFilesData,
	validImportData: TodoFilesDataPartialInput
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
			lookupMap.set(filePath, [...initMissingTodoProperties(mergedTodos)]);
		} else {
			// If a record for the file path does not exists, add it
			lookupMap.set(filePath, [...initMissingTodoProperties(validImportData[filePath])]);
		}
	}
	return Object.fromEntries(lookupMap);
}

function processAndMergeTodos(previousData: Todo[], rawImportData: TodoPartialInput[]): Todo[] {
	const validImportData: TodoPartialInput[] = filterValidTodos(rawImportData);
	const mergedTodos: TodoPartialInput[] = mergeTodoArrays(previousData, validImportData);
	return initMissingTodoProperties(mergedTodos) as Todo[];
}

function processAndMergeFilesData(
	previousData: TodoFilesData,
	rawImportData: TodoFilesDataPartialInput
): TodoFilesData {
	const validImportData = filterValidFilesData(rawImportData);
	return mergeTodoFilesData(previousData, validImportData);
}

function filterValidFilesData(rawImportData: TodoFilesDataPartialInput): TodoFilesDataPartialInput {
	const filteredData: TodoFilesDataPartialInput = {};

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

/**
 * Parses a Markdown string and returns an object containing todos based on the given scope.
 *
 * @param data - The Markdown string to parse.
 * @param scope - The scope of the todos to return.
 * @param state - The current state of the store.
 * @return An object containing todos based on the given scope.
 */
function parseMarkdown(data: string, scope: MarkdownImportScopes, state: StoreState): ImportObject {
	const lines = data.split("\n");
	const records = [];
	let currentRecord = null;
	const filePath = state.currentFile.filePath;
	const isTodo = (line: string) => /^\s*[-+*] \[[ xX]\] |\s*\d+. \[[ xX]\] /gm.test(line);
	const isCompleted = (line: string) => /^\s*[-+*] \[[xX]\] |\s*\d+. \[[xX]\] /gm.test(line);
	const getText = (line: string) => line.replace(/^\s*[-+*] \[[ xX]\] |\s*\d+. \[[ xX]\] /gm, "");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.trim() === "") {
			if (currentRecord !== null) {
				records.push(currentRecord);
				currentRecord = null;
			}
			continue;
		}

		if (isTodo(line)) {
			if (currentRecord !== null) {
				records.push(currentRecord);
			}
			currentRecord = {
				text: getText(line),
				isNote: false,
				completed: isCompleted(line),
				isMarkdown: true,
			};
		} else {
			if (currentRecord === null) {
				currentRecord = { text: line, isNote: true, completed: false, isMarkdown: true };
			} else {
				currentRecord.text += "\n" + line;
			}
		}
	}

	if (currentRecord !== null) {
		records.push(currentRecord);
	}

	return buildImportObject(records as TodoPartialInput[], scope, filePath);
}

function buildImportObject(
	records: TodoPartialInput[],
	scope: MarkdownImportScopes,
	filePath: string
): ImportObject {
	if (scope === MarkdownImportScopes.user) {
		return {
			user: records,
		};
	}
	if (scope === MarkdownImportScopes.workspace) {
		return {
			workspace: records,
		};
	}
	if (scope === MarkdownImportScopes.currentFile) {
		return {
			files: {
				[filePath]: records,
			},
		};
	}
	return {};
}

async function getImportScope(state: StoreState) {
	const currentFileName = state.currentFile.filePath
		? path.basename(state.currentFile.filePath)
		: "No File Selected";
	const quickPickOptions = [
		MarkdownImportScopes.user,
		MarkdownImportScopes.workspace,
		`${MarkdownImportScopes.currentFile} - ${currentFileName}`,
	];

	const scope = (await vscode.window.showQuickPick(quickPickOptions, {
		placeHolder: "Import to",
		canPickMany: false,
	})) as MarkdownImportScopes | undefined;

	if (scope?.startsWith(MarkdownImportScopes.currentFile)) {
		return currentFileName === "No File Selected" ? undefined : MarkdownImportScopes.currentFile;
	}
	return scope;
}

let tests = {
	filterValidFilesData,
	isTodoFilesDataPartialInput,
	isTodoPartialInput,
	isImportObject,
};
if (process.env.NODE_ENV !== "test") {
	// @ts-ignore
	tests = {};
}

export { importCommand, tests };
