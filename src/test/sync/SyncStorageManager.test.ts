/**
 * Unit tests for SyncStorageManager
 * Tests data isolation across sync modes
 */

import * as assert from "assert";
import { SyncStorageManager } from "../../sync/SyncStorageManager";
import { GlobalSyncMode, WorkspaceSyncMode, StorageKeys } from "../../sync/syncTypes";
import { Todo } from "../../todo/todoTypes";

suite("SyncStorageManager Test Suite", () => {
	let manager: SyncStorageManager;
	let mockContext: any;

	setup(() => {
		// Create mock context with in-memory storage
		const globalStateStore = new Map<string, any>();
		const workspaceStateStore = new Map<string, any>();

		mockContext = {
			globalState: {
				get: (key: string, defaultValue?: any) => globalStateStore.get(key) ?? defaultValue,
				update: async (key: string, value: any) => {
					globalStateStore.set(key, value);
				},
			},
			workspaceState: {
				get: (key: string, defaultValue?: any) => workspaceStateStore.get(key) ?? defaultValue,
				update: async (key: string, value: any) => {
					workspaceStateStore.set(key, value);
				},
			},
		};

		manager = new SyncStorageManager(mockContext);
	});

	test("Data isolation: Local mode uses separate storage from GitHub mode", async () => {
		const localTodos: Todo[] = [
			{
				id: 1,
				text: "Local todo",
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: false,
				isNote: false,
			},
		];

		const githubTodos: Todo[] = [
			{
				id: 2,
				text: "GitHub todo",
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: false,
				isNote: false,
			},
		];

		// Set local mode data
		await manager.setGlobalTodos(GlobalSyncMode.Local, localTodos);

		// Set GitHub mode data
		await manager.setGlobalTodos(GlobalSyncMode.GitHub, githubTodos, "global/todos.json");

		// Verify data is isolated
		const retrievedLocal = await manager.getGlobalTodos(GlobalSyncMode.Local);
		const retrievedGithub = await manager.getGlobalTodos(GlobalSyncMode.GitHub, "global/todos.json");

		assert.strictEqual(retrievedLocal.length, 1);
		assert.strictEqual(retrievedLocal[0].text, "Local todo");

		assert.strictEqual(retrievedGithub.length, 1);
		assert.strictEqual(retrievedGithub[0].text, "GitHub todo");
	});

	test("Storage keys are correct for different modes", () => {
		// Global scope
		assert.strictEqual(StorageKeys.globalLocal, "globalTodos");
		assert.strictEqual(StorageKeys.globalProfileSync, "vscodeTodo.globalTodos");
		assert.strictEqual(StorageKeys.globalGistCache("global/todos.json"), "gistCache_global_global/todos.json");

		// Workspace scope
		assert.strictEqual(StorageKeys.workspaceLocal, "workspaceTodos");
		assert.strictEqual(StorageKeys.workspaceGistCache("workspace/ProjectA.json"), "gistCache_workspace_workspace/ProjectA.json");

		// File scope
		assert.strictEqual(StorageKeys.filesLocal, "filesData");
	});

	test("Workspace mode data isolation", async () => {
		const localWorkspaceTodos: Todo[] = [
			{
				id: 1,
				text: "Local workspace todo",
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: false,
				isNote: false,
			},
		];

		const githubWorkspaceTodos: Todo[] = [
			{
				id: 2,
				text: "GitHub workspace todo",
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: false,
				isNote: false,
			},
		];

		// Set local workspace data
		await manager.setWorkspaceTodos(WorkspaceSyncMode.Local, localWorkspaceTodos);

		// Set GitHub workspace data
		await manager.setWorkspaceTodos(WorkspaceSyncMode.GitHub, githubWorkspaceTodos, "workspace/ProjectA.json");

		// Verify isolation
		const retrievedLocal = await manager.getWorkspaceTodos(WorkspaceSyncMode.Local);
		const retrievedGithub = await manager.getWorkspaceTodos(WorkspaceSyncMode.GitHub, "workspace/ProjectA.json");

		assert.strictEqual(retrievedLocal.length, 1);
		assert.strictEqual(retrievedLocal[0].text, "Local workspace todo");

		assert.strictEqual(retrievedGithub.length, 1);
		assert.strictEqual(retrievedGithub[0].text, "GitHub workspace todo");
	});

	test("Cache management: dirty flag is set correctly", async () => {
		const todos: Todo[] = [
			{
				id: 1,
				text: "Test todo",
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: false,
				isNote: false,
			},
		];

		// Set todos in GitHub mode
		await manager.setGlobalTodos(GlobalSyncMode.GitHub, todos, "global/todos.json");

		// Retrieve cache directly from storage
		const cache = await manager.getGlobalGistCache("global/todos.json");

		assert.ok(cache);
		assert.strictEqual(cache.isDirty, true);
		assert.strictEqual(cache.data.userTodos.length, 1);
		assert.strictEqual(cache.data.userTodos[0].text, "Test todo");
	});

	test("Empty data handling", async () => {
		const emptyTodos: Todo[] = [];

		await manager.setGlobalTodos(GlobalSyncMode.Local, emptyTodos);
		const retrieved = await manager.getGlobalTodos(GlobalSyncMode.Local);

		assert.strictEqual(Array.isArray(retrieved), true);
		assert.strictEqual(retrieved.length, 0);
	});
});
