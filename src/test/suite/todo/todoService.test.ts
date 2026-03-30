import * as assert from "assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { after, before, beforeEach } from "mocha";
import createStore, {
	currentFileActions,
	userActions,
	workspaceActions,
} from "../../../todo/store";
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
import {
	getWorkspacePath,
	resolveFilesDataKey,
	ensureFilesDataPaths,
} from "../../../todo/todoUtils";
import { getConfig } from "../../../utilities/config";

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
		(
			vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }
		).getWorkspaceFolder = (uri: vscode.Uri) =>
			uri.fsPath.startsWith(workspaceRoot) ? fakeFolder : undefined;
	});

	after(() => {
		if (originalFolders) {
			Object.defineProperty(vscode.workspace, "workspaceFolders", originalFolders);
		}
		(
			vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }
		).getWorkspaceFolder = originalGetWorkspaceFolder;
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

	test("read: kind and textPrefix filters", async () => {
		await service.addTodo(TodoScope.user, "keep me", { isNote: true });
		await service.addTodo(TodoScope.user, "task one");
		await service.addTodo(TodoScope.user, "other");

		const notesOnly = service.listTodos(TodoScope.user, { kind: "note" });
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

	test("set completed: idempotent for a non-active file — completionDate is preserved", async () => {
		seedFileTodos(context, otherFilePath, [makeTodo(8, "file task")]);
		await service.setCompleted(TodoScope.currentFile, 8, true, { filePath: otherFilePath });
		const firstDate = readFileTodos(context, otherFilePath)[0].completionDate;
		assert.ok(firstDate, "completionDate should be set on first completion");

		const again = await service.setCompleted(TodoScope.currentFile, 8, true, {
			filePath: otherFilePath,
		});
		assert.strictEqual(again.todo.completed, true);
		assert.strictEqual(
			again.todo.completionDate,
			firstDate,
			"re-completing must not rewrite the completion date"
		);
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
		await assert.rejects(() => service.addTodo(TodoScope.workspace, "x"), /not permitted/);
		assert.throws(() => service.listTodos(TodoScope.workspace), /not permitted/);
	});
});

/**
 * Ordered-insert coverage: the per-call `position` override on addTodo and the
 * addTodos batch. The host's createPosition config defaults to "bottom", so the
 * "top" path is exercised via an explicit position override — which is exactly the
 * new capability under test and is deterministic regardless of the host config.
 * Default sortType1 keeps all-incomplete tasks in insertion order, so an appended
 * block stays in the order it was given.
 */
suite("TodoService ordered insert", () => {
	let store: EnhancedStore<StoreState>;
	let context: vscode.ExtensionContext;
	let service: TodoService;
	const workspaceRoot = path.join(os.tmpdir(), "vsc-todo-order-test");
	const otherFilePath = path.join(workspaceRoot, "src", "order-other.ts");

	let originalFolders: PropertyDescriptor | undefined;
	let originalGetWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder;
	const fakeFolder = {
		uri: vscode.Uri.file(workspaceRoot),
		name: "vsc-todo-order-test",
		index: 0,
	} as vscode.WorkspaceFolder;

	before(() => {
		originalFolders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			get: () => [fakeFolder],
		});
		originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
		(
			vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }
		).getWorkspaceFolder = (uri: vscode.Uri) =>
			uri.fsPath.startsWith(workspaceRoot) ? fakeFolder : undefined;
	});

	after(() => {
		if (originalFolders) {
			Object.defineProperty(vscode.workspace, "workspaceFolders", originalFolders);
		}
		(
			vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }
		).getWorkspaceFolder = originalGetWorkspaceFolder;
	});

	beforeEach(() => {
		store = createStore();
		const mock = createMockContext();
		context = mock.context;
		const storage = createMockStorage(context);
		service = new TodoService(context, store as EnhancedStore<StoreState>, storage);
		service.updateAccess(false, ["user", "workspace", "file"]);
	});

	const texts = (todos: Todo[]): string[] => todos.map((t) => t.text);

	// --- single-item position override --------------------------------------

	test("position: explicit 'top' puts the new item first; 'bottom' appends", async () => {
		await service.addTodo(TodoScope.user, "first-added");
		await service.addTodo(TodoScope.user, "to-top", { position: "top" });
		await service.addTodo(TodoScope.user, "to-bottom", { position: "bottom" });

		assert.deepStrictEqual(texts(store.getState().user.todos), [
			"to-top",
			"first-added",
			"to-bottom",
		]);
	});

	test("position: omitted falls back to the configured createPosition", async () => {
		// Config-agnostic but absolute: omitting position must match BOTH an explicit pass of
		// the host's configured createPosition AND the concrete order that position implies.
		// (The dev host may be "top" or "bottom".)
		const configured = getConfig().createPosition;
		await service.addTodo(TodoScope.user, "anchor");
		await service.addTodo(TodoScope.user, "added"); // no position → uses config
		await service.addTodo(TodoScope.workspace, "anchor");
		await service.addTodo(TodoScope.workspace, "added", { position: configured });

		const expected = configured === "top" ? ["added", "anchor"] : ["anchor", "added"];
		assert.deepStrictEqual(texts(store.getState().user.todos), expected);
		assert.deepStrictEqual(texts(store.getState().workspace.todos), expected);
	});

	// --- batch addTodos order -----------------------------------------------

	test("batch: 'bottom' appends the block preserving the given order", async () => {
		const result = await service.addTodos(
			TodoScope.user,
			[{ text: "A" }, { text: "B" }, { text: "C" }],
			{ position: "bottom" }
		);
		assert.deepStrictEqual(texts(result.todos), ["A", "B", "C"]);
		assert.deepStrictEqual(texts(store.getState().user.todos), ["A", "B", "C"]);
	});

	test("batch: 'top' inserts the block at the front, not reversed", async () => {
		await service.addTodos(TodoScope.user, [{ text: "existing" }], { position: "bottom" });
		await service.addTodos(TodoScope.user, [{ text: "A" }, { text: "B" }, { text: "C" }], {
			position: "top",
		});
		// First array element ends topmost; block keeps A,B,C order; "existing" stays last.
		assert.deepStrictEqual(texts(store.getState().user.todos), ["A", "B", "C", "existing"]);
	});

	test("batch: a notes/tasks mix keeps array order and per-item flags", async () => {
		const result = await service.addTodos(
			TodoScope.user,
			[{ text: "task-1" }, { text: "note-1", isNote: true }, { text: "task-2" }],
			{ position: "bottom" }
		);
		assert.deepStrictEqual(texts(result.todos), ["task-1", "note-1", "task-2"]);
		assert.deepStrictEqual(texts(store.getState().user.todos), ["task-1", "note-1", "task-2"]);
		const byText = (t: string) => store.getState().user.todos.find((todo) => todo.text === t);
		assert.strictEqual(byText("note-1")!.isNote, true);
		assert.strictEqual(byText("task-1")!.isNote, false);
		assert.strictEqual(byText("task-2")!.isNote, false);
	});

	test("batch: ids are unique within the block and against existing items", async () => {
		await service.addTodos(TodoScope.user, [{ text: "seed" }], { position: "bottom" });
		const result = await service.addTodos(
			TodoScope.user,
			[{ text: "A" }, { text: "B" }, { text: "C" }],
			{ position: "bottom" }
		);
		const ids = new Set(result.todos.map((t) => t.id));
		assert.strictEqual(ids.size, 3, "new ids are distinct from each other");
		// No new id collides with the pre-existing item.
		const allIds = new Set(store.getState().user.todos.map((t) => t.id));
		assert.strictEqual(allIds.size, 4, "all ids unique across existing + batch");
	});

	// --- batch on a non-active file -----------------------------------------

	test("batch: non-active currentFile persists the block in order", async () => {
		const result = await service.addTodos(
			TodoScope.currentFile,
			[{ text: "X" }, { text: "Y" }, { text: "Z" }],
			{ filePath: otherFilePath, position: "bottom" }
		);
		assert.strictEqual(result.filePath, otherFilePath);
		assert.deepStrictEqual(texts(result.todos), ["X", "Y", "Z"]);
		const persisted = readFileTodos(context, otherFilePath);
		assert.deepStrictEqual(texts(persisted), ["X", "Y", "Z"]);
	});

	// --- guards -------------------------------------------------------------

	test("read-only mode blocks addTodos and addTodo with position", async () => {
		service.updateAccess(true, ["user", "workspace", "file"]);
		await assert.rejects(() => service.addTodos(TodoScope.user, [{ text: "x" }]), /read-only/);
		await assert.rejects(
			() => service.addTodo(TodoScope.user, "x", { position: "top" }),
			/read-only/
		);
	});

	test("batch: disallowed scope is rejected", async () => {
		service.updateAccess(false, ["user"]);
		await assert.rejects(
			() => service.addTodos(TodoScope.workspace, [{ text: "x" }]),
			/not permitted/
		);
	});
});

