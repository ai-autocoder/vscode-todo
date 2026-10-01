/**
 * The VS Code half of import: the file and scope pickers, reading the file, and writing the
 * result into the store and the workspace memento. Parsing, shape validation and the id-keyed
 * merge are `packages/core/src/importExport.ts`, the same code the PWA runs, so an import
 * produces the same result on both surfaces.
 */
import path = require("node:path");
import fs = require("fs/promises");
import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import LogChannel from "../utilities/LogChannel";
import {
	filterValidFilesData,
	initMissingTodoProperties,
	isImportObject as isImportObjectShape,
	isTodoFilesDataPartialInput,
	isTodoFilesDataPathsInput,
	isTodoPartialInput,
	mergeImportedFilesDataPaths,
	parseMarkdownImport,
	processAndMergeFilesData,
	processAndMergeTodos,
	withImportedIds,
} from "../core";
import { userActions, workspaceActions } from "./store";
import {
	ImportFormats,
	ImportObject,
	MarkdownImportScopes,
	StoreState,
	TodoFilesChange,
	TodoFilesData,
	TodoFilesDataPartialInput,
	TodoFilesDataPaths,
	TodoFilesStorage,
} from "./todoTypes";
import {
	ensureFilesDataPaths,
	getWorkspacePath,
	isEqual,
	showChangedFiles,
	sortByFileName,
} from "./todoUtils";

async function importCommand(
	context: ExtensionContext,
	format: ImportFormats,
	store: EnhancedStore<StoreState>,
	storage: TodoFilesStorage
) {
	const rootDir = getWorkspacePath();
	if (!rootDir) {
		vscode.window.showErrorMessage("No workspace open, import aborted");
		return;
	}

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
	const hasFilesData = isTodoFilesDataPartialInput(rawImportData.files);
	const hasFilesDataPaths = isTodoFilesDataPathsInput(rawImportData.filesDataPaths);

	if (hasFilesData || hasFilesDataPaths) {
		const previousData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) || {};
		const previousPaths =
			(context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) || {};
		// The change is applied to the memento and to the storage (see `updateFiles`), so the
		// ids and timestamps it mints are fixed here, once.
		const importedFiles = hasFilesData
			? withImportedIds(previousData, rawImportData.files as TodoFilesDataPartialInput)
			: undefined;
		const importedAt = new Date().toISOString();
		const importFiles: TodoFilesChange = (files) => {
			const filesData = sortByFileName(
				importedFiles
					? processAndMergeFilesData(files.filesData, importedFiles, () => importedAt)
					: files.filesData
			);
			let filesDataPaths = ensureFilesDataPaths(filesData, files.filesDataPaths, getWorkspacePath());
			if (hasFilesDataPaths) {
				filesDataPaths = ensureFilesDataPaths(
					filesData,
					mergeImportedFilesDataPaths(
						filesDataPaths,
						rawImportData.filesDataPaths as TodoFilesDataPaths
					),
					getWorkspacePath()
				);
			}
			return { filesData, filesDataPaths };
		};
		const imported = importFiles({ filesData: previousData, filesDataPaths: previousPaths });

		const dataChanged = !isEqual(previousData, imported.filesData);
		const pathsChanged = !isEqual(previousPaths, imported.filesDataPaths);

		if (dataChanged || pathsChanged) {
			// Through the storage, not straight into the memento: the next per-file persist
			// rebuilds the lists from the storage, and dropped every imported file but the one
			// the slice was reloaded with.
			void storage.updateFiles(importFiles);
			showChangedFiles(context, store);
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
			return parseMarkdownImport(data, scope as MarkdownImportScopes, state.currentFile.filePath);
		default:
			return undefined;
	}
}

/** Core's shape check, plus the error the extension has always shown for a non-object. */
function isImportObject(parsedData: unknown): parsedData is ImportObject {
	if (typeof parsedData !== "object" || parsedData === null) {
		vscode.window.showErrorMessage("Imported data is not in the correct format");
		LogChannel.log("Imported data is not in the correct format");
		return false;
	}
	return isImportObjectShape(parsedData);
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
	initMissingTodoProperties,
};
if (process.env.NODE_ENV !== "test") {
	// @ts-ignore
	tests = {};
}

export { importCommand, tests };
