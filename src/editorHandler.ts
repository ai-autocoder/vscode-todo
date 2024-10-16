import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import { editorFocusAndRecordsActions } from "./todo/store";

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
	store.dispatch(editorFocusAndRecordsActions.setCurrentFile(currentFile));
};
