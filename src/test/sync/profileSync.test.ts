/**
 * Profile Sync mode syncs the user list through VS Code Settings Sync, which carries only
 * `globalState.TodoData`. `globalData.json` is this machine's own copy. At activation the file
 * used to win and be written over `TodoData`, so a machine that had been closed while another one
 * changed the list uploaded its older copy, and the change was lost on both. Nothing reloaded the
 * list when Settings Sync changed `TodoData` mid-session either, so the next edit did the same.
 *
 * These run the real `StorageSyncManager` over a real `globalData.json` and a store whose
 * subscriber persists each slice change, as the extension's does.
 */

import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import StorageSyncManager from "../../storage/StorageSyncManager";
import { SyncCommands } from "../../sync/SyncCommands";
import createStore, { actionTrackerActions, userActions } from "../../todo/store";
import { Slices, StoreState, Todo, TodoScope } from "../../todo/todoTypes";
import { RATING_PROMPT_SHOWN_KEY } from "../../ratingPrompt/RatingPrompt";

function todo(id: number, text: string): Todo {
	return {
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	};
}

function texts(todos: unknown): string[] | undefined {
	return (todos as Todo[] | undefined)?.map((t) => t.text);
}

/**
 * VS Code's memento semantics that matter here: `update` stores a copy, and `get` returns that
 * stored object until the value is replaced, as Settings Sync and other windows do.
 */
function memento(map: Map<string, unknown>, keysForSync: string[][]) {
	return {
		get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
		update: async (key: string, value: unknown) => {
			map.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
		},
		keys: () => [...map.keys()],
		setKeysForSync: (keys: readonly string[]) => {
			keysForSync.push([...keys]);
		},
	};
}

function removeDir(dir: string): void {
	// Windows can hold the directory for a moment after the watchers go. A leftover temp
	// directory is harmless; an error here would hide the test's own failure.
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	} catch {
		// Left for the OS to clean up.
	}
}

/** Runs a user sync mode switch as the command does, with no GitHub behind it. */
function selectUserSyncMode(
	context: vscode.ExtensionContext,
	store: EnhancedStore<StoreState>,
	storage: StorageSyncManager,
	mode: string
): Promise<void> {
	const syncManager = {
		stopPolling: () => undefined,
		cancelPendingSync: () => undefined,
		resetStatus: () => undefined,
		getStatus: () => "idle",
	};
	const commands = new SyncCommands(
		context,
		{} as never,
		{} as never,
		syncManager as never,
		store,
		storage
	);
	return (
		commands as unknown as { selectUserSyncMode(mode: string): Promise<void> }
	).selectUserSyncMode(mode);
}

type Harness = {
	store: EnhancedStore<StoreState>;
	storage: StorageSyncManager;
	context: vscode.ExtensionContext;
	globalStore: Map<string, unknown>;
	/** Every list passed to `setKeysForSync`, oldest first. */
	keysForSync: string[][];
	/** What `TodoData` holds. */
	synced(): string[] | undefined;
	/** What `globalData.json` holds. */
	onDisk(): string[] | undefined;
	writeFile(todos: Todo[]): void;
	/** The store's user list. */
	shown(): string[] | undefined;
	/** Waits for every persist so far. */
	settle(): Promise<void>;
	/** Runs the look for a changed `TodoData` that the timer and window focus run. */
	check(): Promise<void>;
	/** Runs the `globalData.json` watcher's handler, in the user write queue as the watcher does. */
	fileChanged(): Promise<void>;
	/** Waits for the user write queue to empty. */
	drain(): Promise<void>;
	selectMode(mode: string): Promise<void>;
	dispose(): void;
};

