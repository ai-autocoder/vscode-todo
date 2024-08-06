import * as vscode from "vscode";
import { contributes } from '../../package.json';

export type Config = {
	taskSortingOptions: "sortType1" | "sortType2" | "disabled";
	createMarkdownByDefault: boolean;
	createPosition: "top" | "bottom";
};

export function getConfig(): Config {
	const config = vscode.workspace.getConfiguration("vscodeTodo");

	let taskSortingOptions: any = config.get("taskSortingOptions", "sortType1");
	let createMarkdownByDefault: boolean = config.get("createMarkdownByDefault", true);
	let createPosition: any = config.get("createPosition", "bottom");

	const taskSortingOptionsEnum = contributes.configuration.properties["vscodeTodo.taskSortingOptions"]["enum"];
	const createPositionEnum = contributes.configuration.properties["vscodeTodo.taskSortingOptions"]["enum"];

	// Validate the taskSortingOptions value
	if (!taskSortingOptionsEnum.includes(taskSortingOptions)) {
		taskSortingOptions = contributes.configuration.properties["vscodeTodo.taskSortingOptions"]["default"];
	}

	// Validate the createPosition value
	if (!createPositionEnum.includes(createPosition)) {
		createPosition = contributes.configuration.properties["vscodeTodo.createPosition"]["default"];
	}

	return {
		taskSortingOptions,
		createMarkdownByDefault,
		createPosition
	};
}
