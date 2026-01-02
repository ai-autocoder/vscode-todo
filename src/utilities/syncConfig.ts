import * as vscode from "vscode";

export function getGistId(): string {
	const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
	const inspected = config.inspect<string>("github.gistId");
	const candidates = [
		inspected?.workspaceFolderValue,
		inspected?.workspaceValue,
		inspected?.globalValue,
		inspected?.defaultValue,
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const trimmed = candidate.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	}

	return "";
}