suite("Profile Sync: the synced user list", () => {
	const cleanups: Array<() => void> = [];

	teardown(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
	});

	/**
	 * A machine whose `globalData.json` holds `file` and whose `TodoData` holds `synced`, started
	 * as `activate` starts it. `beforeWatch` runs after the lists are read and before the watch
	 * starts, when Settings Sync or another window can still change them.
	 */
	async function machine(
		mode: string,
		file: Todo[] | undefined,
		synced: Todo[] | undefined,
		beforeWatch?: (globalStore: Map<string, unknown>) => void
	): Promise<Harness> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-todo-profile-sync-"));
		const globalDir = path.join(dir, "global");
		const dataFile = path.join(globalDir, "globalData.json");
		const writeFile = (todos: Todo[]) =>
			fs.writeFileSync(dataFile, JSON.stringify({ userTodos: todos }), "utf8");
		if (file) {
			fs.mkdirSync(globalDir, { recursive: true });
			writeFile(file);
		}
		const globalStore = new Map<string, unknown>([["syncMode", mode]]);
		if (synced) {
			globalStore.set("TodoData", synced);
		}
		const keysForSync: string[][] = [];
		const context = {
			globalState: memento(globalStore, keysForSync),
			workspaceState: memento(new Map([["syncMode", "local"]]), []),
			globalStorageUri: vscode.Uri.file(globalDir),
			storageUri: vscode.Uri.file(path.join(dir, "workspace")),
			subscriptions: [] as vscode.Disposable[],
		} as unknown as vscode.ExtensionContext;
		const dispose = () => {
			context.subscriptions.forEach((disposable) => disposable.dispose());
			removeDir(dir);
		};
		cleanups.push(dispose);
		const store = createStore();
		const storage = new StorageSyncManager(context, store);

		await storage.initialize();
		const loaded = await storage.getUserTodos();
		beforeWatch?.(globalStore);
		store.dispatch(userActions.loadData({ data: loaded }));
		store.dispatch(actionTrackerActions.resetLastSliceName());
		const persists: Promise<void>[] = [];
		store.subscribe(() => {
			const state = store.getState();
			const slice = state.actionTracker.lastSliceName;
			if (slice === Slices.unset || slice === Slices.actionTracker) {
				return;
			}
			store.dispatch(actionTrackerActions.resetLastSliceName());
			if (slice === Slices.user || slice === Slices.workspace || slice === Slices.currentFile) {
				persists.push(storage.persistSlice(state[slice]));
			}
		});
		storage.watchSyncedUserTodos();

		const internals = storage as unknown as {
			checkSyncedUserTodos(): Promise<void>;
			exclusive(storage: "user", work: () => Promise<void>): Promise<void>;
			handleGlobalFileChange(): Promise<void>;
		};
		const h: Harness = {
			store,
			storage,
			context,
			globalStore,
			keysForSync,
			synced: () => texts(globalStore.get("TodoData")),
			onDisk: () =>
				fs.existsSync(dataFile)
					? texts(JSON.parse(fs.readFileSync(dataFile, "utf8")).userTodos)
					: undefined,
			writeFile,
			shown: () => texts(store.getState().user.todos),
			settle: async () => {
				await Promise.all(persists);
			},
			check: () => internals.checkSyncedUserTodos(),
			fileChanged: () => internals.exclusive("user", () => internals.handleGlobalFileChange()),
			drain: () => internals.exclusive("user", async () => undefined),
			selectMode: (next: string) => selectUserSyncMode(context, store, storage, next),
			dispose,
		};
		return h;
	}

	const mine = todo(1, "mine");
	const theirs = todo(2, "theirs");

	test("at startup the synced list wins over this machine's older file", async () => {
		const h = await machine("profile-sync", [mine], [mine, theirs]);

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
		assert.deepStrictEqual(h.synced(), ["mine", "theirs"], "the old file was written over it");
		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs"]);
	});

	test("Local mode still loads this machine's file", async () => {
		const h = await machine("profile-local", [mine], [mine, theirs]);

		assert.deepStrictEqual(h.shown(), ["mine"]);
		assert.deepStrictEqual(h.synced(), ["mine"]);
	});

	for (const mode of ["profile-sync", "profile-local"]) {
		test(`${mode}: an unusable storage directory keeps the stored list, not an empty one`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-todo-profile-sync-"));
			// A file where a parent directory should be, so `createDirectory` fails.
			const blocker = path.join(dir, "blocker");
			fs.writeFileSync(blocker, "", "utf8");
			const globalStore = new Map<string, unknown>([
				["syncMode", mode],
				["TodoData", [mine, theirs]],
			]);
			const context = {
				globalState: memento(globalStore, []),
				workspaceState: memento(new Map([["syncMode", "local"]]), []),
				globalStorageUri: vscode.Uri.file(path.join(blocker, "global")),
				subscriptions: [] as vscode.Disposable[],
			} as unknown as vscode.ExtensionContext;
			const store = createStore();
			const storage = new StorageSyncManager(context, store);
			try {
				await storage.initialize();
				assert.deepStrictEqual(texts(await storage.getUserTodos()), ["mine", "theirs"]);

				// The file cannot be written, and the edit must still be what a reload shows.
				await storage.persistSlice({
					todos: [mine, theirs, todo(3, "added here")],
					lastActionType: "user/addTodo",
					numberOfTodos: 3,
					numberOfNotes: 0,
					scope: TodoScope.user,
				});
				const edited = ["mine", "theirs", "added here"];
				assert.deepStrictEqual(texts(await storage.getUserTodos()), edited);

				// Choosing Profile Sync now must not upload an empty list.
				await selectUserSyncMode(context, store, storage, "profile-sync");

				assert.deepStrictEqual(texts(globalStore.get("TodoData")), edited);
				assert.deepStrictEqual(texts(store.getState().user.todos), edited);
			} finally {
				context.subscriptions.forEach((disposable) => disposable.dispose());
				removeDir(dir);
			}
		});
	}

	test("a list Settings Sync delivers mid-session is loaded, and the next edit keeps it", async () => {
		const h = await machine("profile-sync", [mine], [mine]);

		// Settings Sync replaces the value with a new object.
		h.globalStore.set("TodoData", [mine, theirs]);
		await h.check();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);

		h.store.dispatch(userActions.addTodo({ text: "added here", position: "bottom" }));
		await h.settle();

		assert.deepStrictEqual(
			h.synced(),
			["mine", "theirs", "added here"],
			"the edit was made over the older list and uploaded it"
		);
		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs", "added here"]);
	});

	test("a list delivered while the store was being loaded is picked up once it is", async () => {
		const h = await machine("profile-sync", [mine], [mine], (globalStore) =>
			globalStore.set("TodoData", [mine, theirs])
		);
		// Only the look made when the watch starts has run.
		await h.drain();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
		h.store.dispatch(userActions.addTodo({ text: "added here", position: "bottom" }));
		await h.settle();
		assert.deepStrictEqual(h.synced(), ["mine", "theirs", "added here"], "the edit was dropped");
	});

	test("a delivered list does not replace an edit still waiting to be stored", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		h.store.dispatch(userActions.addTodo({ text: "first", position: "bottom" }));
		await h.settle();

		// Delivered, and looked for, just before the next edit: its persist queues behind the look.
		h.globalStore.set("TodoData", [mine, theirs]);
		const look = h.check();
		h.store.dispatch(userActions.addTodo({ text: "second", position: "bottom" }));
		await look;
		await h.settle();
		await h.check();

		assert.deepStrictEqual(h.synced(), ["mine", "first", "second"]);
		assert.deepStrictEqual(h.shown(), h.synced(), "the screen and the stored list differ");
	});

	test("an edit that was never stored does not stop delivered lists from loading", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		// A reload whose suppression was not used up skips the next persist.
		h.storage.suppressNextPersistForScope(TodoScope.user);
		h.store.dispatch(userActions.addTodo({ text: "not stored", position: "bottom" }));
		await h.settle();

		h.globalStore.set("TodoData", [mine, theirs]);
		await h.check();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
	});

	test("another window taking the mode out of Profile Sync does not strand its last edit", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		// The other window's edit reaches this window's file watcher while it is in Profile Sync.
		h.writeFile([mine, theirs]);
		await h.fileChanged();
		// Then its memento change, with the mode that window switched to straight after.
		h.globalStore.set("TodoData", [mine, theirs]);
		h.globalStore.set("syncMode", "profile-local");
		await h.check();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
		h.store.dispatch(userActions.addTodo({ text: "added here", position: "bottom" }));
		await h.settle();
		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs", "added here"]);
	});

	test("leaving Profile Sync keeps a loaded list the file does not have yet", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		h.globalStore.set("TodoData", [mine, theirs]);
		await h.check();
		assert.deepStrictEqual(h.onDisk(), ["mine"], "the file is written only by a persist");

		// A look lands between the mode's write and this window's own handling of it.
		h.globalStore.set("syncMode", "profile-local");
		await h.check();
		await h.storage.userSyncModeChanged("profile-sync");

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
		assert.deepStrictEqual(h.synced(), ["mine", "theirs"]);
		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs"]);
	});

	test("an edit waiting to be stored when Profile Sync is left is not reloaded over", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		h.globalStore.set("TodoData", [mine, theirs]);
		h.globalStore.set("syncMode", "profile-local");

		// The edit's persist queues behind the look.
		const look = h.check();
		h.store.dispatch(userActions.addTodo({ text: "added here", position: "bottom" }));
		await look;
		await h.settle();

		assert.deepStrictEqual(h.synced(), ["mine", "added here"]);
		assert.deepStrictEqual(h.shown(), h.synced(), "the screen and the stored list differ");
	});

	test("leaving Profile Sync does not write an older list over another window's newer file", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		// The other window switched to Local and edited; its file write arrived, its TodoData not.
		h.globalStore.set("syncMode", "profile-local");
		h.writeFile([mine, todo(3, "edited after the switch")]);

		await h.check();

		assert.deepStrictEqual(h.onDisk(), ["mine", "edited after the switch"]);
	});

	test("switching out of Local does not write this window's older list over the file", async () => {
		const h = await machine("profile-local", [mine], [mine]);
		// Another window's Local edit: its file write has arrived, its TodoData not yet.
		h.writeFile([mine, theirs]);

		await h.selectMode("profile-sync");

		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs"]);
	});

	test("a mode left before the first look is still noticed", async () => {
		const h = await machine("profile-sync", [mine], [mine], (globalStore) => {
			globalStore.set("TodoData", [mine, theirs]);
			globalStore.set("syncMode", "profile-local");
		});
		// Only the look made when the watch starts has run.
		await h.drain();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
	});

	test("a mode back in Profile Sync after leaving it still shows the taken list", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		h.globalStore.set("TodoData", [mine, theirs]);
		h.globalStore.set("syncMode", "profile-local");

		await h.check();
		// The other window switches back.
		h.globalStore.set("syncMode", "profile-sync");
		await h.check();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
		h.store.dispatch(userActions.addTodo({ text: "added here", position: "bottom" }));
		await h.settle();
		assert.deepStrictEqual(
			h.synced(),
			["mine", "theirs", "added here"],
			"the other edit was dropped"
		);
	});

	test("another window switching to GitHub does not put the profile's list in the store", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		h.globalStore.set("TodoData", [mine, theirs]);
		h.globalStore.set("syncMode", "github");
		let loads = 0;
		const dispatch = h.store.dispatch;
		h.store.dispatch = ((action: { type: string }) => {
			if (action.type === "user/loadData") {
				loads++;
			}
			return dispatch(action);
		}) as typeof h.store.dispatch;

		await h.check();

		assert.strictEqual(loads, 0);
	});

	test("this window's own writes are not reloaded", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		h.store.dispatch(userActions.addTodo({ text: "added here", position: "bottom" }));
		await h.settle();
		let loads = 0;
		const dispatch = h.store.dispatch;
		h.store.dispatch = ((action: { type: string }) => {
			if (action.type === "user/loadData") {
				loads++;
			}
			return dispatch(action);
		}) as typeof h.store.dispatch;

		// The memento holds a copy of what was written, so this compares the content.
		await h.check();

		assert.strictEqual(loads, 0);
		h.store.dispatch(userActions.addTodo({ text: "and another", position: "bottom" }));
		await h.settle();
		assert.deepStrictEqual(h.synced(), ["mine", "added here", "and another"]);
	});

	test("an older file written by another window cannot roll back the synced list", async () => {
		const h = await machine("profile-sync", [mine], [mine, theirs]);

		h.writeFile([mine]);
		await h.fileChanged();

		assert.deepStrictEqual(h.synced(), ["mine", "theirs"]);
		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
	});

	test("a newer file from another window is not rewritten before its TodoData arrives", async () => {
		const h = await machine("profile-sync", [mine], [mine]);

		// The other window's file write reaches this window before its memento change.
		h.writeFile([mine, theirs]);
		await h.fileChanged();

		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs"], "the newer file was rolled back");

		h.globalStore.set("TodoData", [mine, theirs]);
		await h.check();

		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
	});

	test("GitHub mode leaves the profile's own list in TodoData", async () => {
		const h = await machine("profile-local", [mine], [mine]);
		h.globalStore.set("syncMode", "github");

		await h.storage.persistSlice({
			todos: [todo(7, "from the gist")],
			lastActionType: "user/addTodo",
			numberOfTodos: 1,
			numberOfNotes: 0,
			scope: TodoScope.user,
		});

		assert.deepStrictEqual(h.synced(), ["mine"]);
	});

	test("choosing Profile Sync registers the list with Settings Sync at once", async () => {
		const h = await machine("profile-local", [mine], [mine]);
		assert.deepStrictEqual(
			h.keysForSync[h.keysForSync.length - 1],
			[RATING_PROMPT_SHOWN_KEY],
			"Local mode synced it"
		);

		await h.selectMode("profile-sync");

		assert.deepStrictEqual(h.keysForSync[h.keysForSync.length - 1], [
			"TodoData",
			RATING_PROMPT_SHOWN_KEY,
		]);
		assert.deepStrictEqual(h.shown(), ["mine"]);
	});

	test("leaving Profile Sync unregisters the list and keeps one delivered since the last look", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		assert.deepStrictEqual(h.keysForSync[h.keysForSync.length - 1], [
			"TodoData",
			RATING_PROMPT_SHOWN_KEY,
		]);
		h.globalStore.set("TodoData", [mine, theirs]);

		await h.selectMode("profile-local");

		assert.deepStrictEqual(h.keysForSync[h.keysForSync.length - 1], [RATING_PROMPT_SHOWN_KEY]);
		assert.deepStrictEqual(h.shown(), ["mine", "theirs"]);
		assert.deepStrictEqual(h.onDisk(), ["mine", "theirs"], "Local mode would load the old file");
	});

	test("disconnecting GitHub leaves a user scope in Profile Sync there", async () => {
		const h = await machine("profile-sync", [mine], [mine]);
		const commands = new SyncCommands(
			h.context,
			{ disconnect: async () => undefined } as never,
			{} as never,
			{
				stopPolling: () => undefined,
				cancelPendingSync: () => undefined,
				resetStatus: () => undefined,
				getStatus: () => "idle",
			} as never,
			h.store,
			h.storage
		);
		const confirm = vscode.window.showWarningMessage;
		(vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => "Disconnect";
		try {
			await (commands as unknown as { disconnectGitHub(): Promise<void> }).disconnectGitHub();
		} finally {
			(vscode.window as { showWarningMessage: unknown }).showWarningMessage = confirm;
		}

		assert.strictEqual(h.globalStore.get("syncMode"), "profile-sync");
		assert.deepStrictEqual(h.keysForSync[h.keysForSync.length - 1], [
			"TodoData",
			RATING_PROMPT_SHOWN_KEY,
		]);
	});
});
