import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
	KeyValueStore,
	IndexedDbCacheStore,
	IndexedDbTokenStore,
	IdbEnv,
	GistCache,
	GlobalGistData,
	GistSyncEngine,
	GistFileIO,
	SyncResult,
	SyncErrorType,
	serialize,
	Todo,
} from "../src/index";

// A fresh in-memory IndexedDB per test → full isolation, no global pollution.
let env: IdbEnv;
beforeEach(() => {
	env = { indexedDB: new IDBFactory() };
});

const todo = (id: number, text: string): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
});

describe("KeyValueStore", () => {
	it("round-trips values and returns undefined for missing keys", async () => {
		const kv = KeyValueStore.open("db", "store", env);
		expect(await kv.get("missing")).toBeUndefined();
		await kv.set("a", { n: 1 });
		expect(await kv.get<{ n: number }>("a")).toEqual({ n: 1 });
	});

	it("overwrites an existing key", async () => {
		const kv = KeyValueStore.open("db", "store", env);
		await kv.set("a", 1);
		await kv.set("a", 2);
		expect(await kv.get<number>("a")).toBe(2);
	});

	it("lists keys and deletes them", async () => {
		const kv = KeyValueStore.open("db", "store", env);
		await kv.set("a", 1);
		await kv.set("b", 2);
		expect((await kv.keys()).sort()).toEqual(["a", "b"]);
		await kv.delete("a");
		expect((await kv.keys()).sort()).toEqual(["b"]);
		expect(await kv.get("a")).toBeUndefined();
	});

	it("persists across separate store handles on the same database", async () => {
		const first = KeyValueStore.open("shared", "store", env);
		await first.set("k", "v");
		await first.close();
		const second = KeyValueStore.open("shared", "store", env);
		expect(await second.get<string>("k")).toBe("v");
	});
});

describe("IndexedDbCacheStore", () => {
	it("saves and loads a GistCache entry", async () => {
		const store = new IndexedDbCacheStore(env);
		const cache: GistCache<GlobalGistData> = {
			data: { userTodos: [todo(1, "a")] },
			lastCleanRemoteData: { userTodos: [todo(1, "a")] },
			lastSynced: "2020-01-01T00:00:00.000Z",
			isDirty: false,
		};
		await store.save("gistCache_global_user-todos.json", cache);
		const loaded = await store.load<GlobalGistData>("gistCache_global_user-todos.json");
		expect(loaded).toEqual(cache);
	});

	it("returns undefined for an unknown key", async () => {
		const store = new IndexedDbCacheStore(env);
		expect(await store.load("nope")).toBeUndefined();
	});

	it("clear() removes every cached file", async () => {
		const store = new IndexedDbCacheStore(env);
		const c: GistCache<GlobalGistData> = {
			data: { userTodos: [] },
			lastSynced: "2020-01-01T00:00:00.000Z",
			isDirty: false,
		};
		await store.save("gistCache_global_user-todos.json", c);
		await store.save("gistCache_workspace_workspace-x.json", c);
		await store.clear();
		expect(await store.load("gistCache_global_user-todos.json")).toBeUndefined();
		expect(await store.load("gistCache_workspace_workspace-x.json")).toBeUndefined();
	});

	it("works as the CacheStore for GistSyncEngine and persists the baseline across reloads", async () => {
		// A fake gist shared across two engine "sessions" backed by the same IndexedDB.
		class FakeGist implements GistFileIO {
			readonly files = new Map<string, string>();
			async readFile(_g: string, f: string): Promise<SyncResult<string>> {
				if (!this.files.has(f))
					return {
						success: false,
						error: { type: SyncErrorType.FileNotFoundError, message: "", timestamp: "", retryable: false },
					};
				return { success: true, data: this.files.get(f)! };
			}
			async writeFile(_g: string, f: string, content: string): Promise<SyncResult<unknown>> {
				this.files.set(f, content);
				return { success: true, data: {} };
			}
		}
		const gist = new FakeGist();
		const GID = "0123456789abcdef0123456789abcdef";
		const FILE = "user-todos.json";
		const local: GlobalGistData = { userTodos: [todo(1, "a")] };

		// Session 1: seed the gist, persisting the cache to IndexedDB.
		const store = new IndexedDbCacheStore(env);
		const engine1 = new GistSyncEngine({ client: gist, gistId: GID, cacheStore: store });
		await engine1.reconcileUser(FILE, local);

		// The extension edits the remote while the PWA is "closed".
		gist.files.set(FILE, serialize({ userTodos: [todo(1, "a"), todo(2, "from vscode")] }));

		// Session 2: a brand-new engine + store handle reading the persisted baseline must
		// detect this as a remote-only change (pull), not a conflict.
		const store2 = new IndexedDbCacheStore(env);
		const engine2 = new GistSyncEngine({ client: gist, gistId: GID, cacheStore: store2 });
		const res = await engine2.reconcileUser(FILE, local);

		expect(res.success).toBe(true);
		expect(res.data?.changedRemotely).toBe(true);
		expect(res.data?.pushed).toBe(false);
		expect(res.data?.conflicts).toHaveLength(0);
		expect(res.data?.data.userTodos.map((t) => t.id)).toEqual([1, 2]);
	});
});

