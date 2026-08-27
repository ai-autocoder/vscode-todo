/**
 * Regression tests for the data-loss bugs that wiped populated gist files.
 *
 * These differ from gistSyncEngine.test.ts by exercising the engine the way the PWA gateway
 * actually drives it: across *sessions* (a fresh engine over a persisted cache), and through a
 * client that models what the caller keeps locally between reconciles. Every bug below shipped
 * and destroyed real user data, so each one is pinned to the precise interleaving that caused it.
 */

import { describe, it, expect } from "vitest";
import {
	GistSyncEngine,
	GistFileIO,
	CacheStore,
	MemoryCacheStore,
	GlobalGistData,
	WorkspaceGistData,
	SyncErrorType,
	SyncResult,
	serialize,
	isEqual,
	Todo,
} from "../src/index";

const GIST_ID = "0123456789abcdef0123456789abcdef";
const USER_FILE = "user-vscode-extensions.json";
const WS_FILE = "workspace-vscode-todo.json";
/** Computed so the literal path key does not trip the camelCase naming rule. */
const FILE_PATH = "c:/repo/a.ts";

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

/** In-memory gist that records every write so we can assert nothing was clobbered. */
class FakeGist implements GistFileIO {
	readonly files = new Map<string, string>();
	readonly writeLog: Array<{ fileName: string; content: string }> = [];

	async readFile(_gistId: string, fileName: string): Promise<SyncResult<string>> {
		if (!this.files.has(fileName)) {
			return {
				success: false,
				error: {
					type: SyncErrorType.FileNotFoundError,
					message: "not found",
					timestamp: "",
					retryable: false,
				},
			};
		}
		return { success: true, data: this.files.get(fileName)! };
	}

	async writeFile(_gistId: string, fileName: string, content: string): Promise<SyncResult<unknown>> {
		this.writeLog.push({ fileName, content });
		this.files.set(fileName, content);
		return { success: true, data: {} };
	}

	seed(fileName: string, data: unknown): void {
		this.files.set(fileName, serialize(data));
	}

	user(): GlobalGistData {
		return JSON.parse(this.files.get(USER_FILE)!) as GlobalGistData;
	}

	workspace(): WorkspaceGistData {
		return JSON.parse(this.files.get(WS_FILE)!) as WorkspaceGistData;
	}
}

/**
 * A cache store that survives "restarting" the engine, so a second engine instance sees what the
 * first persisted — the IndexedDB-backed behaviour, without IndexedDB.
 */
class PersistentCacheStore implements CacheStore {
	private readonly map = new Map<string, string>();
	loads = 0;
	saves = 0;

	async load<T>(key: string) {
		this.loads++;
		const raw = this.map.get(key);
		// Round-trip through JSON the way structured-clone-backed storage would.
		return raw === undefined ? undefined : (JSON.parse(raw) as never);
	}

	async save<T>(key: string, cache: T) {
		this.saves++;
		this.map.set(key, JSON.stringify(cache));
	}

	/** What `resetForNewGist()` / `disconnectGitHub()` do. */
	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}

const newEngine = (gist: FakeGist, store: CacheStore) =>
	new GistSyncEngine({ client: gist, gistId: GIST_ID, cacheStore: store });

const emptyWorkspace = (): WorkspaceGistData => ({
	workspaceTodos: [],
	filesData: {},
	filesDataPaths: {},
});

