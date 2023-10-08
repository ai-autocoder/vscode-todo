import { commands, ExtensionContext } from "vscode";
import { HelloWorldPanel } from "./panels/HelloWorldPanel";
import { createStatusBarItem } from "./statusBarItem";
import createStore, { storeActions, persist, Todo, FullData } from "./todo/store";

export function activate(context: ExtensionContext) {
	const store = createStore();
	store.dispatch(
		storeActions.loadData({
			data: {
				workspaceTodos: context.workspaceState.get("TodoData") ?? [],
				userTodos: context.globalState.get("TodoData") ?? [],
			} as FullData,
		})
	);

	console.log("Initial data:");
	console.log({
		workspaceTodos: context.workspaceState.get("TodoData") ?? [],
		userTodos: context.globalState.get("TodoData") ?? [],
	} as FullData);
	console.log("Store data:");
	console.log(store.getState());

	// Create the show hello world command
	const openTodoCommand = commands.registerCommand("vscode-tasks.openTodo", () => {
		HelloWorldPanel.render(context, store);
	});

	// Add command to the extension context
	context.subscriptions.push(openTodoCommand);

	const statusBarItem = createStatusBarItem(context);

	store.subscribe(() => {
		console.log("State changed: ");
		console.log(store.getState());
		HelloWorldPanel.currentPanel?.update(store.getState());
		console.log("UI Updated!");
		persist(store, context);
		// TODO: update statusBarItem
	});
}