/**
 * Phase 1 read-path coverage: the kind/completed filters (1b) and the size-aware
 * pagination char budget (1a). User scope only — it needs no workspace folder stub.
 *
 * These tests assume store insertion order is preserved: Phase 1 applies no sorting
 * on the read path (sort control arrives in Phase 2), so listTodos returns items in
 * the order they were added.
 */
suite("TodoService list filters & size-aware pagination", () => {
	let store: EnhancedStore<StoreState>;
	let service: TodoService;

	beforeEach(() => {
		store = createStore();
		const mock = createMockContext();
		const storage = createMockStorage(mock.context);
		service = new TodoService(mock.context, store as EnhancedStore<StoreState>, storage);
		service.updateAccess(false, ["user", "workspace", "file"]);
	});

	// --- kind / completed filters (1b) --------------------------------------

	test("kind: 'task' returns tasks only, 'note' returns notes only, 'all' returns both", async () => {
		await service.addTodo(TodoScope.user, "a task");
		await service.addTodo(TodoScope.user, "a note", { isNote: true });

		assert.strictEqual(service.listTodos(TodoScope.user, { kind: "task" }).todos.length, 1);
		assert.strictEqual(service.listTodos(TodoScope.user, { kind: "task" }).todos[0].text, "a task");
		assert.strictEqual(service.listTodos(TodoScope.user, { kind: "note" }).todos.length, 1);
		assert.strictEqual(service.listTodos(TodoScope.user, { kind: "all" }).todos.length, 2);
		// Omitting kind behaves like "all".
		assert.strictEqual(service.listTodos(TodoScope.user, {}).todos.length, 2);
	});

	test("completed: false returns open items, true returns done items", async () => {
		const open = await service.addTodo(TodoScope.user, "open task");
		const done = await service.addTodo(TodoScope.user, "done task");
		await service.setCompleted(TodoScope.user, done!.todo.id, true);

		const openItems = service.listTodos(TodoScope.user, { completed: false }).todos;
		assert.strictEqual(openItems.length, 1);
		assert.strictEqual(openItems[0].id, open!.todo.id);

		const doneItems = service.listTodos(TodoScope.user, { completed: true }).todos;
		assert.strictEqual(doneItems.length, 1);
		assert.strictEqual(doneItems[0].id, done!.todo.id);

		// Omitting completed returns both.
		assert.strictEqual(service.listTodos(TodoScope.user, {}).todos.length, 2);
	});

	test("kind + completed compose (open tasks only)", async () => {
		const openTask = await service.addTodo(TodoScope.user, "open task");
		const doneTask = await service.addTodo(TodoScope.user, "done task");
		await service.setCompleted(TodoScope.user, doneTask!.todo.id, true);
		await service.addTodo(TodoScope.user, "a note", { isNote: true });

		const result = service.listTodos(TodoScope.user, { kind: "task", completed: false }).todos;
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, openTask!.todo.id);
	});

	test("kind 'note' + completed true is empty (notes are never completed)", async () => {
		await service.addTodo(TodoScope.user, "a note", { isNote: true });
		await service.addTodo(TodoScope.user, "a task");

		const result = service.listTodos(TodoScope.user, { kind: "note", completed: true }).todos;
		assert.strictEqual(result.length, 0);
	});

	test("no filters returns a copy, not the backing store array", async () => {
		await service.addTodo(TodoScope.user, "x");
		const result = service.listTodos(TodoScope.user, {}).todos;
		assert.notStrictEqual(
			result,
			store.getState().user.todos,
			"mutating the result must not corrupt store state"
		);
	});

	// --- search filter (3a) -------------------------------------------------

	test("search: matches a substring anywhere, case-insensitively", async () => {
		await service.addTodo(TodoScope.user, "Refactor the AUTH module");
		await service.addTodo(TodoScope.user, "write docs");

		const result = service.listTodos(TodoScope.user, { search: "auth" }).todos;
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].text, "Refactor the AUTH module");
	});

	test("search: matches mid-word where textPrefix would not", async () => {
		await service.addTodo(TodoScope.user, "fix the parser");

		// "parser" is not a prefix of the text, so textPrefix misses it...
		assert.strictEqual(service.listTodos(TodoScope.user, { textPrefix: "parser" }).todos.length, 0);
		// ...but search matches the substring anywhere.
		assert.strictEqual(service.listTodos(TodoScope.user, { search: "parser" }).todos.length, 1);
	});

	test("search: composes with kind and completed", async () => {
		const openTask = await service.addTodo(TodoScope.user, "deploy the service");
		const doneTask = await service.addTodo(TodoScope.user, "deploy the docs");
		await service.setCompleted(TodoScope.user, doneTask!.todo.id, true);
		await service.addTodo(TodoScope.user, "deploy notes", { isNote: true });

		const result = service.listTodos(TodoScope.user, {
			search: "deploy",
			kind: "task",
			completed: false,
		}).todos;
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, openTask!.todo.id);
	});

	test("search: empty string is a no-op (returns all)", async () => {
		await service.addTodo(TodoScope.user, "a");
		await service.addTodo(TodoScope.user, "b");
		assert.strictEqual(service.listTodos(TodoScope.user, { search: "" }).todos.length, 2);
	});

	test("search: matches literally, including spaces (no trimming, unlike textPrefix)", async () => {
		await service.addTodo(TodoScope.user, "the parser");
		// A substring spanning the space matches; search is plain includes with no trim.
		assert.strictEqual(service.listTodos(TodoScope.user, { search: "e par" }).todos.length, 1);
		// A space that doesn't occur literally does not match.
		assert.strictEqual(service.listTodos(TodoScope.user, { search: "the  parser" }).todos.length, 0);
	});

	// --- size-aware pagination (1a) -----------------------------------------

	test("maxChars: trims a middle page and next_offset resumes at the remainder", async () => {
		// 10 items; a small budget so only the first few fit, well within the count limit.
		for (let i = 0; i < 10; i++) {
			await service.addTodo(TodoScope.user, `item ${i}`);
		}
		const all = service.listTodos(TodoScope.user).todos;
		const perItem = JSON.stringify(all[0]).length;

		// Budget for ~3 items, asked for a count limit of 8 — size cap must bite first.
		const page = service.listTodosPaginated(
			TodoScope.user,
			{},
			{ limit: 8, offset: 0, maxChars: perItem * 3 }
		);
		assert.strictEqual(page.total, 10);
		assert.ok(page.count < 8, "size budget should trim below the count limit");
		assert.ok(page.count >= 1, "page is never empty while items remain");
		assert.strictEqual(page.count, page.items.length);
		assert.strictEqual(page.hasMore, true);
		assert.strictEqual(page.nextOffset, page.count);

		// Following next_offset returns the remainder with no gap or duplication.
		const next = service.listTodosPaginated(
			TodoScope.user,
			{},
			{ limit: 8, offset: page.nextOffset, maxChars: perItem * 3 }
		);
		assert.strictEqual(next.items[0].id, all[page.count].id);
	});

	test("maxChars: with a non-zero offset, next_offset resumes correctly", async () => {
		for (let i = 0; i < 10; i++) {
			await service.addTodo(TodoScope.user, `item ${i}`);
		}
		const all = service.listTodos(TodoScope.user).todos;
		const perItem = JSON.stringify(all[0]).length;

		// Start mid-list at offset 4, budget ~2 items.
		const page = service.listTodosPaginated(
			TodoScope.user,
			{},
			{ limit: 8, offset: 4, maxChars: perItem * 2 }
		);
		assert.ok(page.count >= 1 && page.count < 8);
		assert.strictEqual(page.items[0].id, all[4].id, "page starts at the requested offset");
		assert.strictEqual(page.hasMore, true);
		// nextOffset must point at offset + count, i.e. the first un-returned item.
		assert.strictEqual(page.nextOffset, 4 + page.count);

		const next = service.listTodosPaginated(
			TodoScope.user,
			{},
			{ limit: 8, offset: page.nextOffset, maxChars: perItem * 2 }
		);
		assert.strictEqual(next.items[0].id, all[4 + page.count].id, "no gap or duplication");
	});

	test("maxChars: trimming the last page flips hasMore to true", async () => {
		for (let i = 0; i < 4; i++) {
			await service.addTodo(TodoScope.user, `item ${i}`);
		}
		const all = service.listTodos(TodoScope.user).todos;
		const perItem = JSON.stringify(all[0]).length;

		// Count limit covers all 4 (would be the last page), but the budget fits ~2.
		const page = service.listTodosPaginated(
			TodoScope.user,
			{},
			{ limit: 50, offset: 0, maxChars: perItem * 2 }
		);
		assert.ok(page.count < 4, "budget should trim the otherwise-final page");
		assert.strictEqual(page.hasMore, true, "trimming the last page must flip hasMore to true");
		assert.strictEqual(page.nextOffset, page.count);
		assert.ok(page.nextOffset! <= page.total);
	});

	test("maxChars: a single oversized item is still returned alone", async () => {
		await service.addTodo(TodoScope.user, "x".repeat(5000));
		await service.addTodo(TodoScope.user, "small");

		const page = service.listTodosPaginated(
			TodoScope.user,
			{},
			{ limit: 50, offset: 0, maxChars: 100 }
		);
		assert.strictEqual(page.count, 1, "first item is returned even though it exceeds the budget");
		assert.strictEqual(page.hasMore, true);
		assert.strictEqual(page.nextOffset, 1);
	});

	test("maxChars: undefined passes the count page through unchanged", async () => {
		for (let i = 0; i < 3; i++) {
			await service.addTodo(TodoScope.user, `item ${i}`);
		}
		const page = service.listTodosPaginated(TodoScope.user, {}, { limit: 50, offset: 0 });
		assert.strictEqual(page.count, 3);
		assert.strictEqual(page.hasMore, false);
		assert.strictEqual(page.nextOffset, undefined);
	});

	// --- sort control (2b) --------------------------------------------------

	/**
	 * Seed three todos with distinct, increasing creationDate values so order is
	 * deterministic regardless of how fast the test runs.
	 */
	const seedDatedTodos = (): void => {
		store.dispatch(
			userActions.loadData({
				data: [
					makeTodo(1, "oldest", { creationDate: "2026-01-01T00:00:00.000Z" }),
					makeTodo(2, "middle", { creationDate: "2026-02-01T00:00:00.000Z" }),
					makeTodo(3, "newest", { creationDate: "2026-03-01T00:00:00.000Z" }),
				],
			})
		);
	};

	test("sortBy creationDate: asc is chronological, desc is reverse", () => {
		seedDatedTodos();
		const asc = service.listTodos(TodoScope.user, { sortBy: "creationDate", order: "asc" }).todos;
		assert.deepStrictEqual(
			asc.map((t) => t.text),
			["oldest", "middle", "newest"]
		);
		const desc = service.listTodos(TodoScope.user, {
			sortBy: "creationDate",
			order: "desc",
		}).todos;
		assert.deepStrictEqual(
			desc.map((t) => t.text),
			["newest", "middle", "oldest"]
		);
	});

	test("sortBy creationDate: order defaults to asc", () => {
		seedDatedTodos();
		const def = service.listTodos(TodoScope.user, { sortBy: "creationDate" }).todos;
		assert.deepStrictEqual(
			def.map((t) => t.text),
			["oldest", "middle", "newest"]
		);
	});

	test("sortBy completed: asc puts open first, desc puts done first", () => {
		// Seed done-before-open via loadData so the comparator must actively reorder
		// (loadData preserves array order and skips the store's completion re-sort).
		store.dispatch(
			userActions.loadData({
				data: [
					makeTodo(1, "done", {
						completed: true,
						completionDate: "2026-02-01T00:00:00.000Z",
					}),
					makeTodo(2, "open"),
				],
			})
		);

		const asc = service.listTodos(TodoScope.user, { sortBy: "completed", order: "asc" }).todos;
		assert.deepStrictEqual(
			asc.map((t) => t.text),
			["open", "done"]
		);

		const desc = service.listTodos(TodoScope.user, { sortBy: "completed", order: "desc" }).todos;
		assert.deepStrictEqual(
			desc.map((t) => t.text),
			["done", "open"]
		);
	});

	test("sortBy completionDate: groups open items (no date) first in asc", () => {
		store.dispatch(
			userActions.loadData({
				data: [
					makeTodo(1, "done-late", {
						completed: true,
						completionDate: "2026-03-01T00:00:00.000Z",
					}),
					makeTodo(2, "open"),
					makeTodo(3, "done-early", {
						completed: true,
						completionDate: "2026-01-01T00:00:00.000Z",
					}),
				],
			})
		);

		const asc = service.listTodos(TodoScope.user, {
			sortBy: "completionDate",
			order: "asc",
		}).todos;
		// "" (open) sorts first, then the completed items in chronological order.
		assert.deepStrictEqual(
			asc.map((t) => t.text),
			["open", "done-early", "done-late"]
		);

		const desc = service.listTodos(TodoScope.user, {
			sortBy: "completionDate",
			order: "desc",
		}).todos;
		assert.deepStrictEqual(
			desc.map((t) => t.text),
			["done-late", "done-early", "open"]
		);
	});

	test("sort runs before pagination: page 1 of desc creationDate has the newest items", () => {
		seedDatedTodos();
		const page = service.listTodosPaginated(
			TodoScope.user,
			{ sortBy: "creationDate", order: "desc" },
			{ limit: 2, offset: 0 }
		);
		assert.deepStrictEqual(
			page.items.map((t) => t.text),
			["newest", "middle"]
		);
		assert.strictEqual(page.hasMore, true);
		assert.strictEqual(page.nextOffset, 2);
	});

	test("no sortBy preserves stored order", () => {
		// loadData preserves array order (unlike addTodo, which honors the createPosition
		// setting), so this isolates the "no sort = stored order" guarantee.
		store.dispatch(
			userActions.loadData({
				data: [makeTodo(1, "first"), makeTodo(2, "second")],
			})
		);
		const result = service.listTodos(TodoScope.user, {}).todos;
		assert.deepStrictEqual(
			result.map((t) => t.text),
			["first", "second"]
		);
	});
});