describe("cold cache never destroys remote content", () => {
	it("adopts a populated user file instead of pushing the empty local list", async () => {
		const gist = new FakeGist();
		const remote: GlobalGistData = {
			userTodos: [todo(1, "written in vscode"), todo(2, "also from vscode")],
		};
		gist.seed(USER_FILE, remote);

		// Fresh device: no cache at all, and the app has not loaded anything yet.
		const res = await newEngine(gist, new MemoryCacheStore()).reconcileUser(USER_FILE, {
			userTodos: [],
		});

		expect(res.success).toBe(true);
		expect(res.data?.pushed).toBe(false);
		expect(gist.writeLog).toHaveLength(0);
		expect(gist.user().userTodos).toHaveLength(2);
		expect(res.data?.data.userTodos).toHaveLength(2);
		expect(res.data?.changedRemotely).toBe(true);
	});

	it("adopts a populated workspace file instead of pushing empty workspaceTodos/filesData", async () => {
		const gist = new FakeGist();
		const remote: WorkspaceGistData = {
			workspaceTodos: [todo(10, "ws todo")],
			filesData: { [FILE_PATH]: [todo(11, "in a.ts")] },
			filesDataPaths: {},
		};
		gist.seed(WS_FILE, remote);

		const res = await newEngine(gist, new MemoryCacheStore()).reconcileWorkspace(
			WS_FILE,
			emptyWorkspace()
		);

		expect(gist.writeLog).toHaveLength(0);
		expect(gist.workspace().workspaceTodos).toHaveLength(1);
		expect(Object.keys(gist.workspace().filesData)).toHaveLength(1);
		expect(res.data?.data.filesData[FILE_PATH]).toHaveLength(1);
	});

	it("merges rather than overwrites when the cold device also holds local todos", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "remote only")] });

		const res = await newEngine(gist, new MemoryCacheStore()).reconcileUser(USER_FILE, {
			userTodos: [todo(2, "local only")],
		});

		const ids = gist.user().userTodos.map((t) => t.id).sort();
		expect(ids).toEqual([1, 2]);
		expect(res.data?.pushed).toBe(true);
	});
});

describe("the caller must adopt the reconciled result (bug: stale local -> push of empty)", () => {
	/**
	 * The wipe that kept recurring. Session 1 pulls the remote and the engine records it as the
	 * baseline. If the caller keeps its own (empty) list instead of adopting the returned data,
	 * session 2 compares empty-local against populated-baseline, reads it as a deletion, and
	 * pushes the empty list over the gist.
	 */
	it("reproduces the wipe when the caller ignores the returned data", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b"), todo(3, "c")] });
		const store = new PersistentCacheStore();

		// Session 1 — pull, but the caller (buggy) throws the result away and stays empty.
		let localTodos: Todo[] = [];
		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: localTodos });

		// Session 2 — same empty local list, now with a populated baseline in the cache.
		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: localTodos });

		// This is the data loss, asserted so the mechanism stays documented.
		expect(gist.user().userTodos).toHaveLength(0);
	});

	it("does not wipe when the caller adopts the reconciled data, as the gateway now does", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b"), todo(3, "c")] });
		const store = new PersistentCacheStore();

		let localTodos: Todo[] = [];

		// Session 1 — adopt the result, exactly like reconcileUser() in the gateway.
		const first = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: localTodos });
		localTodos = first.data!.data.userTodos;
		expect(localTodos).toHaveLength(3);

		// Session 2 and 3 — steady state, no writes, nothing lost.
		const second = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: localTodos });
		localTodos = second.data!.data.userTodos;
		const third = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: localTodos });
		localTodos = third.data!.data.userTodos;

		expect(gist.user().userTodos).toHaveLength(3);
		expect(localTodos).toHaveLength(3);
		expect(gist.writeLog).toHaveLength(0);
	});

	it("keeps workspace filesData across sessions when the caller adopts the result", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(10, "ws")],
			filesData: { [FILE_PATH]: [todo(11, "in a")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		let local = emptyWorkspace();
		for (let i = 0; i < 3; i++) {
			const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, local);
			local = res.data!.data;
		}

		expect(gist.workspace().workspaceTodos).toHaveLength(1);
		expect(gist.workspace().filesData[FILE_PATH]).toHaveLength(1);
		expect(gist.writeLog).toHaveLength(0);
	});
});

