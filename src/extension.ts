import { commands, ExtensionContext } from "vscode";
import { onDidChangeActiveTextEditorDisposable, tabChangeHandler } from "./editorHandler";
import { HelloWorldPanel } from "./panels/HelloWorldPanel";
import { initStatusBarItem, updateStatusBarItem } from "./statusBarItem";
import createStore, {
	actionTrackerActions,
	fileDataInfoActions,
	userActions,
	workspaceActions,
} from "./todo/store";
import { CurrentFileSlice, Slices, StoreState, TodoSlice } from "./todo/todoTypes";
import { getWorkspaceFilesWithRecords, persist } from "./todo/todoUtils";
export function activate(context: ExtensionContext) {
	const store = createStore();

	const openTodoCommand = commands.registerCommand("vscode-todo.openTodo", () => {
		HelloWorldPanel.render(context, store);
	});

	const statusBarItem = initStatusBarItem(context);

	context.subscriptions.push(openTodoCommand, statusBarItem);

	store.subscribe(() => {
		const state = store.getState() as StoreState;

		switch (state.actionTracker.lastSliceName) {
			case Slices.unset:
			case Slices.actionTracker:
				return;
			case Slices.user:
				handleTodoChange(state, state.user, context);
				break;
			case Slices.workspace:
				handleTodoChange(state, state.workspace, context);
				break;
			case Slices.currentFile:
				handleTodoChange(state, state.currentFile, context);
				break;
			case Slices.fileDataInfo:
				HelloWorldPanel.currentPanel?.updateWebview(state.fileDataInfo, Slices.fileDataInfo);
				break;
		}
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

	store.dispatch(
		fileDataInfoActions.setWorkspaceFilesWithRecords(
			getWorkspaceFilesWithRecords(context.workspaceState.get("TodoFilesData") ?? {})
		)
	);

	tabChangeHandler(store, context);

	context.subscriptions.push(onDidChangeActiveTextEditorDisposable(store, context));
}

function handleTodoChange(
	state: StoreState,
	sliceState: TodoSlice | CurrentFileSlice,
	context: ExtensionContext
) {
	HelloWorldPanel.currentPanel?.updateWebview(sliceState);
	updateStatusBarItem(state);
	persist(sliceState as TodoSlice | CurrentFileSlice, context);
}
