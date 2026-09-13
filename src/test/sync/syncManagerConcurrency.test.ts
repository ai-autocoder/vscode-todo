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
 * the cache-store adapter, the local snapshot, the write-back, and the reload event.
 */

import * as assert from "assert";
import { SyncManager } from "../../sync/SyncManager";
import { SyncStorageManager } from "../../sync/SyncStorageManager";
import { GitHubAuthManager } from "../../sync/GitHubAuthManager";
import { GlobalSyncMode, StorageKeys, SyncStatus } from "../../sync/syncTypes";
import { serialize } from "../../core";
import { Todo } from "../../todo/todoTypes";

const GIST_ID = "a".repeat(32);
const FILE = "user-todos.json";

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

suite("SyncManager concurrency", () => {
	let globalStore: Map<string, unknown>;
	let manager: SyncManager;
	let gist: FakeGistFile;
	let context: never;
	/** Set by a test to interleave work immediately after a memento write. See `memento`. */
	let afterCacheWrite: ((key: string, writes: number) => Promise<void> | void) | undefined;

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
		manager = new SyncManager(context);
		// The real client is built in the constructor from the context; swapping it keeps every
		// other code path (cache store, snapshot, write-back, events) exactly as it ships.
		(manager as unknown as { apiClient: unknown }).apiClient = gist;
	}

	/**
	 * Records a local edit through the REAL storage path, exactly as `persistSlice` does.
	 *
	 * Tests must not hand-roll this. `SyncStorageManager.setGlobalTodos` mutates the cached
	 * object *in place* (`cache.data.userTodos = todos`) on the object a memento's `get` returns
	 * — which is the stored object itself, not a copy. A test that instead writes a fresh
	 * `{...cache, data}` object silently sidesteps that, and a whole class of aliasing bug with
	 * it: the first version of this suite did exactly that and passed against code that deleted
	 * the user's next edit on every sync.
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
	 * suite. Every engine success path calls `saveCache(key, X, X)`, passing one object as both
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

	test("the merged result is written back to local storage and announced", async () => {
		setUp([todo(1, "one")], [todo(1, "one")], [todo(1, "one, edited here")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				gist.content = serialize({ userTodos: [todo(1, "one"), todo(2, "added on the phone")] });
			}
		};
		let announced = 0;
		manager.onDataDownloaded(() => announced++);

		await runUserSync();

		// Without this the peer's todo reaches the gist but never the UI, and the next reconcile
		// reads its absence from local as a deletion and pushes it away again.
		assert.deepStrictEqual(
			cachedTodos().map((t) => t.id).sort(),
			[1, 2],
			"local storage holds both"
		);
		assert.strictEqual(announced, 1, "the store is told to reload exactly once");
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
