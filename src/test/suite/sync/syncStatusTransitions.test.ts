import * as assert from "assert";
import { SyncManager } from "../../../sync/SyncManager";
import { GitHubAuthManager } from "../../../sync/GitHubAuthManager";
import { SyncStatus } from "../../../sync/syncTypes";

/**
 * Per-scope status transitions in `SyncManager`, which drive both the status bar's warning and
 * the header's sync indicator.
 *
 * These exist because the interesting state — Dirty, "this edit is not on the gist yet" — was
 * previously unreachable, so nothing pinned when it may and may not be set. Two rules are easy
 * to break by accident and invisible until someone watches the UI:
 *
 * 1. A *load* is not an edit. `triggerDebounceSync` runs for `loadData` too (an editor tab
 *    switch dispatches one on every click, a remote pull on every change), so it must not mark
 *    the scope Dirty; extension.ts decides that from the action name and calls `markDirty`.
 * 2. Dirty must not overwrite a sync that is on the network, or a failure already reported.
 *
 * The stub context answers three things, and each is load-bearing:
 *
 * - the sync mode, because a status for a scope that is not on GitHub is deliberately dropped
 *   (see `updateStatus`), and "github" for both scopes is what every case here presupposes;
 * - `secrets`, so `getToken()` resolves to undefined and `fetchGist` fails with an auth error
 *   *without touching the network*. The two tests that drive a real `syncUser` reach the token
 *   before they touch any storage, so a stub without this can issue a live request to
 *   api.github.com — which is untimed, and a slow one is a test failure that appears at random;
 * - nothing else: `globalState.get` answers every key with the same string, so the gist cache
 *   comes back as nonsense. That is fine, because these tests assert on status transitions and
 *   the failure path is one of them.
 *
 * `GitHubAuthManager` is a process-wide singleton that permanently binds the *first* context it
 * is handed, so it is reset here — otherwise whichever suite ran first decides whether this one
 * has a real token, and with a real token the request above is a real one.
 */
