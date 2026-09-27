/**
 * `WebviewVisibilityCoordinator`: polling runs while at least one Todo view is visible, and only
 * for scopes in GitHub mode. It had no tests; these pin the reference counting and which scopes
 * it starts, over a fake `SyncManager`. They rely on `vscodeTodo.sync.pollOnlyWhenVisible` being
 * at its default (`true`) in the test instance.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { WebviewVisibilityCoordinator } from "../../sync/WebviewVisibilityCoordinator";
import { SyncManager } from "../../sync/SyncManager";

type Call = [string, string, number?];

function setUp(userMode: string, workspaceMode: string) {
	const calls: Call[] = [];
	const syncManager = {
		startPolling: (scope: string, interval: number) => calls.push(["start", scope, interval]),
		stopPolling: (scope: string) => calls.push(["stop", scope]),
	} as unknown as SyncManager;
	const state = (mode: string) => ({ get: (_key: string, fallback?: unknown) => mode ?? fallback });
	const context = {
		globalState: state(userMode),
		workspaceState: state(workspaceMode),
	} as unknown as vscode.ExtensionContext;
	return { calls, coordinator: new WebviewVisibilityCoordinator(syncManager, context, 120) };
}

suite("WebviewVisibilityCoordinator", () => {
	suiteSetup(function () {
		const pollOnlyWhenVisible = vscode.workspace
			.getConfiguration("vscodeTodo.sync")
			.get<boolean>("pollOnlyWhenVisible", true);
		if (!pollOnlyWhenVisible) {
			this.skip();
		}
	});

	test("starts polling for every GitHub-mode scope when the first view appears", () => {
		const { calls, coordinator } = setUp("github", "github");

		coordinator.incrementVisibility();

		assert.deepStrictEqual(calls, [
			["start", "user", 120],
			["start", "workspace", 120],
		]);
	});

	test("starts nothing for scopes that are not in GitHub mode", () => {
		const { calls, coordinator } = setUp("profile-local", "github");

		coordinator.incrementVisibility();

		assert.deepStrictEqual(calls, [["start", "workspace", 120]]);
	});

	test("counts views: a second view does not restart polling, and hiding one of two keeps it", () => {
		const { calls, coordinator } = setUp("github", "local");

		coordinator.incrementVisibility();
		coordinator.incrementVisibility();
		coordinator.decrementVisibility();

		assert.deepStrictEqual(calls, [["start", "user", 120]]);
	});

	test("stops both scopes when the last view is hidden", () => {
		const { calls, coordinator } = setUp("github", "local");

		coordinator.incrementVisibility();
		coordinator.decrementVisibility();

		assert.deepStrictEqual(calls.slice(1), [
			["stop", "user"],
			["stop", "workspace"],
		]);
	});

	test("never lets the count go below zero", () => {
		const { calls, coordinator } = setUp("github", "local");

		coordinator.decrementVisibility();
		coordinator.decrementVisibility();
		coordinator.incrementVisibility();

		// The first increment after the extra hides still counts as "the first view".
		assert.deepStrictEqual(calls.filter(([kind]) => kind === "start"), [["start", "user", 120]]);
	});

	test("restarts polling with a new interval only while a view is visible", () => {
		const { calls, coordinator } = setUp("github", "local");

		coordinator.updatePollInterval(300);
		assert.deepStrictEqual(calls, [], "no view visible: nothing to restart");

		coordinator.incrementVisibility();
		coordinator.updatePollInterval(60);

		assert.deepStrictEqual(calls, [
			["start", "user", 300],
			["stop", "user"],
			["stop", "workspace"],
			["start", "user", 60],
		]);
	});

	test("re-reads the sync modes when they change while visible", () => {
		const { calls, coordinator } = setUp("github", "local");
		coordinator.incrementVisibility();
		calls.length = 0;

		coordinator.updateSyncModes();

		assert.deepStrictEqual(calls, [
			["stop", "user"],
			["stop", "workspace"],
			["start", "user", 120],
		]);
	});

	test("dispose stops polling", () => {
		const { calls, coordinator } = setUp("github", "github");
		coordinator.incrementVisibility();
		calls.length = 0;

		coordinator.dispose();

		assert.deepStrictEqual(calls, [
			["stop", "user"],
			["stop", "workspace"],
		]);
	});
});
