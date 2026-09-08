/**
 * {@link MementoCacheStore} is the seam between the shared sync engine and VS Code's storage,
 * and it is load-bearing in two ways that are easy to break silently:
 *
 *  1. the engine's cache keys must be the keys the extension already uses, or adopting the
 *     engine would read no cache at all — every file would look like a cold install, re-bootstrap
 *     from the remote and lose its merge baseline;
 *  2. workspace caches must land in `workspaceState`. A workspace baseline in `globalState` is
 *     shared across every folder, so one project's merge base would be applied to another's.
 */

import * as assert from "assert";
import { MementoCacheStore } from "../../sync/MementoCacheStore";
import { StorageKeys } from "../../sync/syncTypes";
import { GistCache, GistSyncEngine } from "../../core";

type Store = Map<string, unknown>;

function fakeContext(): { context: never; global: Store; workspace: Store } {
	const global: Store = new Map();
	const workspace: Store = new Map();
	const memento = (map: Store) => ({
		get: (key: string) => map.get(key),
		update: (key: string, value: unknown) => {
			map.set(key, value);
			return Promise.resolve();
		},
	});
	return {
		context: { globalState: memento(global), workspaceState: memento(workspace) } as never,
		global,
		workspace,
	};
}

const cache = (text: string): GistCache<{ userTodos: { text: string }[] }> => ({
	data: { userTodos: [{ text }] },
	lastCleanRemoteData: { userTodos: [{ text }] },
	lastSynced: "2026-01-01T00:00:00.000Z",
	isDirty: false,
});

suite("MementoCacheStore", () => {
	/**
	 * The engine builds its own cache keys. If they ever stop matching the keys the extension has
	 * always used, an installed extension's caches become unreachable: every file looks like a
	 * cold install, re-bootstraps from the remote, and loses its merge baseline.
	 *
	 * Asserted against a key the ENGINE actually produces, observed by handing it a store that
	 * records what it is asked for. Comparing `StorageKeys` with a hard-coded string instead —
	 * which is what this test did first — pins only one side of the agreement, so a change to
	 * the engine's format would leave it green while breaking exactly what it exists to protect.
	 */
	test("the extension's storage keys are the keys the engine actually asks for", async () => {
		const asked: string[] = [];
		const spy = {
			load: async (key: string) => {
				asked.push(key);
				return undefined;
			},
			save: async () => undefined,
		};
		const engine = new GistSyncEngine({
			client: { readFile: async () => ({ success: false }), writeFile: async () => ({ success: false }) },
			gistId: "a".repeat(32),
			cacheStore: spy,
		});

		await engine.loadCachedUser("user-todos.json");
		await engine.loadCachedWorkspace("workspace-Alpha.json");

		assert.deepStrictEqual(asked, [
			StorageKeys.globalGistCache("user-todos.json"),
			StorageKeys.workspaceGistCache("workspace-Alpha.json"),
		]);
	});

	test("routes a global cache to globalState", async () => {
		const { context, global, workspace } = fakeContext();
		const store = new MementoCacheStore(context);
		const key = StorageKeys.globalGistCache("user-todos.json");

		await store.save(key, cache("mine"));

		assert.strictEqual(global.has(key), true, "written to globalState");
		assert.strictEqual(workspace.size, 0, "not written to workspaceState");
	});

	test("routes a workspace cache to workspaceState", async () => {
		const { context, global, workspace } = fakeContext();
		const store = new MementoCacheStore(context);
		const key = StorageKeys.workspaceGistCache("workspace-Alpha.json");

		await store.save(key, cache("ours"));

		assert.strictEqual(workspace.has(key), true, "written to workspaceState");
		assert.strictEqual(global.size, 0, "a workspace baseline must not be shared across folders");
	});

	test("reads back what it wrote, per scope", async () => {
		const { context } = fakeContext();
		const store = new MementoCacheStore(context);
		const globalKey = StorageKeys.globalGistCache("user-todos.json");
		const workspaceKey = StorageKeys.workspaceGistCache("workspace-Alpha.json");

		await store.save(globalKey, cache("global"));
		await store.save(workspaceKey, cache("workspace"));

		const loadedGlobal = await store.load<{ userTodos: { text: string }[] }>(globalKey);
		const loadedWorkspace = await store.load<{ userTodos: { text: string }[] }>(workspaceKey);

		assert.strictEqual(loadedGlobal!.data.userTodos[0].text, "global");
		assert.strictEqual(loadedWorkspace!.data.userTodos[0].text, "workspace");
	});

	test("reads an existing cache written before the engine was adopted", async () => {
		// The upgrade path: a cache already in globalState under the extension's own key has to
		// come back with its baseline intact, or the first sync after upgrading re-bootstraps.
		const { context, global } = fakeContext();
		const key = StorageKeys.globalGistCache("user-todos.json");
		global.set(key, cache("written by the previous version"));

		const loaded = await new MementoCacheStore(context).load<{
			userTodos: { text: string }[];
		}>(key);

		assert.notStrictEqual(loaded, undefined, "existing cache must be found");
		assert.strictEqual(loaded!.data.userTodos[0].text, "written by the previous version");
		assert.notStrictEqual(loaded!.lastCleanRemoteData, undefined, "baseline preserved");
	});

	test("a cache that was never written comes back undefined", async () => {
		const { context } = fakeContext();

		const loaded = await new MementoCacheStore(context).load("gistCache_global_absent.json");

		// The engine reads undefined as a cold cache and bootstraps from the remote rather than
		// pushing empty local state over it, so this must not be confused with an empty cache.
		assert.strictEqual(loaded, undefined);
	});
});