suite("Sync status transitions", () => {
	let manager: SyncManager;

	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance =
			undefined;
	}

	setup(() => {
		resetAuthSingleton();
		manager = new SyncManager({
			globalState: { get: () => "github" },
			workspaceState: { get: () => "github" },
			secrets: { get: () => Promise.resolve(undefined) },
		} as never);
	});

	teardown(() => {
		// Releases the debounce timers `triggerDebounceSync` arms, so none outlives the test.
		manager.dispose();
		// Leaves no stub context bound for whichever suite runs next.
		resetAuthSingleton();
	});

	test("starts offline, before anything has synced", () => {
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Offline);
		assert.strictEqual(manager.getStatus("workspace"), SyncStatus.Offline);
	});

	test("marks a scope dirty on an edit", () => {
		manager.markDirty("user");

		assert.strictEqual(manager.getStatus("user"), SyncStatus.Dirty);
		assert.strictEqual(manager.getStatus("workspace"), SyncStatus.Offline, "other scope");
	});

	/**
	 * The regression this suite exists for: switching editor tabs dispatches
	 * `currentFile/loadData`, which reaches the same handler as a real edit. Scheduling a push
	 * for it is fine; claiming the scope has unpushed changes is not.
	 */
	test("scheduling a push does not by itself mark a scope dirty", () => {
		manager.triggerDebounceSync("workspace");

		assert.strictEqual(manager.getStatus("workspace"), SyncStatus.Offline);
	});

	test("an edit while a sync is on the network leaves the sync reported", () => {
		// Reaching Syncing without a network call: the guard under test is a status check, and
		// this is the state a poll or a manual sync puts the scope in.
		manager.markDirty("user");
		const seen: SyncStatus[] = [];
		manager.onStatusChange((event) => seen.push(event.status));

		// Stand in for the in-flight sync.
		(manager as unknown as { updateStatus(s: string, v: SyncStatus): void }).updateStatus(
			"user",
			SyncStatus.Syncing
		);
		manager.markDirty("user");

		assert.strictEqual(manager.getStatus("user"), SyncStatus.Syncing);
		assert.deepStrictEqual(seen, [SyncStatus.Syncing], "no Dirty event while syncing");
	});

	test("an edit while a failure is reported leaves the failure reported", () => {
		(manager as unknown as { updateStatus(s: string, v: SyncStatus): void }).updateStatus(
			"user",
			SyncStatus.Error
		);

		manager.markDirty("user");

		// Otherwise every keystroke while sync is broken would replace the error with a milder
		// state, and the user would never see that anything was wrong.
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Error);
	});

	/**
	 * A sync that arrives while one is already running used to be dropped outright, so an edit
	 * made during a sync reached the gist only when some later edit happened to push it. It is
	 * now remembered and re-run once the in-flight one finishes.
	 *
	 * Rescheduling from the guard itself was the first attempt and is what this pins against:
	 * that timer hits the same guard and arms another, every debounce interval for as long as the
	 * sync lasts — and `showConflictDialog` holds the flag while it waits on the user, so there
	 * was no bound at all. `syncUser` is called directly because `sync()` returns earlier, on the
	 * empty gist id a test environment has.
	 */
	test("a sync arriving during one is queued, not turned into a repeating timer", async () => {
		const internals = manager as unknown as {
			userSyncInProgress: boolean;
			userSyncQueued: boolean;
			globalDebounceTimer: NodeJS.Timeout | undefined;
			syncUser(gistId: string): Promise<{ success: boolean }>;
		};
		internals.userSyncInProgress = true;

		const result = await internals.syncUser("a".repeat(32));

		assert.strictEqual(result.success, true, "reports success rather than an error");
		assert.strictEqual(internals.userSyncQueued, true, "remembers the missed sync");
		assert.strictEqual(
			internals.globalDebounceTimer,
			undefined,
			"no timer armed from inside the guard"
		);
	});

	/**
	 * The payoff of the queue: the flag has to be consumed and turned into exactly one fresh
	 * sync, not left set (dropping the change after all) and not consumed twice.
	 *
	 * `syncUser` fails on the auth check here — the stub resolves no token — which is fine: the
	 * `finally` runs on every path, and that is what is under test.
	 */
	test("re-runs a queued sync once the in-flight one finishes", async () => {
		const internals = manager as unknown as {
			userSyncQueued: boolean;
			globalDebounceTimer: NodeJS.Timeout | undefined;
			syncUser(gistId: string): Promise<{ success: boolean }>;
		};
		internals.userSyncQueued = true;

		await internals.syncUser("a".repeat(32));

		assert.strictEqual(internals.userSyncQueued, false, "flag consumed");
		assert.notStrictEqual(internals.globalDebounceTimer, undefined, "one fresh sync armed");
	});

	/**
	 * An edit that lands mid-sync must not be buried by the Synced that sync reports from its
	 * own, older snapshot — the edit is real and still owed. Two halves, pinned separately: the
	 * sync's `finally` has to consume the flag, and consuming it has to restore Dirty.
	 */
	test("holds an edit that lands mid-sync, and the sync consumes it", async () => {
		const internals = manager as unknown as {
			userEditedWhileSyncing: boolean;
			updateStatus(scope: string, status: SyncStatus): void;
			syncUser(gistId: string): Promise<{ success: boolean }>;
		};
		internals.updateStatus("user", SyncStatus.Syncing);
		manager.markDirty("user");
		// Held, not shown: the round trip is the more useful state while it lasts.
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Syncing);
		assert.strictEqual(internals.userEditedWhileSyncing, true);

		// Fails on the auth check (the stub resolves no token), which is enough: the `finally`
		// runs on every path, and whether it runs at all is what this pins.
		await internals.syncUser("a".repeat(32));

		assert.strictEqual(
			internals.userEditedWhileSyncing,
			false,
			"the sync's finally must consume the flag"
		);
		// Error, not Dirty: a reported failure outranks an owed edit, which is still owed either
		// way. The restore itself is pinned below.
		assert.strictEqual(manager.getStatus("user"), SyncStatus.Error);
	});

	test("restores dirty when the sync that held the edit ended cleanly", () => {
		const internals = manager as unknown as {
			userEditedWhileSyncing: boolean;
			updateStatus(scope: string, status: SyncStatus): void;
			settleEditDuringSync(scope: string): void;
		};
		internals.updateStatus("user", SyncStatus.Syncing);
		manager.markDirty("user");
		// What the body reports before the `finally` runs, from a snapshot predating the edit.
		internals.updateStatus("user", SyncStatus.Synced);

		internals.settleEditDuringSync("user");

		assert.strictEqual(manager.getStatus("user"), SyncStatus.Dirty);
		assert.strictEqual(internals.userEditedWhileSyncing, false);
	});

	/**
	 * A scope that leaves GitHub mode has to lose the sync as well as the status: the debounce
	 * the last edit armed would otherwise fire and report a result for a list that no longer
	 * syncs anywhere, undoing the reset.
	 */
	test("cancelling a pending sync drops the armed debounce and both flags", () => {
		const internals = manager as unknown as {
			globalDebounceTimer: NodeJS.Timeout | undefined;
			userSyncQueued: boolean;
			userEditedWhileSyncing: boolean;
		};
		manager.triggerDebounceSync("user");
		internals.userSyncQueued = true;
		internals.userEditedWhileSyncing = true;
		assert.notStrictEqual(internals.globalDebounceTimer, undefined, "armed to begin with");

		manager.cancelPendingSync("user");

		assert.strictEqual(internals.globalDebounceTimer, undefined);
		assert.strictEqual(internals.userSyncQueued, false);
		// Left set, this would restore Dirty on the next sync of a scope that has no edits owed.
		assert.strictEqual(internals.userEditedWhileSyncing, false);
	});

	test("leaving GitHub mode returns the scope to offline", () => {
		manager.markDirty("workspace");

		manager.resetStatus("workspace");

		assert.strictEqual(manager.getStatus("workspace"), SyncStatus.Offline);
	});

	/**
	 * Every listener does real work — the status bar re-renders and the notify chain re-reads
	 * configuration, both memento stores and both gist caches — so an unchanged status must not
	 * fire. A run of edits inside one debounce window would otherwise repeat all of it per edit.
	 */
	/**
	 * `cancelPendingSync` stops the *scheduled* syncs, but one already past the in-progress guard
	 * runs to completion — worst case parked in the conflict dialog, which waits on the user — and
	 * would land its Synced or Error after the mode changed. The status bar lights its glyph when
	 * *either* scope is on GitHub, so that left a permanent warning about a list that no longer
	 * syncs anywhere, with no future sync to clear it.
	 */
	test("drops a status for a scope that has left GitHub mode", () => {
		const mixed = new SyncManager({
			globalState: { get: () => "profile-local" },
			workspaceState: { get: () => "github" },
		} as never);

		try {
			mixed.markDirty("user");
			mixed.markDirty("workspace");

			assert.strictEqual(mixed.getStatus("user"), SyncStatus.Offline, "local-only scope");
			// The other scope is untouched — this gates per scope, not globally.
			assert.strictEqual(mixed.getStatus("workspace"), SyncStatus.Dirty, "still on GitHub");
		} finally {
			mixed.dispose();
		}
	});

	test("does not announce a status that has not changed", () => {
		manager.markDirty("user");
		const events: SyncStatus[] = [];
		manager.onStatusChange((event) => events.push(event.status));

		manager.markDirty("user");
		manager.markDirty("user");

		assert.deepStrictEqual(events, []);
	});

	test("announces a real change to every listener", () => {
		const events: Array<{ scope: string; status: SyncStatus }> = [];
		manager.onStatusChange((event) => events.push(event));

		manager.markDirty("user");
		manager.resetStatus("user");

		assert.deepStrictEqual(events, [
			{ scope: "user", status: SyncStatus.Dirty },
			{ scope: "user", status: SyncStatus.Offline },
		]);
	});
});