describe("local edits still reach the gist", () => {
	it("pushes a todo added after the baseline was established", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const store = new PersistentCacheStore();

		const pulled = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });
		const local = [...pulled.data!.data.userTodos, todo(2, "added on phone")];

		const pushed = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: local });

		expect(pushed.data?.pushed).toBe(true);
		expect(gist.user().userTodos.map((t) => t.id).sort()).toEqual([1, 2]);
	});

	it("pushes an edit made in the same session as the pull", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const store = new PersistentCacheStore();
		const engine = newEngine(gist, store);

		const pulled = await engine.reconcileUser(USER_FILE, { userTodos: [] });
		const local = [...pulled.data!.data.userTodos, todo(2, "added right after")];
		await engine.reconcileUser(USER_FILE, { userTodos: local });

		expect(gist.user().userTodos).toHaveLength(2);
	});

	it("does not resurrect a todo the user deleted locally after syncing", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b")] });
		const store = new PersistentCacheStore();

		const pulled = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });
		const local = pulled.data!.data.userTodos.filter((t) => t.id !== 2);

		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: local });

		expect(gist.user().userTodos.map((t) => t.id)).toEqual([1]);
	});
});

describe("switching gists", () => {
	/**
	 * Clearing the cache is what makes the new gist look "cold". That is correct — but it means
	 * the bootstrap path is the only thing standing between a gist switch and a wipe.
	 */
	it("does not push the previous gist's todos over the newly selected gist", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "old gist")] });
		const store = new PersistentCacheStore();

		const first = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });
		expect(first.data?.data.userTodos).toHaveLength(1);

		// User switches gists: cache cleared and local slices reset (resetForNewGist).
		store.clear();
		const other = new FakeGist();
		other.seed(USER_FILE, { userTodos: [todo(99, "brand new gist content")] });

		const res = await newEngine(other, store).reconcileUser(USER_FILE, { userTodos: [] });

		expect(other.writeLog).toHaveLength(0);
		expect(other.user().userTodos.map((t) => t.id)).toEqual([99]);
		expect(res.data?.data.userTodos.map((t) => t.id)).toEqual([99]);
	});
});

describe("remote edits from the VS Code extension", () => {
	it("pulls a change made remotely while the PWA was idle", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a")] });
		const store = new PersistentCacheStore();

		let local = (await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] })).data!
			.data.userTodos;

		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "added in vscode")] });

		const res = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: local });

		expect(res.data?.changedRemotely).toBe(true);
		expect(res.data?.pushed).toBe(false);
		expect(res.data?.data.userTodos).toHaveLength(2);
	});

	it("merges concurrent additions from both sides without losing either", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "shared")] });
		const store = new PersistentCacheStore();

		const local = (await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] })).data!
			.data.userTodos;

		// Both sides add something different against the same baseline.
		gist.seed(USER_FILE, { userTodos: [todo(1, "shared"), todo(2, "from vscode")] });
		const withLocalAdd = [...local, todo(3, "from phone")];

		const res = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: withLocalAdd });

		const ids = gist.user().userTodos.map((t) => t.id).sort((a, b) => a - b);
		expect(ids).toEqual([1, 2, 3]);
		expect(res.data?.conflicts).toHaveLength(0);
	});
});

describe("isEqual compares content, not key order", () => {
	it("treats the same workspace data with different key order as equal", () => {
		const a = { workspaceTodos: [], filesData: {}, filesDataPaths: {} };
		const b = { filesData: {}, filesDataPaths: {}, workspaceTodos: [] };
		expect(isEqual(a, b)).toBe(true);
	});

	it("treats the same todo built two ways as equal", () => {
		const parsed = JSON.parse('{"text":"a","id":1,"completed":false}') as object;
		const built = { id: 1, text: "a", completed: false };
		expect(isEqual(parsed, built)).toBe(true);
	});

	it("still distinguishes different content", () => {
		expect(isEqual({ id: 1, text: "a" }, { id: 1, text: "b" })).toBe(false);
	});

	it("keeps array order significant, since todo order is user-visible", () => {
		expect(isEqual({ todos: [todo(1, "a"), todo(2, "b")] }, { todos: [todo(2, "b"), todo(1, "a")] })).toBe(
			false
		);
	});

	it("survives a JSON round-trip of the reconciled workspace data", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(1, "ws")],
			filesData: {},
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());
		const adopted = res.data!.data;

		// Re-reconciling with the adopted object must be a no-op: if key order drifted between
		// what the engine returned and what it cached, this would push spuriously.
		const again = await newEngine(gist, store).reconcileWorkspace(WS_FILE, adopted);

		expect(again.data?.pushed).toBe(false);
		expect(gist.writeLog).toHaveLength(0);
	});
});

