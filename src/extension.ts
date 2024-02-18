import { commands, ExtensionContext } from "vscode";
import { HelloWorldPanel } from "./panels/HelloWorldPanel";
import { createStatusBarItem, updateStatusBarItem } from "./statusBarItem";
import createStore, { actionTrackerActions, userActions, workspaceActions } from "./todo/store";
import { StoreState, TodoScope, TodoSlice } from "./todo/todoTypes";
import { persist } from "./todo/todoUtils";
export function activate(context: ExtensionContext) {
	const store = createStore();

	const openTodoCommand = commands.registerCommand("vscode-tasks.openTodo", () => {
		HelloWorldPanel.render(context, store);
	});

	// Add command to the extension context
	context.subscriptions.push(openTodoCommand);

	createStatusBarItem(context);

	store.subscribe(() => {
		const state = store.getState() as StoreState;
		if (!Object.values(TodoScope).includes(state.actionTracker.lastSliceName as TodoScope)) return;
		const sliceState = state[state.actionTracker.lastSliceName] as TodoSlice;
		HelloWorldPanel.currentPanel?.updateWebview(sliceState);
		updateStatusBarItem({
			user: state.user.numberOfTodos,
			workspace: state.workspace.numberOfTodos,
		});
		persist(sliceState, context);
		store.dispatch(actionTrackerActions.resetLastSliceName());
	});

	// Load data in the store
	store.dispatch(
		workspaceActions.loadData({
			data: context.workspaceState.get("TodoData") ?? [],
		})
	);
	store.dispatch(
		userActions.loadData({
			data: context.globalState.get("TodoData") ?? [],
		})
	);
}
