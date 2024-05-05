import path = require("node:path");
import fs = require("fs");
import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import LogChannel from "../utilities/LogChannel";
import { ExportImportData, ExportImportScopes, TodoFilesData } from "./todoTypes";
import { getWorkspacePath } from "./todoUtils";

export enum ExportFormats {
	JSON = "json",
}

export function exportData(
	scopeSelection: ExportImportScopes[],
	format = ExportFormats.JSON,
	context: ExtensionContext
) {
	const rootDir = getWorkspacePath();
	const isWorkspaceOpen = rootDir !== null;
	if (!isWorkspaceOpen) {
		vscode.window.showErrorMessage("No workspace open, export aborted");
		return;
	}
	const data = getDataToExport(scopeSelection, context);
	const baseFileName = "todo_export";
	const dateTimeStamp = new Date().toISOString().replace(/[:]/g, "-").split(".")[0];
	const filePath = path.join(rootDir, `${baseFileName}_${dateTimeStamp}.${format}`);
	const formattedData = formatData(data, format);
	writeDataToFile(filePath, formattedData);
}

function formatData(data: ExportImportData, format: ExportFormats) {
	switch (format) {
		case ExportFormats.JSON:
			return JSON.stringify(data, null, 2);
	}
}

function getDataToExport(
	scopeSelection: ExportImportScopes[],
	context: ExtensionContext
): ExportImportData {
	const data: ExportImportData = {};

	if (scopeSelection.includes(ExportImportScopes.user)) {
		data.user = context.globalState.get("TodoData") || [];
	}

	if (scopeSelection.includes(ExportImportScopes.workspace)) {
		data.workspace = context.workspaceState.get("TodoData") || [];
	}

	if (scopeSelection.includes(ExportImportScopes.files)) {
		data.files = context.workspaceState.get("TodoFilesData") || {};
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