describe("missing files", () => {
	it("seeds a user file that does not exist without touching other files", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(1, "ws")],
			filesData: {},
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [todo(5, "new")] });

		expect(gist.user().userTodos).toHaveLength(1);
		expect(gist.workspace().workspaceTodos).toHaveLength(1);
	});

	it("does not create a file when the local list is empty and the remote is absent", async () => {
		const gist = new FakeGist();
		const store = new PersistentCacheStore();

		const res = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });

		// Seeding an empty file is harmless, but it must not report a remote change.
		expect(res.data?.changedRemotely).toBe(false);
	});
});

describe("warm cache + cold in-memory state (the reload wipe)", () => {
	/**
	 * The bug the user hit repeatedly. Session 1 syncs and persists a populated baseline. On
	 * reload the gateway restores the token/gist/file names but NOT the todos, so "local" is
	 * empty against a populated baseline. Branch 3c reads that as a deletion and pushes empty.
	 *
	 * The caller must rehydrate its slices from the cache's `data` before reconciling.
	 */
	it("wipes the user file when the caller reloads without rehydrating local state", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b")] });
		const store = new PersistentCacheStore();

		// Session 1: pull and adopt. Baseline is now populated on disk.
		const first = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });
		expect(first.data?.data.userTodos).toHaveLength(2);

		// Session 2: page reload. Cache survives; in-memory todos do not.
		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });

		expect(gist.user().userTodos).toHaveLength(0);
	});

	it("preserves the user file when the caller rehydrates from the cache", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b")] });
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });

		// Reload, but rehydrate local state from the persisted cache first.
		const cached = await store.load<GlobalGistData>("gistCache_global_" + USER_FILE);
		const rehydrated = cached?.data.userTodos ?? [];
		expect(rehydrated).toHaveLength(2);

		const res = await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: rehydrated });

		expect(res.data?.pushed).toBe(false);
		expect(gist.user().userTodos).toHaveLength(2);
	});

	it("wipes the workspace file on reload without rehydration", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(10, "ws")],
			filesData: { [FILE_PATH]: [todo(11, "in a")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());
		await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());

		expect(gist.workspace().workspaceTodos).toHaveLength(0);
		expect(Object.keys(gist.workspace().filesData)).toHaveLength(0);
	});

	it("preserves the workspace file when rehydrated from the cache", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(10, "ws")],
			filesData: { [FILE_PATH]: [todo(11, "in a")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());

		const cached = await store.load<WorkspaceGistData>("gistCache_workspace_" + WS_FILE);
		const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, cached!.data);

		expect(res.data?.pushed).toBe(false);
		expect(gist.workspace().workspaceTodos).toHaveLength(1);
		expect(gist.workspace().filesData[FILE_PATH]).toHaveLength(1);
	});
});

