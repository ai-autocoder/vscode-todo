import * as vscode from "vscode";

export type Config = {
	taskSortingOptions: "sortType1" | "sortType2" | "disabled";
};

export function getConfig(): Config {
	const config = vscode.workspace.getConfiguration("vscodeTodo");
	let taskSortingOptions: any = config.get("taskSortingOptions", "sortType1");

	// Validate the taskSortingOptions value
	if (!["sortType1", "sortType2", "disabled"].includes(taskSortingOptions)) {
		taskSortingOptions = "sortType1"; // Default value
	}

	return {
		taskSortingOptions,
	};
}
