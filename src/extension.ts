import { commands, ExtensionContext } from "vscode";
import { HelloWorldPanel } from "./panels/HelloWorldPanel";
import { createStatusBarItem, updateStatusBarItem } from "./statusBarItem";
import createStore, { storeActions, persist, FullData } from "./todo/store";
export function activate(context: ExtensionContext) {
	const store = createStore();

	const openTodoCommand = commands.registerCommand("vscode-tasks.openTodo", () => {
		HelloWorldPanel.render(context, store);
	});

	// Add command to the extension context
	context.subscriptions.push(openTodoCommand);

	createStatusBarItem(context);

	store.subscribe(() => {
		const state: FullData = store.getState();
		persist(state, context);
		HelloWorldPanel.currentPanel?.updateWebview();
		updateStatusBarItem(state.numberOfTodos);
	});

	// Load data in the store
	store.dispatch(
		storeActions.loadData({
			data: {
				workspaceTodos: context.workspaceState.get("TodoData") ?? [],
				userTodos: context.globalState.get("TodoData") ?? [],
			} as FullData,
		})
	);
}