describe("IndexedDbTokenStore", () => {
	it("stores and clears the token, gist id, and selected files", async () => {
		const store = new IndexedDbTokenStore(env);
		expect(await store.getToken()).toBeUndefined();
		expect(await store.getGistId()).toBeUndefined();
		expect(await store.getUserFile()).toBeUndefined();
		expect(await store.getWorkspaceFile()).toBeUndefined();

		await store.setToken("gho_secret");
		await store.setGistId("0123456789abcdef0123456789abcdef");
		await store.setUserFile("user-todos.json");
		await store.setWorkspaceFile("workspace-ProjectA.json");
		expect(await store.getToken()).toBe("gho_secret");
		expect(await store.getGistId()).toBe("0123456789abcdef0123456789abcdef");
		expect(await store.getUserFile()).toBe("user-todos.json");
		expect(await store.getWorkspaceFile()).toBe("workspace-ProjectA.json");

		await store.clear();
		expect(await store.getToken()).toBeUndefined();
		expect(await store.getGistId()).toBeUndefined();
		expect(await store.getUserFile()).toBeUndefined();
		expect(await store.getWorkspaceFile()).toBeUndefined();
	});

	it("persists the token across store handles (survives reload)", async () => {
		const first = new IndexedDbTokenStore(env);
		await first.setToken("gho_persisted");
		const second = new IndexedDbTokenStore(env);
		expect(await second.getToken()).toBe("gho_persisted");
	});
});

describe("multiple stores sharing one database", () => {
	// Regression: the cache store and the token store both live in `vsc-todo-pwa`. When each
	// opened at a hard-coded version 1, whichever ran first created only its own store; the
	// second found the database already at version 1, never got an upgrade transaction, and
	// threw NotFoundError ("One of the specified object stores was not found") on first use.
	it("creates a second store in a database another store already made", async () => {
		const first = KeyValueStore.open("shared", "store-a", env);
		await first.set("a", 1);

		const second = KeyValueStore.open("shared", "store-b", env);
		await second.set("b", 2);

		expect(await first.get("a")).toBe(1);
		expect(await second.get("b")).toBe(2);
	});

	it("lets the cache and token stores coexist in the default database", async () => {
		const cache = new IndexedDbCacheStore(env);
		const tokens = new IndexedDbTokenStore(env);

		await tokens.setToken("gho_example");
		await cache.save("gistCache_user_user-todos.json", {
			data: { userTodos: [] },
			lastCleanRemoteData: { userTodos: [] },
			lastSynced: "2020-01-01T00:00:00.000Z",
			isDirty: false,
		});

		expect(await tokens.getToken()).toBe("gho_example");
		expect(await cache.load("gistCache_user_user-todos.json")).toBeDefined();
	});

	it("works regardless of which store is opened first", async () => {
		const tokens = new IndexedDbTokenStore(env);
		await tokens.setGistId("0123456789abcdef0123456789abcdef");

		const cache = new IndexedDbCacheStore(env);
		await cache.save("k", {
			data: { userTodos: [] },
			lastCleanRemoteData: { userTodos: [] },
			lastSynced: "2020-01-01T00:00:00.000Z",
			isDirty: false,
		});

		expect(await tokens.getGistId()).toBe("0123456789abcdef0123456789abcdef");
		expect(await cache.load("k")).toBeDefined();
	});
});
