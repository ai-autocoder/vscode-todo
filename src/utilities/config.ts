import * as vscode from "vscode";
import { contributes } from "../../package.json";
import LogChannel from "../utilities/LogChannel";

export type SyncUserMode = "profile-local" | "profile-sync";

export type Config = {
	taskSortingOptions: "sortType1" | "sortType2" | "disabled";
	createMarkdownByDefault: boolean;
	createPosition: "top" | "bottom";
	enableLineNumbers: boolean;
	enableMarkdownDiagrams: boolean;
	enableMarkdownKatex: boolean;
	enableWideView: boolean;
	sync: {
		user: SyncUserMode;
	};
	autoDeleteCompletedAfterDays: number;
	collapsedPreviewLines: number;
	// Webview typography
	webviewFontFamily?: string;
	webviewFontSize?: number;
};

type ConfigSectionValueMap = {
	taskSortingOptions: Config["taskSortingOptions"];
	createMarkdownByDefault: Config["createMarkdownByDefault"];
	createPosition: Config["createPosition"];
	enableLineNumbers: Config["enableLineNumbers"];
	enableMarkdownDiagrams: Config["enableMarkdownDiagrams"];
	enableMarkdownKatex: Config["enableMarkdownKatex"];
	enableWideView: Config["enableWideView"];
	"sync.user": SyncUserMode;
	autoDeleteCompletedAfterDays: Config["autoDeleteCompletedAfterDays"];
	collapsedPreviewLines: Config["collapsedPreviewLines"];
	webviewFontFamily: Config["webviewFontFamily"];
	webviewFontSize: Config["webviewFontSize"];
};

type ConfigSection = keyof ConfigSectionValueMap;

export function getConfig(): Config {
	const config = vscode.workspace.getConfiguration("vscodeTodo");

	let taskSortingOptions: any = config.get("taskSortingOptions", "sortType1");
	const createMarkdownByDefault: boolean = config.get("createMarkdownByDefault", true);
	let createPosition: any = config.get("createPosition", "bottom");
	const enableLineNumbers: boolean = config.get("enableLineNumbers", false);
	const enableMarkdownDiagrams: boolean = config.get("enableMarkdownDiagrams", true);
	const enableMarkdownKatex: boolean = config.get("enableMarkdownKatex", true);
	const enableWideView: boolean = config.get("enableWideView", false);
	const autoDeleteCompletedAfterDays: number = config.get("autoDeleteCompletedAfterDays", 0);
	const collapsedPreviewLinesRaw: number = config.get("collapsedPreviewLines", 1);
	const webviewFontFamily: string = config.get("webviewFontFamily", "");
	const webviewFontSize: number = config.get("webviewFontSize", 0);

	const syncUserModeEnum = (
		contributes.configuration.properties["vscodeTodo.sync.user"]["enum"]
	) as SyncUserMode[];
	const syncUserModeDefault = (
		contributes.configuration.properties["vscodeTodo.sync.user"]["default"]
	) as SyncUserMode;
	let syncUserMode: SyncUserMode = config.get<SyncUserMode>(
		"sync.user",
		syncUserModeDefault
	);

	const taskSortingOptionsEnum =
		contributes.configuration.properties["vscodeTodo.taskSortingOptions"]["enum"];
	const createPositionEnum =
		contributes.configuration.properties["vscodeTodo.createPosition"]["enum"];

	// Validate the taskSortingOptions value
	if (!taskSortingOptionsEnum.includes(taskSortingOptions)) {
		taskSortingOptions =
			contributes.configuration.properties["vscodeTodo.taskSortingOptions"]["default"];
	}

	// Validate the createPosition value
	if (!createPositionEnum.includes(createPosition)) {
		createPosition =
			contributes.configuration.properties["vscodeTodo.createPosition"]["default"];
	}

	if (!syncUserModeEnum.includes(syncUserMode)) {
		syncUserMode = syncUserModeDefault;
	}

	// Sanitize numeric inputs
	const collapsedPreviewLines = Number.isFinite(collapsedPreviewLinesRaw)
		? Math.max(1, Math.floor(collapsedPreviewLinesRaw))
		: 1;

	return {
		taskSortingOptions,
		createMarkdownByDefault,
		createPosition,
		enableLineNumbers,
		enableMarkdownDiagrams,
		enableMarkdownKatex,
		enableWideView,
		sync: {
			user: syncUserMode,
		},
		autoDeleteCompletedAfterDays,
		collapsedPreviewLines,
		webviewFontFamily,
		webviewFontSize,
	};
}

export function setConfig<K extends ConfigSection>(section: K, value: ConfigSectionValueMap[K]): void {
	const config = vscode.workspace.getConfiguration("vscodeTodo");
	config.update(section, value, vscode.ConfigurationTarget.Workspace).then(
		() => {
			LogChannel.log(`Configuration '${section}' updated successfully.`);
		},
		(err) => {
			LogChannel.log(`Failed to update configuration '${section}': ${err}`);
		}
	);
}
