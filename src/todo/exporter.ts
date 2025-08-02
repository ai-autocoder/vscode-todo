import path = require("node:path");
import fs = require("fs");
import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import LogChannel from "../utilities/LogChannel";
import {
	ExportFormats,
	ExportObject,
	ExportScopes,
	StoreState,
	Todo,
	TodoFilesData,
} from "./todoTypes";
import { getWorkspacePath } from "./todoUtils";

export async function exportCommand(
	context: ExtensionContext,
	format: ExportFormats,
	store: EnhancedStore<StoreState>
) {
	const scopes = await getExportScopes(store);

	if (!scopes || scopes.length === 0) {
		vscode.window.showInformationMessage("Export cancelled.");
		return;
	}

	exportData({ scopes, format, context });
}

export function exportData({
	scopes,
	format = ExportFormats.JSON,
	context,
}: {
	scopes: ScopesSelection;
	format: ExportFormats;
	context: ExtensionContext;
}) {
	const rootDir = getWorkspacePath();
	const isWorkspaceOpen = rootDir !== null;
	if (!isWorkspaceOpen) {
		vscode.window.showErrorMessage("No workspace open, export aborted");
		return;
	}
	const data = getDataToExport(scopes, context);
	if (!data) {
		vscode.window.showErrorMessage("No data to export, export aborted");
		return;
	}
	const baseFileName = "todo_export";
	const dateTimeStamp = new Date().toISOString().replace(/[:]/g, "-").split(".")[0];
	const filePath = path.join(rootDir, `${baseFileName}_${dateTimeStamp}.${format}`);
	const formattedData = formatData(data, format);
	if (!formattedData) {
		vscode.window.showErrorMessage("Error formatting data, export aborted");
		return;
	}
	writeDataToFile(filePath, formattedData);
}

function formatData(data: ExportObject, format: ExportFormats) {
	switch (format) {
		case ExportFormats.JSON:
			return JSON.stringify(data, null, 2);
		case ExportFormats.MARKDOWN:
			return formatMarkdown(data);
		default:
			return undefined;
	}
}

function getDataToExport(scopeSelection: ScopesSelection, context: ExtensionContext): ExportObject {
	const data: ExportObject = {};

	if (scopeSelection.some((scope) => scope.label === ExportScopes.user)) {
		data.user = context.globalState.get("TodoData") || [];
	}

	if (scopeSelection.some((scope) => scope.label === ExportScopes.workspace)) {
		data.workspace = context.workspaceState.get("TodoData") || [];
	}

	if (scopeSelection.some((scope) => scope.label === ExportScopes.files)) {
		data.files = context.workspaceState.get("TodoFilesData") || {};
	} else if (scopeSelection.some((scope) => scope.label === ExportScopes.currentFile)) {
		const currentFilePath = scopeSelection.find((scope) => scope.label === ExportScopes.currentFile)
			?.description as string;
		const filesData = context.workspaceState.get("TodoFilesData") as TodoFilesData;
		if (
			currentFilePath &&
			Array.isArray(filesData[currentFilePath]) &&
			filesData[currentFilePath].length > 0
		) {
		}
		data.files = { [currentFilePath]: filesData[currentFilePath] };
	}

	return data;
}

function writeDataToFile(filePath: string, formattedData: string) {
	try {
		fs.writeFileSync(filePath, formattedData);
	} catch (err) {
		if (err instanceof Error) {
			vscode.window.showErrorMessage(`Error exporting data: ${err.message}`);
			LogChannel.log(`Error exporting data: ${err.message}`);
		} else {
			// If it's not an Error instance, handle or log it differently
			vscode.window.showErrorMessage("Error exporting data: An unexpected error occurred.");
			LogChannel.log("Error exporting data: An unexpected error occurred.");
		}
		return;
	}

	vscode.window.showInformationMessage(`Data exported successfully to ${filePath}`);
	LogChannel.log(`Data exported successfully to ${filePath}`);
}

function formatMarkdown(data: ExportObject) {
	const formatItems = (items?: Array<Todo>) => {
		if (!items || items.length === 0) {return "";}

		let result = "";
		let prevIsNote = false;

		items.forEach((item, index) => {
			const currentIsNote = item.isNote;

			// Determine the separator
			if (index > 0) {
				if (currentIsNote || prevIsNote) {
					result += "\n\n";
				} else {
					// Both items are checklist items, add a single newline
					result += "\n";
				}
			}

			// Format the current item
			if (currentIsNote) {
				result += item.text;
			} else {
				result += `- [${item.completed ? "x" : " "}] ${item.text}`;
			}

			prevIsNote = currentIsNote;
		});

		return result;
	};

	let text = "";
	if ("user" in data) {
		text += formatItems(data.user);
	}
	if ("workspace" in data) {
		text += (text ? "\n\n" : "") + formatItems(data.workspace);
	}
	if (data.files !== undefined) {
		const files = data.files as Record<string, Array<Todo>>;
		Object.keys(files).forEach((key) => {
			if (files[key] !== undefined) {
				text += (text ? "\n\n" : "") + formatItems(files[key]);
			}
		});
	}

	if (text.trim()) {
		text += "\n";
	}

	return text;
}
async function getExportScopes(
	store: EnhancedStore<StoreState>
): Promise<ScopesSelection | undefined> {
	const state = store.getState();
	const filePath = state.currentFile.filePath;
	const currentFileName = filePath ? path.basename(filePath) : "No File Selected";
	const quickPickOptions = Object.values(ExportScopes).map((scope) =>
		scope === ExportScopes.currentFile
			? { label: scope, description: currentFileName || "No File Selected" }
			: { label: scope }
	);

	let selection = await vscode.window.showQuickPick(quickPickOptions, {
		placeHolder: "Choose which data to export",
		canPickMany: true,
	});

	const scopes = selection
		?.map((scope) => {
			if (scope.label === ExportScopes.currentFile) {
				return scope.description !== "No File Selected" ? { ...scope, description: filePath } : null;
			}
			return scope;
		})
		.filter((scope) => scope !== null);

	return scopes;
}

type ScopesSelection = (
	| {
			label: ExportScopes;
			description: string;
	  }
	| {
			label: ExportScopes;
			description?: undefined;
	  }
)[];