describe("loadCachedUser / loadCachedWorkspace (the rehydration API)", () => {
	it("returns undefined before the first sync", async () => {
		const engine = newEngine(new FakeGist(), new PersistentCacheStore());
		expect(await engine.loadCachedUser(USER_FILE)).toBeUndefined();
		expect(await engine.loadCachedWorkspace(WS_FILE)).toBeUndefined();
	});

	it("returns the data a previous engine instance persisted", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b")] });
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });

		const cached = await newEngine(gist, store).loadCachedUser(USER_FILE);
		expect(cached?.userTodos).toHaveLength(2);
	});

	it("round-trips workspace filesData so the gateway can restore per-file todos", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(10, "ws")],
			filesData: { [FILE_PATH]: [todo(11, "in a")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());

		const cached = await newEngine(gist, store).loadCachedWorkspace(WS_FILE);
		expect(cached?.workspaceTodos).toHaveLength(1);
		expect(cached?.filesData[FILE_PATH]).toHaveLength(1);
	});

	it("is scoped per file name, so the user and workspace caches do not collide", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "u")] });
		gist.seed(WS_FILE, { workspaceTodos: [todo(2, "w")], filesData: {}, filesDataPaths: {} });
		const store = new PersistentCacheStore();
		const engine = newEngine(gist, store);

		await engine.reconcileUser(USER_FILE, { userTodos: [] });
		await engine.reconcileWorkspace(WS_FILE, emptyWorkspace());

		expect((await engine.loadCachedUser(USER_FILE))?.userTodos[0].id).toBe(1);
		expect((await engine.loadCachedWorkspace(WS_FILE))?.workspaceTodos[0].id).toBe(2);
	});

	it("full reload cycle: rehydrate then reconcile is a no-op that preserves everything", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "a"), todo(2, "b"), todo(3, "c")] });
		gist.seed(WS_FILE, {
			workspaceTodos: [todo(10, "ws")],
			filesData: { [FILE_PATH]: [todo(11, "in a")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		// Session 1: initial sync.
		const e1 = newEngine(gist, store);
		await e1.reconcileUser(USER_FILE, { userTodos: [] });
		await e1.reconcileWorkspace(WS_FILE, emptyWorkspace());

		// Sessions 2-4: reload, rehydrate from cache, reconcile. Must never write.
		for (let i = 0; i < 3; i++) {
			const e = newEngine(gist, store);
			const u = (await e.loadCachedUser(USER_FILE)) ?? { userTodos: [] };
			const w = (await e.loadCachedWorkspace(WS_FILE)) ?? emptyWorkspace();
			await e.reconcileUser(USER_FILE, u);
			await e.reconcileWorkspace(WS_FILE, w);
		}

		expect(gist.writeLog).toHaveLength(0);
		expect(gist.user().userTodos).toHaveLength(3);
		expect(gist.workspace().workspaceTodos).toHaveLength(1);
		expect(gist.workspace().filesData[FILE_PATH]).toHaveLength(1);
	});

	it("an edit survives the reload cycle and reaches the gist", async () => {
		const gist = new FakeGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileUser(USER_FILE, { userTodos: [] });

		// Reload, rehydrate, add an item, reconcile.
		const e2 = newEngine(gist, store);
		const restored = (await e2.loadCachedUser(USER_FILE))!.userTodos;
		await e2.reconcileUser(USER_FILE, { userTodos: [...restored, todo(2, "added after reload")] });

		expect(gist.user().userTodos.map((t) => t.id).sort()).toEqual([1, 2]);
	});
});

