/**
 * `SyncManager` against a peer that pushes at the same time.
 *
 * This is the regression suite for the bug that made editing the same list on two devices
 * unreliable. The extension used to PATCH the gist blind: it read the file, merged, and wrote,
 * with no check that the remote had not moved in between. A push from the PWA landing inside
 * that window was overwritten wholesale — and because the extension then recorded its own
 * result as `lastCleanRemoteData`, the next reconcile saw remote == baseline and never pulled the
 * lost change back. Silent, permanent loss of an edit the user had made on the other device.
 *
 * The shared engine writes through `pushVerified` (re-read, re-merge, retry). These tests drive
 * the real `SyncManager` over a fake gist so the wiring is covered too, not just the engine:
 * the cache-store adapter, the local snapshot, the write-back, and showing the result in the
 * store. Where the store matters they run the real store and `StorageSyncManager`, with a
 * subscriber that persists each slice change the way the extension's `store.subscribe` does.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { SyncManager } from "../../sync/SyncManager";
import { SyncStorageManager } from "../../sync/SyncStorageManager";
import { GitHubAuthManager } from "../../sync/GitHubAuthManager";
import {
	GistCache,
	GlobalSyncMode,
	StorageKeys,
	SyncStatus,
	WorkspaceGistData,
} from "../../sync/syncTypes";
import StorageSyncManager from "../../storage/StorageSyncManager";
import { currentFileActions, userActions, workspaceActions } from "../../todo/store";
import { serialize } from "../../core";
import { Todo, TodoFilesData } from "../../todo/todoTypes";
import { StoreHarness, storeHarness } from "./storeHarness";

const GIST_ID = "a".repeat(32);
const FILE = "user-todos.json";
const FILE_PATH = process.platform === "win32" ? "C:\\work\\repo\\a.ts" : "/work/repo/a.ts";

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

/** An in-memory gist file, with a hook to let a peer write between our read and our write. */
class FakeGistFile {
	public reads = 0;
	public writes: string[] = [];
	/** Runs after each read, so a test can simulate the other device pushing mid-flight. */
	public onRead: ((reads: number) => void) | undefined;

	constructor(public content: string | undefined) {}

	async readFile(_gistId: string, _fileName: string) {
		this.reads++;
		const snapshot = this.content;
		this.onRead?.(this.reads);
		if (snapshot === undefined) {
			return {
				success: false as const,
				error: { type: "file-not-found", message: "", timestamp: "", retryable: false },
			};
		}
		return { success: true as const, data: snapshot };
	}

	async writeFile(_gistId: string, _fileName: string, content: string) {
		this.writes.push(content);
		this.content = content;
		return { success: true as const, data: {} };
	}

	get todos(): Todo[] {
		return JSON.parse(this.content!).userTodos;
	}
}

/**
 * A memento with VS Code's semantics that matter here: `get` returns the stored object itself,
 * not a copy, so an in-place mutation of what comes back really does change storage.
 *
 * `afterUpdate` lets a test interleave something immediately after a specific write — the only
 * way to land an edit between the engine's cache write and the manager's read-back, which is a
 * window no fake of the network layer can reach.
 */
function memento(
	map: Map<string, unknown>,
	afterUpdate?: (key: string, writeCount: number) => Promise<void> | void
) {
	let writes = 0;
	return {
		get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
		update: async (key: string, value: unknown) => {
			map.set(key, value);
			await afterUpdate?.(key, ++writes);
		},
	};
}

/** The file name `SyncManager` derives for the workspace scope in this test instance. */
function workspaceFileName(): string {
	const configured = vscode.workspace
		.getConfiguration("vscodeTodo.sync")
		.get<string>("github.workspaceFile");
	return configured || `workspace-${vscode.workspace.name || "default"}.json`;
}

function texts(todos: Todo[] | undefined): string[] {
	return (todos ?? []).map((t) => t.text).sort();
}

