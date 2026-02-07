import * as assert from "assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { after, before, beforeEach } from "mocha";
import createStore, { currentFileActions } from "../../../todo/store";
import TodoService from "../../../todo/TodoService";
import StorageSyncManager from "../../../storage/StorageSyncManager";
import {
	CurrentFileSlice,
	StoreState,
	Todo,
	TodoFilesData,
	TodoFilesDataPaths,
	TodoScope,
	TodoSlice,
} from "../../../todo/todoTypes";
import { getWorkspacePath, resolveFilesDataKey, ensureFilesDataPaths } from "../../../todo/todoUtils";

/**
 * Map-backed mock of the bits of ExtensionContext that TodoService /
 * StorageSyncManager read and write. Only globalState/workspaceState are used.
 */
function createMockContext(): {
	context: vscode.ExtensionContext;
	workspaceStore: Map<string, unknown>;
	globalStore: Map<string, unknown>;
} {
	const workspaceStore = new Map<string, unknown>();
	const globalStore = new Map<string, unknown>();
	const context = {
		globalState: {
			get: (key: string, defaultValue?: unknown) => globalStore.get(key) ?? defaultValue,
			update: async (key: string, value: unknown) => {
				globalStore.set(key, value);
			},
		},
		workspaceState: {
			get: (key: string, defaultValue?: unknown) => workspaceStore.get(key) ?? defaultValue,
			update: async (key: string, value: unknown) => {
				workspaceStore.set(key, value);
			},
		},
	} as unknown as vscode.ExtensionContext;
	return { context, workspaceStore, globalStore };
}

/**
 * Mock StorageSyncManager.persistSlice that mirrors the essential behavior of the
 * real implementation against the mock workspaceState, so file-scope reads/writes
 * round-trip through `TodoFilesData` exactly as TodoService.getFileTodos expects.
 */
function createMockStorage(context: vscode.ExtensionContext): StorageSyncManager {
	const readFiles = (): TodoFilesData =>
		(context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
	const readPaths = (): TodoFilesDataPaths =>
		(context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) ?? {};

	return {
		persistSlice: async (state: TodoSlice | CurrentFileSlice) => {
			if (state.scope !== TodoScope.currentFile) {
				// User/workspace persistence is irrelevant to these tests (the store is the
				// source of truth and is read directly); store the todos for completeness.
				await context.workspaceState.update(`TodoData_${state.scope}`, state.todos);
				return;
			}
			const fileState = state as CurrentFileSlice;
			const filesData: TodoFilesData = { ...readFiles() };
			const filesDataPaths = ensureFilesDataPaths(filesData, readPaths(), getWorkspacePath());
			const resolved = resolveFilesDataKey({
				filePath: fileState.filePath,
				filesData,
				filesDataPaths,
			});
			const primaryKey = resolved.key ?? fileState.filePath;
			if (fileState.todos.length === 0) {
				delete filesData[primaryKey];
				delete filesDataPaths[primaryKey];
			} else {
				filesData[primaryKey] = fileState.todos;
			}
			await context.workspaceState.update("TodoFilesData", filesData);
			await context.workspaceState.update("TodoFilesDataPaths", filesDataPaths);
		},
	} as unknown as StorageSyncManager;
}

function seedFileTodos(context: vscode.ExtensionContext, filePath: string, todos: Todo[]): void {
	const filesData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
	filesData[filePath] = todos;
	void context.workspaceState.update("TodoFilesData", filesData);
}

function readFileTodos(context: vscode.ExtensionContext, filePath: string): Todo[] {
	const filesData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
	return filesData[filePath] ?? [];
}

const makeTodo = (id: number, text: string, overrides: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: new Date().toISOString(),
	isMarkdown: false,
	isNote: false,
	...overrides,
});