/**
 * Phase 2a coverage: todo_count_items is backed by TodoService.getCounts(), which
 * reports per-scope counts and is gated by allowedScopes.
 */
suite("TodoService getCounts", () => {
	let store: EnhancedStore<StoreState>;
	let service: TodoService;

	beforeEach(() => {
		store = createStore();
		const mock = createMockContext();
		const storage = createMockStorage(mock.context);
		service = new TodoService(mock.context, store as EnhancedStore<StoreState>, storage);
		service.updateAccess(false, ["user", "workspace", "file"]);
	});

	test("counts match the store per scope", () => {
		// Seed the slices directly via loadData: getCounts reads slice state and does not
		// require an open workspace folder (unlike addTodo), keeping this test self-contained.
		store.dispatch(
			userActions.loadData({
				data: [makeTodo(1, "task"), makeTodo(2, "note", { isNote: true })],
			})
		);
		store.dispatch(workspaceActions.loadData({ data: [makeTodo(3, "ws task")] }));

		const counts = service.getCounts();
		assert.deepStrictEqual(counts.user, { todos: 1, notes: 1 });
		assert.deepStrictEqual(counts.workspace, { todos: 1, notes: 0 });
	});

	test("disallowed scopes are omitted entirely", () => {
		service.updateAccess(false, ["user"]);
		const counts = service.getCounts();
		assert.ok(counts.user, "user scope should be present");
		assert.strictEqual(counts.workspace, undefined, "workspace omitted when not allowed");
		assert.strictEqual(counts.currentFile, undefined, "currentFile omitted when not allowed");
	});
});