suite("SyncManager concurrency", () => {
	let globalStore: Map<string, unknown>;
	let manager: SyncManager;
	let gist: FakeGistFile;
	let context: never;
	/** Set by a test to interleave work immediately after a memento write. See `memento`. */
	let afterCacheWrite: ((key: string, writes: number) => Promise<void> | void) | undefined;
	/** The store, for a test set up with one; see `setUpWithStore`. */
	let harness: StoreHarness;

	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance =
			undefined;
	}

	/**
	 * A manager whose gist is `gist` and whose cache says: the baseline is `base`, and local holds
	 * `local` — i.e. this device has an unpushed edit, which is the state that makes a reconcile
	 * write rather than merely pull.
	 */
	function setUp(remote: Todo[], base: Todo[], local: Todo[]): void {
		setUpManager(remote, base, local, () => undefined);
	}

	/**
	 * {@link setUp} with a store the manager shows its results in, showing `shown`: what activation
	 * loaded from the cache, unless a test says otherwise.
	 */
	function setUpWithStore(remote: Todo[], base: Todo[], local: Todo[], shown = local): void {
		setUpManager(remote, base, local, (ctx) => {
			harness = storeHarness(ctx, (store) => store.dispatch(userActions.loadData({ data: shown })));
			return harness.storage;
		});
	}

	function setUpManager(
		remote: Todo[],
		base: Todo[],
		local: Todo[],
		storeFor: (context: never) => StorageSyncManager | undefined
	): void {
		resetAuthSingleton();
		globalStore = new Map<string, unknown>([
			["syncMode", "github"],
			[
				StorageKeys.globalGistCache(FILE),
				{
					data: { userTodos: local },
					lastCleanRemoteData: { userTodos: base },
					lastSynced: "2026-01-01T00:00:00.000Z",
					isDirty: true,
				},
			],
		]);
		gist = new FakeGistFile(serialize({ userTodos: remote }));

		afterCacheWrite = undefined;
		context = {
			globalState: memento(globalStore, (key, writes) => afterCacheWrite?.(key, writes)),
			workspaceState: memento(new Map([["syncMode", "local"]])),
			secrets: { get: () => Promise.resolve("token") },
		} as never;
		manager = new SyncManager(context, storeFor(context));
		// The real client is built in the constructor from the context; swapping it keeps every
		// other code path (cache store, snapshot, write-back, store) exactly as it ships.
		(manager as unknown as { apiClient: unknown }).apiClient = gist;
	}

	/**
	 * Records a local edit through the REAL storage path, exactly as `persistSlice` does.
	 *
	 * Tests must not hand-roll this. `SyncStorageManager.setGlobalTodos` used to mutate the
	 * cached object *in place* (`cache.data.userTodos = todos`) on the object a memento's `get`
	 * returns — which is the stored object itself, not a copy. It works on copies now, but a test
	 * that writes a fresh `{...cache, data}` object of its own would sidestep whatever the real
	 * path does, and a whole class of aliasing bug with it: the first version of this suite did
	 * exactly that and passed against code that deleted the user's next edit on every sync.
	 */
	async function editLocally(todos: Todo[]): Promise<void> {
		await new SyncStorageManager(context).setGlobalTodos(GlobalSyncMode.GitHub, todos, FILE);
	}

	function runUserSync(): Promise<{ success: boolean }> {
		return (
			manager as unknown as { syncUser(gistId: string): Promise<{ success: boolean }> }
		).syncUser(GIST_ID);
	}

	function cachedTodos(): Todo[] {
		const cache = globalStore.get(StorageKeys.globalGistCache(FILE)) as {
			data: { userTodos: Todo[] };
		};
		return cache.data.userTodos;
	}

	teardown(() => {
		manager.dispose();
		resetAuthSingleton();
	});

	/**
	 * The plainest possible sequence — one device, no peer, no concurrency: sync, edit, sync.
	 * The edit must reach the gist.
	 *
	 * This is the regression test for an aliasing bug that survived the whole first pass of this
	 * suite. Every engine success path called `saveCache(key, X, X)`, passing one object as both
	 * `data` and `lastCleanRemoteData` — the reconciled result IS the new baseline. A cache store
	 * that persists by reference therefore stored them as a single object, and VS Code mementos
	 * hand the stored object straight back. `setGlobalTodos` then recorded the user's edit with
	 * an in-place `cache.data.userTodos = todos`, which moved the merge baseline with it.
	 *
	 * The next reconcile then saw local === base ("nothing to push") and remote !== base ("they
	 * changed it"), pulled, and deleted the edit — reporting Synced. The extension's old,
	 * hand-rolled sync had a `cloneData()` call that prevented this; consolidating onto the
	 * shared engine dropped it.
	 */
	test("a local edit made after a sync survives the next sync", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one")]);

		// 1. A sync with nothing to do, which still rewrites the cache.
		await runUserSync();
		assert.deepStrictEqual(gist.writes, [], "nothing to push yet");

		// 2. The user adds a todo, through the real storage path.
		await editLocally([todo(1, "one"), todo(2, "buy milk")]);

		// 3. The debounced sync that edit armed.
		const result = await runUserSync();

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(
			gist.todos.map((t) => t.text),
			["one", "buy milk"],
			"the edit must reach the gist"
		);
		assert.deepStrictEqual(
			cachedTodos().map((t) => t.text),
			["one", "buy milk"],
			"and must still be in local storage"
		);
	});

	/**
	 * The mechanism behind the test above, pinned directly: a stored cache must never hold one
	 * object for both fields, or an in-place edit of `data` moves the baseline too.
	 */
	test("the stored cache keeps data and the baseline as separate objects", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one")]);

		await runUserSync();

		const cache = globalStore.get(StorageKeys.globalGistCache(FILE)) as {
			data: unknown;
			lastCleanRemoteData: unknown;
		};
		assert.notStrictEqual(cache.data, cache.lastCleanRemoteData, "must not be the same object");

		await editLocally([todo(1, "one"), todo(2, "buy milk")]);

		const after = globalStore.get(StorageKeys.globalGistCache(FILE)) as {
			lastCleanRemoteData: { userTodos: Todo[] };
		};
		assert.deepStrictEqual(
			after.lastCleanRemoteData.userTodos.map((t) => t.id),
			[1],
			"a local edit must not move the merge baseline"
		);
	});

	test("pushes a local edit when the remote has not moved", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);

		const result = await runUserSync();

		assert.strictEqual(result.success, true);
		assert.strictEqual(gist.todos[0].text, "one, edited here");
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Synced);
	});

	/**
	 * The headline regression. Both devices hold the same baseline; this one edits todo 1 and the
	 * peer adds todo 2 during our round trip. Neither change may be lost.
	 */
	test("merges a peer's push that lands inside the read-write window", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				// The PWA pushes right after we read, before we write.
				gist.content = serialize({ userTodos: [todo(1, "one"), todo(2, "added on the phone")] });
			}
		};

		const result = await runUserSync();

		assert.strictEqual(result.success, true);
		const byId = new Map(gist.todos.map((t) => [t.id, t.text]));
		assert.strictEqual(byId.get(1), "one, edited here", "our edit must survive");
		assert.strictEqual(
			byId.get(2),
			"added on the phone",
			"the peer's addition must survive — this is the silent overwrite"
		);
	});

	test("the merged result is written back to local storage and shown", async () => {
		setUpWithStore([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				gist.content = serialize({ userTodos: [todo(1, "one"), todo(2, "added on the phone")] });
			}
		};

		await runUserSync();
		await harness.settle();

		// Without this the peer's todo reaches the gist but never the UI, and the next reconcile
		// reads its absence from local as a deletion and pushes it away again.
		assert.deepStrictEqual(
			cachedTodos().map((t) => t.id).sort(),
			[1, 2],
			"local storage holds both"
		);
		assert.deepStrictEqual(
			harness.store.getState().user.todos.map((t) => t.id).sort(),
			[1, 2],
			"and so does the store"
		);
		assert.deepStrictEqual(harness.loads, ["user"], "the store is loaded exactly once");
	});

	test("a sync that changes nothing leaves the store alone", async () => {
		setUpWithStore([todo(1, "one")], [todo(1, "one")], [todo(1, "one")]);

		await runUserSync();

		assert.deepStrictEqual(harness.loads, []);
	});

	/**
	 * An edit the *user* makes while the sync is on the network.
	 *
	 * The reconcile merged from a snapshot that predates it, and its own cache write then
	 * replaces the only copy of that edit the extension keeps — `cache.data`, which is where
	 * `persistSlice` puts it. Adopting the reconcile's result therefore drops the edit, and since
	 * the baseline has moved with it, the next pass reads the absence as a deletion and pushes it
	 * away. Both the user's edit and whatever the remote contributed have to survive.
	 */
	test("keeps an edit the user makes while the sync is in flight", async () => {
		// Local already holds an unpushed edit, so this reconcile writes — which is the only case
		// with a read→write window for anything to land inside.
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);
		let pendingEdit: Promise<void> = Promise.resolve();
		gist.onRead = (reads) => {
			if (reads === 1) {
				// The peer pushes...
				gist.content = serialize({
					userTodos: [todo(1, "one"), todo(2, "added on the phone")],
				});
				// ...and at the same moment the user adds a todo here. Through the real storage
				// path, so this is byte-for-byte what `persistSlice` does, in-place mutation and
				// all — see editLocally.
				pendingEdit = editLocally([todo(1, "one, edited here"), todo(3, "typed just now")]);
			}
		};

		const result = await runUserSync();
		await pendingEdit;

		assert.strictEqual(result.success, true);
		const local = new Map(cachedTodos().map((t) => [t.id, t.text]));
		assert.strictEqual(local.get(3), "typed just now", "the mid-flight edit must survive");
		assert.strictEqual(local.get(2), "added on the phone", "so must the peer's addition");
		assert.strictEqual(local.get(1), "one, edited here", "and the edit we set out to push");
		// Still owed to the gist, and a push has to be armed to deliver it.
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Dirty);
		assert.notStrictEqual(
			(manager as unknown as { globalDebounceTimer: unknown }).globalDebounceTimer,
			undefined,
			"a follow-up push must be scheduled"
		);
	});

	/**
	 * The other half of the mid-flight window: an edit whose storage write lands *after* the
	 * reconcile's own cache write rather than before it.
	 *
	 * `persistSlice` is fire-and-forget (`void` in handleTodoChange) and awaits a memento update
	 * of its own before touching the gist cache, so an edit dispatched during the sync can land
	 * on either side of it — pure timing. An edit that lands before is recovered from what the
	 * write displaced; one that lands after is only visible by re-reading the cache. Checking
	 * just the first half meant this one was silently overwritten by the write-back.
	 */
	test("keeps an edit whose storage write lands after the reconcile's", async () => {
		// A pure pull: local is clean and the peer added todo 2. The reconcile therefore writes
		// the pulled result into the cache, and that write is the moment we interleave the edit.
		setUp([todo(1, "one"), todo(2, "added on the phone")], [todo(1, "one")], [todo(1, "one")]);

		const cacheKey = StorageKeys.globalGistCache(FILE);
		let landed = false;
		afterCacheWrite = async (key) => {
			if (key !== cacheKey || landed) {
				return;
			}
			// Guard before awaiting: `editLocally` writes the same key, so without this the hook
			// would re-enter itself.
			landed = true;
			await editLocally([todo(1, "one"), todo(3, "typed just now")]);
		};

		await runUserSync();

		const local = new Map(cachedTodos().map((t) => [t.id, t.text]));
		assert.strictEqual(local.get(3), "typed just now", "the late edit must survive");
		assert.strictEqual(local.get(2), "added on the phone", "and so must the pulled change");
	});

	/**
	 * The last stretch of a sync that pulled something: the manager writes the merged list into
	 * the cache, `persistLocalUser` writes it again, and the store is loaded with the result. An
	 * add the user makes meanwhile persists the list the store still shows, which is the pre-sync
	 * list plus the add. The store used to be reloaded from the cache, and none of this waited for
	 * `StorageSyncManager`'s write queue. If the add's persist landed before `persistLocalUser`,
	 * the add was overwritten and the reload removed it from the screen. If it landed after, the
	 * cache kept the add but lost what was pulled, while the baseline said the gist had it, so the
	 * next sync pushed the pulled items away as deletions.
	 *
	 * The add goes through the real store and persist, since it is the store's stale list the
	 * persist carries.
	 */
	for (const [when, cacheWrite] of [
		["during the write-back", 2],
		["after the write-back, before the store reloads", 3],
	] as const) {
		test(`keeps an add the user makes ${when}`, async () => {
			// A pure pull. The cache key is written by the reconcile (1), the manager's write-back
			// (2) and persistLocalUser (3).
			setUpWithStore(
				[todo(1, "one"), todo(2, "added on the phone")],
				[todo(1, "one")],
				[todo(1, "one")]
			);

			const cacheKey = StorageKeys.globalGistCache(FILE);
			let cacheWrites = 0;
			afterCacheWrite = (key) => {
				if (key !== cacheKey || ++cacheWrites !== cacheWrite) {
					return;
				}
				harness.store.dispatch(userActions.addTodo({ text: "typed just now" }));
			};

			await runUserSync();
			await harness.settle();

			const expected = ["added on the phone", "one", "typed just now"];
			assert.deepStrictEqual(texts(cachedTodos()), expected, "the add and the pull are stored");
			assert.deepStrictEqual(texts(harness.store.getState().user.todos), expected, "and shown");
			const cache = globalStore.get(StorageKeys.globalGistCache(FILE)) as GistCache<{
				userTodos: Todo[];
			}>;
			assert.deepStrictEqual(
				texts(cache.lastCleanRemoteData?.userTodos),
				texts(gist.todos),
				"the baseline is what the gist holds"
			);
			assert.strictEqual(manager.getStatus("user"), SyncStatus.Dirty, "the add is owed");

			// The push the add armed: it must deliver the add and keep the pulled item.
			await runUserSync();
			assert.deepStrictEqual(texts(gist.todos), expected);
		});
	}

	/**
	 * Windows share the user gist cache, so it can hold another window's edit this store has not
	 * shown yet. Folding this store's edits in against the cache would read that edit as a
	 * deletion made here; the fold's base is what this store showed instead.
	 */
	test("does not read another window's edit as a deletion made here", async () => {
		// Another window added todo 2 and stored it; this window's store still shows [one]. The
		// phone added todo 3, so the sync both pushes and pulls.
		setUpWithStore(
			[todo(1, "one"), todo(3, "added on the phone")],
			[todo(1, "one")],
			[todo(1, "one"), todo(2, "from the other window")],
			[todo(1, "one")]
		);

		await runUserSync();
		await harness.settle();

		const expected = ["added on the phone", "from the other window", "one"];
		assert.deepStrictEqual(texts(gist.todos), expected, "the other window's edit is pushed");
		assert.deepStrictEqual(texts(cachedTodos()), expected, "and stays stored");
		assert.deepStrictEqual(
			texts(harness.store.getState().user.todos),
			expected,
			"and this store shows it"
		);
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Synced);

		await runUserSync();
		assert.deepStrictEqual(texts(gist.todos), expected, "the next sync deletes nothing");
	});

	/**
	 * A peer push that arrives when we have nothing of our own to send is a plain pull. It must
	 * not be treated as a local change and pushed back.
	 */
	test("pulls a peer's change when local is clean, without writing", async () => {
		const base = [todo(1, "one")];
		setUp([todo(1, "one"), todo(2, "added on the phone")], base, base);

		const result = await runUserSync();

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(gist.writes, [], "a pull must not write to the gist");
		assert.deepStrictEqual(cachedTodos().map((t) => t.id).sort(), [1, 2]);
	});

	/**
	 * The baseline is what makes a lost change recoverable. After a reconcile it must equal what
	 * was actually left on the gist — recording our own pre-merge state instead is what turned a
	 * clobber into permanent loss, because the next pass then saw remote == baseline.
	 */
	test("records what is really on the gist as the new baseline", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				gist.content = serialize({ userTodos: [todo(1, "one"), todo(2, "added on the phone")] });
			}
		};

		await runUserSync();

		const cache = globalStore.get(StorageKeys.globalGistCache(FILE)) as {
			lastCleanRemoteData: { userTodos: Todo[] };
		};
		assert.deepStrictEqual(
			cache.lastCleanRemoteData.userTodos.map((t) => t.id).sort(),
			gist.todos.map((t) => t.id).sort(),
			"baseline must match the gist, so a later divergence is detected"
		);
	});

	/**
	 * A cold cache carries no baseline, so a local/remote difference is not evidence of a local
	 * edit — it may just mean we have never pulled. Pushing there destroys remote data the user
	 * never touched, which is what made "switch device, open the app" lossy.
	 */
	test("bootstraps from the remote on a cold cache instead of pushing over it", async () => {
		resetAuthSingleton();
		globalStore = new Map<string, unknown>([["syncMode", "github"]]);
		gist = new FakeGistFile(serialize({ userTodos: [todo(1, "written elsewhere")] }));
		manager = new SyncManager({
			globalState: memento(globalStore),
			workspaceState: memento(new Map([["syncMode", "local"]])),
			secrets: { get: () => Promise.resolve("token") },
		} as never);
		(manager as unknown as { apiClient: unknown }).apiClient = gist;

		const result = await runUserSync();

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(gist.writes, [], "nothing may be written on a cold cache");
		assert.strictEqual(cachedTodos()[0].text, "written elsewhere", "remote adopted");
	});

	test("writes byte-identical content to what the PWA would write", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);

		await runUserSync();

		// Both peers serialize through the shared `serialize()`, so a push that changes nothing
		// cannot change the file — which is what stopped every PWA push from looking like a remote
		// change to the extension on the following poll.
		assert.strictEqual(gist.writes[0], serialize({ userTodos: [todo(1, "one, edited here")] }));
	});
});