suite("TodoService CRUD", () => {
	let store: EnhancedStore<StoreState>;
	let context: vscode.ExtensionContext;
	let service: TodoService;
	// File paths inside the (stubbed) workspace; used for the file-scope cases.
	const workspaceRoot = path.join(os.tmpdir(), "vsc-todo-service-test");
	const otherFilePath = path.join(workspaceRoot, "src", "service-other.ts");
	const activeFilePath = path.join(workspaceRoot, "src", "service-active.ts");

	// workspace/file scopes require an open folder; the test host has none, so stub it.
	let originalFolders: PropertyDescriptor | undefined;
	let originalGetWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder;
	const fakeFolder = {
		uri: vscode.Uri.file(workspaceRoot),
		name: "vsc-todo-service-test",
		index: 0,
	} as vscode.WorkspaceFolder;

	before(() => {
		originalFolders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			get: () => [fakeFolder],
		});
		originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
		(vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }).getWorkspaceFolder =
			(uri: vscode.Uri) =>
				uri.fsPath.startsWith(workspaceRoot) ? fakeFolder : undefined;
	});

	after(() => {
		if (originalFolders) {
			Object.defineProperty(vscode.workspace, "workspaceFolders", originalFolders);
		}
		(vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }).getWorkspaceFolder =
			originalGetWorkspaceFolder;
	});

	beforeEach(() => {
		store = createStore();
		const mock = createMockContext();
		context = mock.context;
		const storage = createMockStorage(context);
		service = new TodoService(context, store as EnhancedStore<StoreState>, storage);
		// Allow writes for the CRUD tests (read-only default would block them).
		service.updateAccess(false, ["user", "workspace", "file"]);
	});

	// --- Create -------------------------------------------------------------

	test("create: adds a todo to the user scope", async () => {
		const result = await service.addTodo(TodoScope.user, "user task");
		assert.ok(result);
		assert.strictEqual(result!.scope, TodoScope.user);
		assert.strictEqual(result!.todo.text, "user task");
		assert.strictEqual(store.getState().user.todos.length, 1);
	});

	test("create: adds a todo to the workspace scope", async () => {
		const result = await service.addTodo(TodoScope.workspace, "workspace task");
		assert.ok(result);
		assert.strictEqual(store.getState().workspace.todos.length, 1);
		assert.strictEqual(store.getState().workspace.todos[0].text, "workspace task");
	});

	test("create: honors isNote and isMarkdown flags", async () => {
		const result = await service.addTodo(TodoScope.user, "a note", {
			isNote: true,
			isMarkdown: true,
		});
		assert.ok(result);
		assert.strictEqual(result!.todo.isNote, true);
		assert.strictEqual(result!.todo.isMarkdown, true);
	});

	test("create: adds to the active currentFile via the store", async () => {
		store.dispatch(currentFileActions.loadData({ filePath: activeFilePath, data: [] }));
		const result = await service.addTodo(TodoScope.currentFile, "active file task", {
			filePath: activeFilePath,
		});
		assert.ok(result);
		assert.strictEqual(store.getState().currentFile.todos.length, 1);
		assert.strictEqual(store.getState().currentFile.todos[0].text, "active file task");
	});

	test("create: adds to a non-active file by path and persists it", async () => {
		const result = await service.addTodo(TodoScope.currentFile, "other file task", {
			filePath: otherFilePath,
		});
		assert.ok(result);
		assert.strictEqual(result!.filePath, otherFilePath);
		const persisted = readFileTodos(context, otherFilePath);
		assert.strictEqual(persisted.length, 1);
		assert.strictEqual(persisted[0].text, "other file task");
	});

	// --- Read ---------------------------------------------------------------

	test("read: listTodos returns items for a scope", async () => {
		await service.addTodo(TodoScope.user, "alpha");
		await service.addTodo(TodoScope.user, "beta");
		const { todos } = service.listTodos(TodoScope.user);
		assert.strictEqual(todos.length, 2);
	});

	test("read: noteOnly and textPrefix filters", async () => {
		await service.addTodo(TodoScope.user, "keep me", { isNote: true });
		await service.addTodo(TodoScope.user, "task one");
		await service.addTodo(TodoScope.user, "other");

		const notesOnly = service.listTodos(TodoScope.user, { noteOnly: true });
		assert.strictEqual(notesOnly.todos.length, 1);
		assert.strictEqual(notesOnly.todos[0].text, "keep me");

		const prefixed = service.listTodos(TodoScope.user, { textPrefix: "task" });
		assert.strictEqual(prefixed.todos.length, 1);
		assert.strictEqual(prefixed.todos[0].text, "task one");
	});

	test("read: pagination returns total/count/hasMore/nextOffset", async () => {
		for (let i = 0; i < 5; i++) {
			await service.addTodo(TodoScope.user, `item ${i}`);
		}
		const page = service.listTodosPaginated(TodoScope.user, {}, { limit: 2, offset: 0 });
		assert.strictEqual(page.total, 5);
		assert.strictEqual(page.count, 2);
		assert.strictEqual(page.items.length, 2);
		assert.strictEqual(page.hasMore, true);
		assert.strictEqual(page.nextOffset, 2);

		const last = service.listTodosPaginated(TodoScope.user, {}, { limit: 2, offset: 4 });
		assert.strictEqual(last.count, 1);
		assert.strictEqual(last.hasMore, false);
		assert.strictEqual(last.nextOffset, undefined);
	});

	test("read: non-active file todos are listed by path", async () => {
		seedFileTodos(context, otherFilePath, [makeTodo(1, "seeded")]);
		const { todos, filePath } = service.listTodos(TodoScope.currentFile, {
			filePath: otherFilePath,
		});
		assert.strictEqual(filePath, otherFilePath);
		assert.strictEqual(todos.length, 1);
		assert.strictEqual(todos[0].text, "seeded");
	});

	// --- Update text --------------------------------------------------------

	test("update text: changes text in the user scope", async () => {
		const created = await service.addTodo(TodoScope.user, "original");
		const id = created!.todo.id;
		const result = await service.updateTodoText(TodoScope.user, id, "edited");
		assert.strictEqual(result.todo.text, "edited");
		assert.strictEqual(store.getState().user.todos[0].text, "edited");
	});

	test("update text: changes text in a non-active file and persists", async () => {
		seedFileTodos(context, otherFilePath, [makeTodo(42, "before")]);
		const result = await service.updateTodoText(TodoScope.currentFile, 42, "after", {
			filePath: otherFilePath,
		});
		assert.strictEqual(result.todo.text, "after");
		assert.strictEqual(readFileTodos(context, otherFilePath)[0].text, "after");
	});

	test("update text: unknown id throws", async () => {
		await assert.rejects(
			() => service.updateTodoText(TodoScope.user, 999999, "nope"),
			/No todo with id 999999/
		);
	});

	// --- Toggle completed ---------------------------------------------------

	test("set completed: completing sets completionDate, reopening clears it", async () => {
		const created = await service.addTodo(TodoScope.user, "do it");
		const id = created!.todo.id;

		const completed = await service.setCompleted(TodoScope.user, id, true);
		assert.strictEqual(completed.todo.completed, true);
		assert.ok(completed.todo.completionDate, "completionDate should be set");

		const reopened = await service.setCompleted(TodoScope.user, id, false);
		assert.strictEqual(reopened.todo.completed, false);
		assert.strictEqual(reopened.todo.completionDate, undefined);
	});

	test("set completed: idempotent — setting the same value twice does not flip", async () => {
		const created = await service.addTodo(TodoScope.user, "do it");
		const id = created!.todo.id;
		await service.setCompleted(TodoScope.user, id, true);
		const again = await service.setCompleted(TodoScope.user, id, true);
		assert.strictEqual(again.todo.completed, true);
	});

	test("set completed: works for a non-active file", async () => {
		seedFileTodos(context, otherFilePath, [makeTodo(7, "file task")]);
		const result = await service.setCompleted(TodoScope.currentFile, 7, true, {
			filePath: otherFilePath,
		});
		assert.strictEqual(result.todo.completed, true);
		assert.ok(readFileTodos(context, otherFilePath)[0].completionDate);
	});

	// --- Toggle note / markdown ---------------------------------------------

	test("set note: flips a task into a note and is idempotent", async () => {
		const created = await service.addTodo(TodoScope.workspace, "a task");
		const id = created!.todo.id;

		const asNote = await service.setNote(TodoScope.workspace, id, true);
		assert.strictEqual(asNote.todo.isNote, true);

		const stillNote = await service.setNote(TodoScope.workspace, id, true);
		assert.strictEqual(stillNote.todo.isNote, true);

		const backToTask = await service.setNote(TodoScope.workspace, id, false);
		assert.strictEqual(backToTask.todo.isNote, false);
	});

	test("set markdown: toggles the markdown flag", async () => {
		const created = await service.addTodo(TodoScope.user, "text");
		const id = created!.todo.id;
		const md = await service.setMarkdown(TodoScope.user, id, true);
		assert.strictEqual(md.todo.isMarkdown, true);
		const plain = await service.setMarkdown(TodoScope.user, id, false);
		assert.strictEqual(plain.todo.isMarkdown, false);
	});

	test("set note: works for a non-active file", async () => {
		seedFileTodos(context, otherFilePath, [makeTodo(9, "file item")]);
		const result = await service.setNote(TodoScope.currentFile, 9, true, {
			filePath: otherFilePath,
		});
		assert.strictEqual(result.todo.isNote, true);
		assert.strictEqual(readFileTodos(context, otherFilePath)[0].isNote, true);
	});

	// --- Delete -------------------------------------------------------------

	test("delete: removes a single item and returns it", async () => {
		const created = await service.addTodo(TodoScope.user, "delete me");
		const id = created!.todo.id;
		const result = await service.deleteTodos(TodoScope.user, [id]);
		assert.strictEqual(result.count, 1);
		assert.strictEqual(result.deleted[0].id, id);
		assert.strictEqual(store.getState().user.todos.length, 0);
	});

	test("delete: removes multiple items", async () => {
		const a = await service.addTodo(TodoScope.user, "a");
		const b = await service.addTodo(TodoScope.user, "b");
		await service.addTodo(TodoScope.user, "c");
		const result = await service.deleteTodos(TodoScope.user, [a!.todo.id, b!.todo.id]);
		assert.strictEqual(result.count, 2);
		assert.strictEqual(store.getState().user.todos.length, 1);
		assert.strictEqual(store.getState().user.todos[0].text, "c");
	});

	test("delete: non-matching ids return count 0", async () => {
		await service.addTodo(TodoScope.user, "keep");
		const result = await service.deleteTodos(TodoScope.user, [123456]);
		assert.strictEqual(result.count, 0);
		assert.strictEqual(result.deleted.length, 0);
		assert.strictEqual(store.getState().user.todos.length, 1);
	});

	test("delete: removing all todos from a file removes the file entry", async () => {
		seedFileTodos(context, otherFilePath, [makeTodo(1, "x"), makeTodo(2, "y")]);
		const result = await service.deleteTodos(TodoScope.currentFile, [1, 2], {
			filePath: otherFilePath,
		});
		assert.strictEqual(result.count, 2);
		const filesData = (context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
		assert.ok(
			!Object.prototype.hasOwnProperty.call(filesData, otherFilePath),
			"file entry should be removed when it has no todos"
		);
	});

	// --- Guards / security --------------------------------------------------

	test("guard: read-only mode blocks every mutating operation", async () => {
		const created = await service.addTodo(TodoScope.user, "seed");
		const id = created!.todo.id;
		service.updateAccess(true, ["user", "workspace", "file"]);

		await assert.rejects(() => service.addTodo(TodoScope.user, "x"), /read-only/);
		await assert.rejects(() => service.updateTodoText(TodoScope.user, id, "x"), /read-only/);
		await assert.rejects(() => service.setCompleted(TodoScope.user, id, true), /read-only/);
		await assert.rejects(() => service.setNote(TodoScope.user, id, true), /read-only/);
		await assert.rejects(() => service.setMarkdown(TodoScope.user, id, true), /read-only/);
		await assert.rejects(() => service.deleteTodos(TodoScope.user, [id]), /read-only/);

		// Reads still work in read-only mode.
		assert.strictEqual(service.listTodos(TodoScope.user).todos.length, 1);
	});

	test("guard: disallowed scope is rejected", async () => {
		service.updateAccess(false, ["user"]);
		await assert.rejects(
			() => service.addTodo(TodoScope.workspace, "x"),
			/not permitted/
		);
		assert.throws(() => service.listTodos(TodoScope.workspace), /not permitted/);
	});
});
