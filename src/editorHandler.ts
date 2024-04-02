import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { fileDataInfoActions } from "./todo/store";

/**
 * Handles the tab change event.
 *
 * When a new text editor is activated, it dispatches an action to the Redux store
 * with the path of the current active file, if any.
 *
 * @param store - The Redux store.
 * @param context - The extension context.
 * @return {void}
 */
export const tabChangeHandler = (store: EnhancedStore, context: vscode.ExtensionContext) => {
	const currentFile = vscode.window.activeTextEditor?.document.fileName || "";
	store.dispatch(fileDataInfoActions.setCurrentFile(currentFile));
};

export const onDidChangeActiveTextEditorDisposable = (
	store: EnhancedStore,
	context: vscode.ExtensionContext
) =>
	vscode.window.onDidChangeActiveTextEditor(() => {
		tabChangeHandler(store, context);
	});
