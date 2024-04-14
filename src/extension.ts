import { EnhancedStore } from "@reduxjs/toolkit";
import { commands, ExtensionContext } from "vscode";
import { onDidChangeActiveTextEditorDisposable, tabChangeHandler } from "./editorHandler";
import { HelloWorldPanel } from "./panels/HelloWorldPanel";
import { initStatusBarItem, updateStatusBarItem } from "./statusBarItem";
import createStore, {
	actionTrackerActions,
	currentFileActions,
	fileDataInfoActions,
	userActions,
	workspaceActions,
} from "./todo/store";
import {
	CurrentFileSlice,
	Slices,
	StoreState,
	TodoFilesData,
	TodoScope,
	TodoSlice,
} from "./todo/todoTypes";
import { getWorkspaceFilesWithRecords, persist } from "./todo/todoUtils";
export function activate(context: ExtensionContext) {
	const store = createStore();

	const openTodoCommand = commands.registerCommand("vsc-todo.openTodo", () => {
		HelloWorldPanel.render(context, store);
	});

	const statusBarItem = initStatusBarItem(context);

	store.subscribe(() => {
		const state = store.getState() as StoreState;

		switch (state.actionTracker.lastSliceName) {
			case Slices.unset:
			case Slices.actionTracker:
				return;
			case Slices.user:
			case Slices.workspace:
			case Slices.currentFile:
				handleTodoChange(state, state[state.actionTracker.lastSliceName], store, context);
				break;
			case Slices.fileDataInfo:
				handlefileDataInfoChange(state, store, context);
				break;
		}
	});

	// Load workspace slice
	store.dispatch(
		workspaceActions.loadData({
			data: context.workspaceState.get("TodoData") ?? [],
		})
	);

	// Load user slice
	store.dispatch(
		userActions.loadData({
			data: context.globalState.get("TodoData") ?? [],
		})
	);

	// Load list of files with records
	store.dispatch(
		fileDataInfoActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(context.workspaceState.get("TodoFilesData") ?? {})
		)
	);

	// Load current active editor tab
	tabChangeHandler(store, context);

	context.subscriptions.push(
		openTodoCommand,
		statusBarItem,
		onDidChangeActiveTextEditorDisposable(store, context)
	);
}

function handleTodoChange(
	state: StoreState,
	sliceState: TodoSlice | CurrentFileSlice,
	store: EnhancedStore,
	context: ExtensionContext
) {
	store.dispatch(actionTrackerActions.resetLastSliceName());
	HelloWorldPanel.currentPanel?.updateWebview(sliceState);
	updateStatusBarItem(state);
	persist(sliceState as TodoSlice | CurrentFileSlice, context);
	if (sliceState.scope === TodoScope.currentFile) {
		// Update fileDataInfoSlice
		store.dispatch(
			fileDataInfoActions.setWorkspaceFilesWithRecords(
				getWorkspaceFilesWithRecords(context.workspaceState.get("TodoFilesData") ?? {})
			)
		);
	}
}

function handlefileDataInfoChange(
	state: StoreState,
	store: EnhancedStore,
	context: ExtensionContext
) {
	store.dispatch(actionTrackerActions.resetLastSliceName());
	if (
		state.fileDataInfo.editorFocusedFilePath !== "" &&
		state.fileDataInfo.lastActionType === "fileDataInfo/setCurrentFile" &&
		!state.currentFile.isPinned
	) {
		const data = context.workspaceState.get("TodoFilesData") as TodoFilesData | undefined;
		const todos = data?.[state.fileDataInfo.editorFocusedFilePath] || [];
		store.dispatch(
			currentFileActions.loadData({
				filePath: state.fileDataInfo.editorFocusedFilePath,
				data: todos,
			})
		);
	} else if (state.fileDataInfo.lastActionType === "fileDataInfo/setWorkspaceFilesWithRecords") {
		HelloWorldPanel.currentPanel?.updateWebview(state.fileDataInfo, Slices.fileDataInfo);
	}
}