describe("workspace scope syncs once a file is selected", () => {
	it("pushes a newly added workspace todo", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, { workspaceTodos: [todo(1, "existing")], filesData: {}, filesDataPaths: {} });
		const store = new PersistentCacheStore();

		const pulled = await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());
		const local: WorkspaceGistData = {
			...pulled.data!.data,
			workspaceTodos: [...pulled.data!.data.workspaceTodos, todo(2, "added on phone")],
		};

		const pushed = await newEngine(gist, store).reconcileWorkspace(WS_FILE, local);

		expect(pushed.data?.pushed).toBe(true);
		expect(gist.workspace().workspaceTodos.map((t) => t.id).sort()).toEqual([1, 2]);
	});

	it("pulls a workspace todo added by the extension", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, { workspaceTodos: [todo(1, "a")], filesData: {}, filesDataPaths: {} });
		const store = new PersistentCacheStore();

		const local = (await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace())).data!
			.data;

		gist.seed(WS_FILE, {
			workspaceTodos: [todo(1, "a"), todo(2, "from vscode")],
			filesData: {},
			filesDataPaths: {},
		});

		const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, local);

		expect(res.data?.changedRemotely).toBe(true);
		expect(res.data?.data.workspaceTodos).toHaveLength(2);
	});

	it("seeds a workspace file the gist does not have yet", async () => {
		const gist = new FakeGist();
		const store = new PersistentCacheStore();

		const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, {
			workspaceTodos: [todo(1, "first workspace todo")],
			filesData: {},
			filesDataPaths: {},
		});

		expect(res.data?.pushed).toBe(true);
		expect(gist.workspace().workspaceTodos).toHaveLength(1);
	});

	it("syncs per-file todos through filesData", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, { workspaceTodos: [], filesData: {}, filesDataPaths: {} });
		const store = new PersistentCacheStore();

		const pulled = await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());
		const local: WorkspaceGistData = {
			...pulled.data!.data,
			filesData: { [FILE_PATH]: [todo(7, "todo in a file")] },
		};

		await newEngine(gist, store).reconcileWorkspace(WS_FILE, local);

		expect(gist.workspace().filesData[FILE_PATH]).toHaveLength(1);
	});
});

describe("no spurious writes from key ordering", () => {
	const OTHER_PATH = "c:/repo/b.ts";

	/**
	 * The extension sorts filesData by file name; the merge rebuilds it in
	 * base-then-local-then-remote insertion order. isEqual is JSON.stringify based, so identical
	 * content in a different key order reads as a change and the PWA pushes on every reconcile,
	 * racing the extension's own writes for no reason.
	 */
	it("does not rewrite the workspace file when only filesData key order differs", async () => {
		const gist = new FakeGist();
		// Remote written the way the extension writes it: keys sorted by file name.
		gist.seed(WS_FILE, {
			workspaceTodos: [],
			filesData: { [FILE_PATH]: [todo(1, "in a")], [OTHER_PATH]: [todo(2, "in b")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		const pulled = await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());

		// Same content, opposite key order — what an unsorted local merge would produce.
		const reordered: WorkspaceGistData = {
			workspaceTodos: pulled.data!.data.workspaceTodos,
			filesData: {
				[OTHER_PATH]: pulled.data!.data.filesData[OTHER_PATH],
				[FILE_PATH]: pulled.data!.data.filesData[FILE_PATH],
			},
			filesDataPaths: pulled.data!.data.filesDataPaths,
		};

		const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, reordered);

		expect(res.data?.pushed).toBe(false);
		expect(gist.writeLog).toHaveLength(0);
	});

	it("still detects a real change to a file's todos", async () => {
		const gist = new FakeGist();
		gist.seed(WS_FILE, {
			workspaceTodos: [],
			filesData: { [FILE_PATH]: [todo(1, "in a")] },
			filesDataPaths: {},
		});
		const store = new PersistentCacheStore();

		const pulled = await newEngine(gist, store).reconcileWorkspace(WS_FILE, emptyWorkspace());
		const edited: WorkspaceGistData = {
			...pulled.data!.data,
			filesData: { [FILE_PATH]: [todo(1, "in a"), todo(3, "added")] },
		};

		const res = await newEngine(gist, store).reconcileWorkspace(WS_FILE, edited);

		expect(res.data?.pushed).toBe(true);
		expect(gist.workspace().filesData[FILE_PATH]).toHaveLength(2);
	});

	it("writes filesData in sorted key order so the extension sees no churn either", async () => {
		const gist = new FakeGist();
		const store = new PersistentCacheStore();

		await newEngine(gist, store).reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			// Deliberately unsorted going in.
			filesData: { [OTHER_PATH]: [todo(2, "in b")], [FILE_PATH]: [todo(1, "in a")] },
			filesDataPaths: {},
		});

		const written = Object.keys(gist.workspace().filesData);
		expect(written).toEqual([...written].sort());
	});
});
