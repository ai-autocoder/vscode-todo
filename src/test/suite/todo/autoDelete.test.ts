import * as assert from "assert";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { after, before, beforeEach } from "mocha";
import createStore, {
	userActions,
	workspaceActions,
	currentFileActions,
} from "../../../todo/store";
import { deleteCompletedTodos } from "../../../todo/todoUtils";
import { Todo } from "../../../todo/todoTypes";

suite("Auto-delete completed todos", () => {
	let store: EnhancedStore;
	let context: vscode.ExtensionContext;

	before(async () => {
		context = {
			globalState: {
				get: () => [],
				update: () => Promise.resolve(),
			},
			workspaceState: {
				get: () => [],
				update: () => Promise.resolve(),
			},
		} as unknown as vscode.ExtensionContext;
	});

	beforeEach(() => {
		store = createStore();
	});

	after(async () => {
		await vscode.workspace
			.getConfiguration("vscodeTodo")
			.update("autoDeleteCompletedAfterDays", undefined, vscode.ConfigurationTarget.Global);
	});

	test("should delete completed todos older than the specified number of days", async () => {
		await vscode.workspace
			.getConfiguration("vscodeTodo")
			.update("autoDeleteCompletedAfterDays", 1, vscode.ConfigurationTarget.Global);

		const oldTodo: Todo = {
			id: 1,
			text: "old todo",
			completed: true,
			completionDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
			creationDate: new Date().toISOString(),
			isMarkdown: false,
			isNote: false,
		};

		store.dispatch(userActions.loadData({ data: [oldTodo] }));
		store.dispatch(workspaceActions.loadData({ data: [oldTodo] }));
		store.dispatch(currentFileActions.loadData({ filePath: "test.ts", data: [oldTodo] }));

		deleteCompletedTodos(store);

		assert.strictEqual(store.getState().user.todos.length, 0);
		assert.strictEqual(store.getState().workspace.todos.length, 0);
		assert.strictEqual(store.getState().currentFile.todos.length, 0);
	});

	test("should not delete completed todos newer than the specified number of days", async () => {
		await vscode.workspace
			.getConfiguration("vscodeTodo")
			.update("autoDeleteCompletedAfterDays", 1, vscode.ConfigurationTarget.Global);

		const newTodo: Todo = {
			id: 1,
			text: "new todo",
			completed: true,
			completionDate: new Date().toISOString(),
			creationDate: new Date().toISOString(),
			isMarkdown: false,
			isNote: false,
		};

		store.dispatch(userActions.loadData({ data: [newTodo] }));
		store.dispatch(workspaceActions.loadData({ data: [newTodo] }));
		store.dispatch(currentFileActions.loadData({ filePath: "test.ts", data: [newTodo] }));

		deleteCompletedTodos(store);

		assert.strictEqual(store.getState().user.todos.length, 1);
		assert.strictEqual(store.getState().workspace.todos.length, 1);
		assert.strictEqual(store.getState().currentFile.todos.length, 1);
	});

	test("should not delete todos if the feature is disabled", async () => {
		await vscode.workspace
			.getConfiguration("vscodeTodo")
			.update("autoDeleteCompletedAfterDays", 0, vscode.ConfigurationTarget.Global);

		const oldTodo: Todo = {
			id: 1,
			text: "old todo",
			completed: true,
			completionDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
			creationDate: new Date().toISOString(),
			isMarkdown: false,
			isNote: false,
		};

		store.dispatch(userActions.loadData({ data: [oldTodo] }));

		deleteCompletedTodos(store);

		assert.strictEqual(store.getState().user.todos.length, 1);
	});

	test("should not delete notes", async () => {
		await vscode.workspace
			.getConfiguration("vscodeTodo")
			.update("autoDeleteCompletedAfterDays", 1, vscode.ConfigurationTarget.Global);

		const oldNote: Todo = {
			id: 1,
			text: "old note",
			completed: false,
			completionDate: undefined,
			creationDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
			isMarkdown: false,
			isNote: true,
		};

		store.dispatch(userActions.loadData({ data: [oldNote] }));

		deleteCompletedTodos(store);

		assert.strictEqual(store.getState().user.todos.length, 1);
	});
});
