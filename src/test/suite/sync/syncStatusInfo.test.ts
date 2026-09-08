import * as assert from "assert";
import { getSyncStatusInfo, recordSyncStatusInfo } from "../../../utilities/syncInfo";
import { SyncStatus } from "../../../sync/syncTypes";

/**
 * The extension half of the header's sync indicator.
 *
 * `SyncManager` keeps one `SyncStatus` per scope and only *emits* changes, so two things have to
 * hold for the indicator to be right: the enum has to map onto the webview's string union (they
 * are separate types on purpose — see the note in panels/message.ts), and the last announced
 * value has to be readable afterwards, because a webview that is created or reloaded between two
 * status changes is handed this cache rather than waiting for the next sync.
 *
 * The PWA's half of the same contract is covered by `webview-ui/src/app/data/gist-gateway.spec.ts`.
 */
suite("Sync status info", () => {
	// The cache is module-level, so leaving it holding a test's value would make a future test
	// that asserts the freshly-activated default pass or fail depending on suite ordering.
	setup(() => {
		recordSyncStatusInfo(SyncStatus.Offline, SyncStatus.Offline);
	});

	teardown(() => {
		recordSyncStatusInfo(SyncStatus.Offline, SyncStatus.Offline);
	});

	/**
	 * Pins the shape a first-load webview is handed, not the module's initial value — `setup`
	 * has already written to the cache by the time this runs, which is the price of keeping the
	 * suite order-independent. The initial value is the same triple, declared in syncInfo.ts.
	 */
	test("reports both scopes offline, with no retry offered, when nothing has synced", () => {
		const info = getSyncStatusInfo();

		assert.deepStrictEqual(info, {
			isSyncing: false,
			user: { status: "offline", canRetry: false },
			workspace: { status: "offline", canRetry: false },
		});
	});

	test("maps every SyncStatus onto the webview's union", () => {
		const cases: Array<[SyncStatus, string]> = [
			[SyncStatus.Synced, "synced"],
			[SyncStatus.Dirty, "dirty"],
			[SyncStatus.Syncing, "syncing"],
			[SyncStatus.Error, "error"],
			[SyncStatus.Offline, "offline"],
		];

		for (const [status, expected] of cases) {
			const info = recordSyncStatusInfo(status, SyncStatus.Offline);
			assert.strictEqual(info.user.status, expected, `user status for ${status}`);
		}
	});

	test("keeps the two scopes independent", () => {
		const info = recordSyncStatusInfo(SyncStatus.Dirty, SyncStatus.Synced);

		assert.strictEqual(info.user.status, "dirty");
		assert.strictEqual(info.workspace.status, "synced");
	});

	test("derives isSyncing from either scope, for the scope-agnostic menu spinner", () => {
		assert.strictEqual(
			recordSyncStatusInfo(SyncStatus.Syncing, SyncStatus.Synced).isSyncing,
			true,
			"user syncing"
		);
		assert.strictEqual(
			recordSyncStatusInfo(SyncStatus.Synced, SyncStatus.Syncing).isSyncing,
			true,
			"workspace syncing"
		);
		assert.strictEqual(
			recordSyncStatusInfo(SyncStatus.Dirty, SyncStatus.Synced).isSyncing,
			false,
			"neither syncing"
		);
	});

	/**
	 * The extension cannot classify a failure the way the PWA's gateway does, so it offers a
	 * retry for both states a sync can move and for nothing else — an indicator that invited a
	 * click on a settled scope would do nothing when pressed.
	 */
	test("offers a retry only where a manual sync could help", () => {
		const retryable: Array<[SyncStatus, boolean]> = [
			[SyncStatus.Dirty, true],
			[SyncStatus.Error, true],
			[SyncStatus.Synced, false],
			[SyncStatus.Syncing, false],
			[SyncStatus.Offline, false],
		];

		for (const [status, expected] of retryable) {
			const info = recordSyncStatusInfo(status, SyncStatus.Offline);
			assert.strictEqual(info.user.canRetry, expected, `canRetry for ${status}`);
		}
	});

	test("hands a reloading webview the last announced state, not a default", () => {
		recordSyncStatusInfo(SyncStatus.Dirty, SyncStatus.Error);

		const cached = getSyncStatusInfo();

		assert.strictEqual(cached.user.status, "dirty");
		assert.strictEqual(cached.workspace.status, "error");
	});

	test("the cache follows the latest record", () => {
		recordSyncStatusInfo(SyncStatus.Dirty, SyncStatus.Dirty);
		recordSyncStatusInfo(SyncStatus.Synced, SyncStatus.Synced);

		assert.strictEqual(getSyncStatusInfo().user.status, "synced");
		assert.strictEqual(getSyncStatusInfo().workspace.status, "synced");
	});
});
