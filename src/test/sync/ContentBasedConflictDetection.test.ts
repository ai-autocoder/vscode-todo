/**
 * Unit tests for Content-Based Conflict Detection
 * Tests the three-way merge approach using lastCleanRemoteData
 */

import * as assert from "assert";
import { isEqual } from "../../todo/todoUtils";
import { Todo } from "../../todo/todoTypes";
import { GlobalGistData, WorkspaceGistData, GistCache } from "../../sync/syncTypes";

suite("Content-Based Conflict Detection Test Suite", () => {
	// Helper function to create a sample todo
	const createTodo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: new Date().toISOString(),
		isMarkdown: false,
		isNote: false,
	});

	test("No conflict: Remote changed, local clean", () => {
		const remoteData: GlobalGistData = {
			userTodos: [createTodo(1, "Remote change")],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [createTodo(1, "Old data")],
			},
			lastCleanRemoteData: {
				userTodos: [createTodo(1, "Old data")],
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};

		// Detect remote changes
		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		const hasLocalChanges = cache.isDirty;

		assert.strictEqual(hasRemoteChanges, true, "Should detect remote changes");
		assert.strictEqual(hasLocalChanges, false, "Local should be clean");

		// Decision: Download from remote
		const shouldDownload = hasRemoteChanges && !hasLocalChanges;
		assert.strictEqual(shouldDownload, true, "Should download remote changes");
	});

	test("No conflict: Local changed, remote unchanged", () => {
		const remoteData: GlobalGistData = {
			userTodos: [createTodo(1, "Old data")],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [createTodo(1, "Local change")],
			},
			lastCleanRemoteData: {
				userTodos: [createTodo(1, "Old data")],
			},
			lastSynced: new Date().toISOString(),
			isDirty: true,
		};

		// Detect changes
		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		const hasLocalChanges = cache.isDirty;

		assert.strictEqual(hasRemoteChanges, false, "Remote should be unchanged");
		assert.strictEqual(hasLocalChanges, true, "Should detect local changes");

		// Decision: Upload to remote
		const shouldUpload = hasLocalChanges && !hasRemoteChanges;
		assert.strictEqual(shouldUpload, true, "Should upload local changes");
	});

	test("TRUE CONFLICT: Both remote and local changed", () => {
		const remoteData: GlobalGistData = {
			userTodos: [createTodo(1, "Remote change")],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [createTodo(1, "Local change")],
			},
			lastCleanRemoteData: {
				userTodos: [createTodo(1, "Old data")],
			},
			lastSynced: new Date().toISOString(),
			isDirty: true,
		};

		// Detect conflict
		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		const hasLocalChanges = cache.isDirty;
		const hasConflict = hasRemoteChanges && hasLocalChanges;

		assert.strictEqual(hasRemoteChanges, true, "Should detect remote changes");
		assert.strictEqual(hasLocalChanges, true, "Should detect local changes");
		assert.strictEqual(hasConflict, true, "Should detect TRUE CONFLICT");
	});

	test("No changes: Both in sync", () => {
		const remoteData: GlobalGistData = {
			userTodos: [createTodo(1, "Same data")],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [createTodo(1, "Same data")],
			},
			lastCleanRemoteData: {
				userTodos: [createTodo(1, "Same data")],
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};

		// Check for changes
		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		const hasLocalChanges = cache.isDirty;

		assert.strictEqual(hasRemoteChanges, false, "Remote should be unchanged");
		assert.strictEqual(hasLocalChanges, false, "Local should be clean");

		// Decision: Already synced
		const alreadySynced = !hasRemoteChanges && !hasLocalChanges;
		assert.strictEqual(alreadySynced, true, "Should be already synced");
	});

	test("Backwards compatibility: Missing lastCleanRemoteData", () => {
		const remoteData: GlobalGistData = {
			userTodos: [createTodo(1, "Remote data")],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [createTodo(1, "Local data")],
			},
			// lastCleanRemoteData is undefined (old cache format)
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};

		// Fallback comparison: remote vs current cache data
		let hasRemoteChanges: boolean;
		if (cache.lastCleanRemoteData) {
			hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		} else {
			// Backwards compatibility fallback
			hasRemoteChanges = !isEqual(remoteData.userTodos, cache.data.userTodos);
		}

		assert.strictEqual(hasRemoteChanges, true, "Should detect changes using fallback");
		assert.strictEqual(cache.isDirty, false, "Local is clean");

		// Should download to update cache with lastCleanRemoteData
		const shouldDownload = hasRemoteChanges && !cache.isDirty;
		assert.strictEqual(shouldDownload, true, "Should download to populate lastCleanRemoteData");
	});

	test("Workspace scope: Multiple data types (todos + files)", () => {
		const remoteData: WorkspaceGistData = {
			workspaceTodos: [createTodo(1, "Remote workspace todo")],
			filesData: {
				"src/main.ts": [createTodo(2, "Remote file todo")],
			},
		};

		const cache: GistCache<WorkspaceGistData> = {
			data: {
				workspaceTodos: [createTodo(1, "Local workspace todo")],
				filesData: {
					"src/main.ts": [createTodo(2, "Local file todo")],
				},
			},
			lastCleanRemoteData: {
				workspaceTodos: [createTodo(1, "Old workspace todo")],
				filesData: {
					"src/main.ts": [createTodo(2, "Old file todo")],
				},
			},
			lastSynced: new Date().toISOString(),
			isDirty: true,
		};

		// Check both workspaceTodos and filesData for changes
		const workspaceTodosChanged = !isEqual(
			remoteData.workspaceTodos,
			cache.lastCleanRemoteData!.workspaceTodos
		);
		const filesDataChanged = !isEqual(remoteData.filesData, cache.lastCleanRemoteData!.filesData);
		const hasRemoteChanges = workspaceTodosChanged || filesDataChanged;

		assert.strictEqual(workspaceTodosChanged, true, "Should detect workspace todos change");
		assert.strictEqual(filesDataChanged, true, "Should detect files data change");
		assert.strictEqual(hasRemoteChanges, true, "Should detect overall remote changes");
		assert.strictEqual(cache.isDirty, true, "Local has changes");

		// TRUE CONFLICT
		const hasConflict = hasRemoteChanges && cache.isDirty;
		assert.strictEqual(hasConflict, true, "Should detect conflict in workspace scope");
	});

	test("Empty data handling", () => {
		const remoteData: GlobalGistData = {
			userTodos: [],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [],
			},
			lastCleanRemoteData: {
				userTodos: [],
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};

		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		assert.strictEqual(hasRemoteChanges, false, "Empty arrays should be equal");
	});

	test("Array order sensitivity", () => {
		const todo1 = createTodo(1, "First");
		const todo2 = createTodo(2, "Second");

		const remoteData: GlobalGistData = {
			userTodos: [todo1, todo2],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [todo2, todo1], // Different order
			},
			lastCleanRemoteData: {
				userTodos: [todo1, todo2],
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};

		// isEqual should detect order differences
		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		assert.strictEqual(hasRemoteChanges, false, "Order is same as lastClean");

		const hasLocalChanges = !isEqual(cache.data.userTodos, cache.lastCleanRemoteData!.userTodos);
		assert.strictEqual(hasLocalChanges, true, "Local order differs from lastClean");
	});

	test("Deep property changes detection", () => {
		const remoteData: GlobalGistData = {
			userTodos: [
				{
					...createTodo(1, "Test"),
					completed: true, // Changed
				},
			],
		};

		const cache: GistCache<GlobalGistData> = {
			data: {
				userTodos: [createTodo(1, "Test")],
			},
			lastCleanRemoteData: {
				userTodos: [createTodo(1, "Test")],
			},
			lastSynced: new Date().toISOString(),
			isDirty: false,
		};

		const hasRemoteChanges = !isEqual(remoteData.userTodos, cache.lastCleanRemoteData!.userTodos);
		assert.strictEqual(hasRemoteChanges, true, "Should detect deep property changes");
	});

	test("Null vs empty array handling", () => {
		// Ensure the system handles potentially invalid data gracefully
		const emptyArray: Todo[] = [];
		const hasChanges = !isEqual(emptyArray, []);

		assert.strictEqual(hasChanges, false, "Empty arrays should be equal");
	});

	test("File not found scenario: Empty cache created", () => {
		// Simulating the scenario when remote file doesn't exist
		// SyncManager should create an empty cache with isDirty=true

		const emptyData: GlobalGistData = {
			userTodos: [],
		};

		const newCache: GistCache<GlobalGistData> = {
			data: emptyData,
			lastCleanRemoteData: emptyData,
			lastSynced: new Date().toISOString(),
			isDirty: true, // Will trigger upload to create file
		};

		assert.strictEqual(newCache.data.userTodos.length, 0, "Should have empty todos");
		assert.strictEqual(newCache.isDirty, true, "Should be marked dirty to trigger upload");
		assert.ok(newCache.lastCleanRemoteData, "Should have lastCleanRemoteData");
		assert.strictEqual(
			newCache.lastCleanRemoteData.userTodos.length,
			0,
			"lastCleanRemoteData should be empty"
		);
	});
});