/**
 * Phase 4 coverage: the tag read filter (todo_list_items `tag`), tag-scoped counts
 * (todo_count_items `tag`), and the todo_set_tags write path, all backed by TodoService.
 */
suite("TodoService tags", () => {
	let store: EnhancedStore<StoreState>;
	let service: TodoService;

	beforeEach(() => {
		store = createStore();
		const mock = createMockContext();
		const storage = createMockStorage(mock.context);
		service = new TodoService(mock.context, store as EnhancedStore<StoreState>, storage);
		service.updateAccess(false, ["user", "workspace", "file"]);
	});

	test("tag filter returns only items carrying the tag (case-insensitive)", () => {
		store.dispatch(
			userActions.loadData({
				data: [
					makeTodo(1, "a", { tags: ["Plan", "bug"] }),
					makeTodo(2, "b", { tags: ["plan"] }),
					makeTodo(3, "c", { tags: ["other"] }),
					makeTodo(4, "d"),
				],
			})
		);

		const result = service.listTodos(TodoScope.user, { tag: "PLAN" }).todos;
		assert.deepStrictEqual(
			result.map((t) => t.id),
			[1, 2]
		);
	});

	test("tag filter composes with kind and completed", () => {
		store.dispatch(
			userActions.loadData({
				data: [
					makeTodo(1, "open task", { tags: ["plan"] }),
					makeTodo(2, "done task", { tags: ["plan"], completed: true }),
					makeTodo(3, "note", { tags: ["plan"], isNote: true }),
					makeTodo(4, "untagged task"),
				],
			})
		);

		const openPlanTasks = service.listTodos(TodoScope.user, {
			tag: "plan",
			kind: "task",
			completed: false,
		}).todos;
		assert.deepStrictEqual(
			openPlanTasks.map((t) => t.id),
			[1]
		);
	});

	test("empty / whitespace tag is a no-op filter", () => {
		store.dispatch(
			userActions.loadData({ data: [makeTodo(1, "a", { tags: ["plan"] }), makeTodo(2, "b")] })
		);
		assert.strictEqual(service.listTodos(TodoScope.user, { tag: "" }).todos.length, 2);
		assert.strictEqual(service.listTodos(TodoScope.user, { tag: "   " }).todos.length, 2);
	});

	test("getCounts with a tag reports tag-scoped progress including completed", () => {
		store.dispatch(
			userActions.loadData({
				data: [
					makeTodo(1, "open", { tags: ["plan"] }),
					makeTodo(2, "done", { tags: ["plan"], completed: true }),
					makeTodo(3, "note", { tags: ["plan"], isNote: true }),
					makeTodo(4, "other", { tags: ["misc"] }),
				],
			})
		);

		const counts = service.getCounts("plan");
		assert.deepStrictEqual(counts.user, { todos: 1, notes: 1, completed: 1 });
	});

	test("getCounts without a tag is unchanged (no completed field)", () => {
		store.dispatch(
			userActions.loadData({ data: [makeTodo(1, "task"), makeTodo(2, "note", { isNote: true })] })
		);
		assert.deepStrictEqual(service.getCounts().user, { todos: 1, notes: 1 });
	});

	test("setTags normalizes and replaces tags", async () => {
		const created = await service.addTodo(TodoScope.user, "task");
		const id = created!.todo.id;

		const result = await service.setTags(TodoScope.user, id, ["  Bug  ", "bug", "a b", "feature"]);
		assert.deepStrictEqual(result.todo.tags, ["Bug", "feature"]);
		assert.deepStrictEqual(store.getState().user.todos[0].tags, ["Bug", "feature"]);
	});

	test("setTags with an empty list clears the field", async () => {
		const created = await service.addTodo(TodoScope.user, "task");
		const id = created!.todo.id;
		await service.setTags(TodoScope.user, id, ["bug"]);

		const cleared = await service.setTags(TodoScope.user, id, []);
		assert.strictEqual(cleared.todo.tags, undefined);
		assert.strictEqual(store.getState().user.todos[0].tags, undefined);
	});

	test("setTags is blocked in read-only mode", async () => {
		const created = await service.addTodo(TodoScope.user, "task");
		const id = created!.todo.id;
		service.updateAccess(true, ["user", "workspace", "file"]);
		await assert.rejects(() => service.setTags(TodoScope.user, id, ["bug"]), /read-only/);
	});
});