/**
 * The workspace scope's half of the write-back race above, where the lag is wider: a workspace
 * persist writes the `TodoData` memento before the gist cache, and the open file's list is a
 * per-file change, which reaches the `TodoFilesData` memento at once and the cache in its turn.
 * The per-file list in the cache is also the only copy of an edit made to it.
 */
suite("SyncManager concurrency, workspace scope", () => {
	let workspaceStore: Map<string, unknown>;
	let manager: SyncManager;
	let gist: FakeGistFile;
	let harness: StoreHarness;
	let afterCacheWrite: ((key: string) => void) | undefined;
	let fileName: string;

	function workspace(todos: Todo[], fileTodos: Todo[]): WorkspaceGistData {
		return { workspaceTodos: todos, filesData: { [FILE_PATH]: fileTodos }, filesDataPaths: {} };
	}

	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance =
			undefined;
	}

	/** As the user suite's `setUpWithStore`, with the editor showing `FILE_PATH`. */
	function setUp(remote: WorkspaceGistData, base: WorkspaceGistData, local: WorkspaceGistData) {
		resetAuthSingleton();
		fileName = workspaceFileName();
		workspaceStore = new Map<string, unknown>([
			["syncMode", "github"],
			[
				StorageKeys.workspaceGistCache(fileName),
				{
					data: local,
					lastCleanRemoteData: base,
					lastSynced: "2026-01-01T00:00:00.000Z",
					isDirty: false,
				},
			],
			["TodoFilesData", local.filesData],
			["TodoFilesDataPaths", {}],
		]);
		gist = new FakeGistFile(serialize(remote));
		afterCacheWrite = undefined;
		const context = {
			globalState: memento(new Map([["syncMode", "profile-local"]])),
			workspaceState: memento(workspaceStore, (key) => afterCacheWrite?.(key)),
			secrets: { get: () => Promise.resolve("token") },
		} as never;
		harness = storeHarness(context, (store) => {
			store.dispatch(workspaceActions.loadData({ data: local.workspaceTodos }));
			store.dispatch(
				currentFileActions.loadData({ filePath: FILE_PATH, data: local.filesData[FILE_PATH] })
			);
		});
		manager = new SyncManager(context, harness.storage);
		(manager as unknown as { apiClient: unknown }).apiClient = gist;
	}

	function runWorkspaceSync(): Promise<{ success: boolean }> {
		return (
			manager as unknown as { syncWorkspace(gistId: string): Promise<{ success: boolean }> }
		).syncWorkspace(GIST_ID);
	}

	function cache(): GistCache<WorkspaceGistData> {
		return workspaceStore.get(
			StorageKeys.workspaceGistCache(fileName)
		) as GistCache<WorkspaceGistData>;
	}

	function onGist(): WorkspaceGistData {
		return JSON.parse(gist.content!) as WorkspaceGistData;
	}

	teardown(() => {
		manager.dispose();
		resetAuthSingleton();
	});

	test("a pull reaches the workspace slice, the per-file lists and the open file", async () => {
		setUp(
			workspace([todo(1, "one"), todo(2, "added on the phone")], [todo(10, "ten"), todo(11, "phone")]),
			workspace([todo(1, "one")], [todo(10, "ten")]),
			workspace([todo(1, "one")], [todo(10, "ten")])
		);

		await runWorkspaceSync();
		await harness.settle();

		const state = harness.store.getState();
		assert.deepStrictEqual(texts(state.workspace.todos), ["added on the phone", "one"]);
		assert.deepStrictEqual(texts(state.currentFile.todos), ["phone", "ten"]);
		const shownFiles = workspaceStore.get("TodoFilesData") as TodoFilesData;
		assert.deepStrictEqual(texts(shownFiles[FILE_PATH]), ["phone", "ten"]);
		assert.deepStrictEqual(gist.writes, [], "a pull writes nothing to the gist");
		assert.strictEqual(manager.getStatus("workspace"), SyncStatus.Synced);
	});

	/**
	 * A pure pull writes the cache key in the reconcile (1), the manager's write-back of the
	 * workspace list (2), the per-file lists (3) and their aliases (4), and persistLocalWorkspace
	 * (5). An add to the workspace list and one to the open file's list, made at any of those
	 * moments, carry the lists from before the pull.
	 */
	for (const [when, cacheWrite] of [
		["during the write-back", 3],
		["after the write-back, before the store reloads", 5],
	] as const) {
		test(`keeps a workspace add and an add to the open file made ${when}`, async () => {
			setUp(
				workspace(
					[todo(1, "one"), todo(2, "added on the phone")],
					[todo(10, "ten"), todo(11, "phone")]
				),
				workspace([todo(1, "one")], [todo(10, "ten")]),
				workspace([todo(1, "one")], [todo(10, "ten")])
			);
			const cacheKey = StorageKeys.workspaceGistCache(fileName);
			let cacheWrites = 0;
			afterCacheWrite = (key) => {
				if (key !== cacheKey || ++cacheWrites !== cacheWrite) {
					return;
				}
				harness.store.dispatch(workspaceActions.addTodo({ text: "typed just now" }));
				harness.store.dispatch(currentFileActions.addTodo({ text: "typed in the file" }));
			};

			await runWorkspaceSync();
			await harness.settle();

			const workspaceTodos = ["added on the phone", "one", "typed just now"];
			const fileTodos = ["phone", "ten", "typed in the file"];
			const stored = cache();
			assert.deepStrictEqual(texts(stored.data.workspaceTodos), workspaceTodos, "stored");
			assert.deepStrictEqual(texts(stored.data.filesData[FILE_PATH]), fileTodos, "stored");
			const state = harness.store.getState();
			assert.deepStrictEqual(texts(state.workspace.todos), workspaceTodos, "shown");
			assert.deepStrictEqual(texts(state.currentFile.todos), fileTodos, "shown");
			const shownFiles = workspaceStore.get("TodoFilesData") as TodoFilesData;
			assert.deepStrictEqual(texts(shownFiles[FILE_PATH]), fileTodos, "in the memento");
			assert.deepStrictEqual(
				stored.lastCleanRemoteData,
				onGist(),
				"the baseline is what the gist holds"
			);
			assert.strictEqual(manager.getStatus("workspace"), SyncStatus.Dirty, "the adds are owed");

			// The push the adds armed: it must deliver them and keep the pulled items.
			await runWorkspaceSync();
			assert.deepStrictEqual(texts(onGist().workspaceTodos), workspaceTodos);
			assert.deepStrictEqual(texts(onGist().filesData[FILE_PATH]), fileTodos);
		});
	}
});
