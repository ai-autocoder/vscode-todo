/**
 * Defects found by the September 2026 audit, pinned as executable reproductions.
 *
 * Every `it.fails` here passes today *because* its assertion fails: each one states the correct
 * behaviour and the code does not meet it yet. When a fix lands its test starts failing — flip
 * it to `it` and it becomes the regression test. Each block's comment names the finding, the
 * code at fault and the user-visible consequence. The other plain `it` cases are either
 * controls, showing the scenario is otherwise healthy, or regression tests for fixed findings;
 * each block's comment says which.
 */

/* eslint-disable @typescript-eslint/naming-convention -- filesData is keyed by file path. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
	CacheStore,
	DeviceFlowClient,
	GistCache,
	GistClient,
	GistFileIO,
	GistSyncEngine,
	KeyValueStore,
	SyncErrorType,
	SyncResult,
	Todo,
	WorkspaceGistData,
	mergeFilesData,
	mergeImport,
	parseMarkdownImport,
	serialize,
	todoMutations,
	TodoSliceState,
} from "../src/index";

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

const texts = (todos: Todo[] | undefined) => (todos ?? []).map((t) => t.text);

/** Stores copies, the way the extension's MementoCacheStore and IndexedDB both do. */
class CopyingCacheStore implements CacheStore {
	readonly map = new Map<string, GistCache<unknown>>();
	async load<T>(key: string): Promise<GistCache<T> | undefined> {
		const entry = this.map.get(key);
		return entry ? (JSON.parse(JSON.stringify(entry)) as GistCache<T>) : undefined;
	}
	async save<T>(key: string, cache: GistCache<T>): Promise<void> {
		this.map.set(key, JSON.parse(JSON.stringify(cache)));
	}
}

class FakeGist implements GistFileIO {
	readonly files = new Map<string, string>();
	/** Runs after the write's content has been taken but before the write resolves. */
	onWrite?: () => void;
	async readFile(_g: string, name: string): Promise<SyncResult<string>> {
		if (!this.files.has(name)) {
			return {
				success: false,
				error: { type: SyncErrorType.FileNotFoundError, message: "nf", timestamp: "", retryable: false },
			};
		}
		return { success: true, data: this.files.get(name)! };
	}
	async writeFile(_g: string, name: string, content: string): Promise<SyncResult<unknown>> {
		this.files.set(name, content);
		const hook = this.onWrite;
		this.onWrite = undefined;
		await Promise.resolve();
		hook?.();
		return { success: true, data: {} };
	}
}

// ---------------------------------------------------------------------------------------------
// CRITICAL (C1, fixed) — the baseline could record content that never reached the gist
// ---------------------------------------------------------------------------------------------

describe("AUDIT: baseline must be what was written, not what the caller's object became", () => {
	/**
	 * Regression tests for C1. `pushVerified` serialized `data` for the PATCH, awaited it, and
	 * only then cloned `data` into the baseline. On the "only local changed" path `data` WAS the
	 * caller's object. The extension handed in `cache.data.filesData` — the live memento object —
	 * and `StorageSyncManager`'s per-file persist mutated that object in place
	 * (`filesData[key] = todos`). An edit landing during the PATCH was therefore in the baseline
	 * but not on the gist; the next reconcile read local == base, remote != base, and pulled the
	 * edit away. The engine now reconciles its own copy of the input and parses the baseline from
	 * the bytes it wrote.
	 */
	const WS = "workspace-app.json";
	const P = "/repo/a.ts";

	it("records the written bytes as the baseline even if the input object is mutated mid-write", async () => {
		const gist = new FakeGist();
		const store = new CopyingCacheStore();
		const engine = new GistSyncEngine({ client: gist, gistId: "g", cacheStore: store });
		await engine.reconcileWorkspace(WS, {
			workspaceTodos: [],
			filesData: { [P]: [todo(1, "one")] },
			filesDataPaths: {},
		});

		// A local edit to the per-file list, pushed on the "only local changed" path…
		const snapshot: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: { [P]: [todo(1, "one"), todo(2, "two")] },
			filesDataPaths: {},
		};
		// …while the user adds todo 3 through the same object, as persistSlice used to through
		// the live memento object.
		gist.onWrite = () => {
			snapshot.filesData[P] = [todo(1, "one"), todo(2, "two"), todo(3, "three")];
		};
		await engine.reconcileWorkspace(WS, snapshot);

		const cached = (await store.load<WorkspaceGistData>(`gistCache_workspace_${WS}`))!;
		const onGist = JSON.parse(gist.files.get(WS)!) as WorkspaceGistData;
		expect(cached.lastCleanRemoteData).toEqual(onGist);
	});

	it("does not drop an edit that landed during the write on the next sync", async () => {
		const gist = new FakeGist();
		const store = new CopyingCacheStore();
		const engine = new GistSyncEngine({ client: gist, gistId: "g", cacheStore: store });
		await engine.reconcileWorkspace(WS, { workspaceTodos: [], filesData: { [P]: [todo(1, "one")] }, filesDataPaths: {} });

		const snapshot: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: { [P]: [todo(1, "one"), todo(2, "two")] },
			filesDataPaths: {},
		};
		gist.onWrite = () => {
			snapshot.filesData[P] = [todo(1, "one"), todo(2, "two"), todo(3, "three")];
		};
		await engine.reconcileWorkspace(WS, snapshot);

		// The next sync starts from local state, which holds the edit.
		const next = await engine.reconcileWorkspace(WS, snapshot);
		expect(texts(next.data?.data.filesData[P])).toEqual(["one", "two", "three"]);
	});

	it("control: with an input object nobody mutates, baseline and gist agree", async () => {
		const gist = new FakeGist();
		const store = new CopyingCacheStore();
		const engine = new GistSyncEngine({ client: gist, gistId: "g", cacheStore: store });
		await engine.reconcileWorkspace(WS, { workspaceTodos: [], filesData: { [P]: [todo(1, "one")] }, filesDataPaths: {} });
		await engine.reconcileWorkspace(WS, {
			workspaceTodos: [],
			filesData: { [P]: [todo(1, "one"), todo(2, "two")] },
			filesDataPaths: {},
		});

		const cached = (await store.load<WorkspaceGistData>(`gistCache_workspace_${WS}`))!;
		expect(cached.lastCleanRemoteData).toEqual(JSON.parse(gist.files.get(WS)!));
	});
});

// ---------------------------------------------------------------------------------------------
// HIGH — an import rewrites todos it did not touch
// ---------------------------------------------------------------------------------------------

describe("AUDIT: import normalizes the whole merged list, not just the imported items", () => {
	/**
	 * `processAndMergeTodos` runs `initMissingTodoProperties` over every todo after the merge, so
	 * existing todos gain `collapsed: false` (neither reducer's `addTodo` sets it), have their text
	 * re-trimmed, and so on. The sync merge compares with the canonical `isEqual`, so each such
	 * todo reads as a local edit: an unrelated import turns every todo the other device changed
	 * into an `edit-edit` conflict, and a declined or policy-settled one reverts that change.
	 * The extension's copy in src/todo/importer.ts has the same code.
	 */
	const fromReducers = (): Todo[] => {
		const state: TodoSliceState = { todos: [], lastActionType: "", numberOfTodos: 0, numberOfNotes: 0 };
		const cfg = { createPosition: "bottom" as const, createMarkdownByDefault: false, taskSortingOptions: "sortType1" as const };
		todoMutations.addTodo(state, { text: "one" }, cfg);
		todoMutations.addTodo(state, { text: "two" }, cfg);
		return state.todos;
	};
	const stateWith = (userTodos: Todo[]) => ({ userTodos, workspaceTodos: [], filesData: {}, filesDataPaths: {} });

	it.fails("re-importing the app's own export changes nothing", () => {
		const existing = fromReducers();
		const exported = JSON.parse(JSON.stringify({ user: existing }));

		const result = mergeImport(exported, stateWith(existing));

		expect(result.changed.user).toBe(false);
	});

	it.fails("importing one new todo leaves the existing ones byte-identical", () => {
		const existing = fromReducers();

		const result = mergeImport({ user: [{ text: "brand new" }] }, stateWith(existing));

		expect(result.userTodos.slice(0, 2)).toEqual(existing);
	});

	/**
	 * `isTodo` only checks that a `text` key exists, and `filterValidTodos` then calls
	 * `text.trim()` — so one non-string text anywhere in the file throws a TypeError and the whole
	 * import is rejected with a generic error, instead of that one item being skipped.
	 */
	it.fails("skips an item whose text is not a string instead of throwing", () => {
		const run = () => mergeImport({ user: [{ text: 5 as unknown as string }, { text: "ok" }] }, stateWith([]));
		expect(run).not.toThrow();
	});

	/** Wrong-typed fields are stored as-is: a string "false" renders as completed. */
	it.fails("does not store a string 'false' as a truthy completed flag", () => {
		const result = mergeImport(
			{ user: [{ text: "x", completed: "false" as unknown as boolean }] },
			stateWith([])
		);
		expect(result.userTodos[0].completed).toBe(false);
	});
});

describe("AUDIT: the markdown task matcher is not anchored", () => {
	/**
	 * `\s*\d+. \[[ xX]\] ` has no `^` and an unescaped `.`, so a note that merely contains a
	 * digit, any character, a space and a checkbox is read as a task and the match is cut out of
	 * its text. Same regex in src/todo/importer.ts.
	 */
	it.fails("keeps a line that only mentions a checkbox as a note", () => {
		const parsed = parseMarkdownImport("Pay 5€ [ ] later", "User", "");
		expect(parsed.user?.[0]).toMatchObject({ isNote: true, text: "Pay 5€ [ ] later" });
	});

	it("control: a numbered task is still a task", () => {
		const parsed = parseMarkdownImport("1. [x] done", "User", "");
		expect(parsed.user?.[0]).toMatchObject({ isNote: false, completed: true, text: "done" });
	});
});

// ---------------------------------------------------------------------------------------------
// MEDIUM — merge and client edge cases
// ---------------------------------------------------------------------------------------------

describe("AUDIT: an emptied per-file list and a removed one are the same thing", () => {
	/**
	 * The extension removes a file's key when its last todo goes (StorageSyncManager), the PWA
	 * keeps the key with `[]`. `mergeFilesData` treats the two as different, so both devices
	 * deleting the same todos raises `file-edit-delete` — a conflict prompt where both sides agree.
	 */
	it.fails("does not raise a conflict when one side emptied the list and the other removed it", () => {
		const out = mergeFilesData({ "/a.ts": [todo(1, "a")] }, { "/a.ts": [] }, {});
		expect(out.conflicts).toEqual([]);
	});
});

describe("AUDIT: a gist with more than 300 files", () => {
	afterEach(() => vi.unstubAllGlobals());

	/**
	 * GitHub returns only the first 300 files of a larger gist and sets a top-level `truncated`.
	 * Neither client checks it, so a real file past the cut reads as `FileNotFoundError` — the one
	 * answer the engine treats as "safe to create" — and gets seeded over.
	 */
	it.fails("does not report a file as missing when the gist listing itself is truncated", async () => {
		vi.stubGlobal("fetch", async () =>
			new Response(
				JSON.stringify({ id: "0123456789abcdef0123456789abcdef", truncated: true, files: { "user-aaa.json": { filename: "user-aaa.json", content: "{}", raw_url: "x" } } }),
				{ status: 200 }
			)
		);
		const client = new GistClient({ getToken: () => "t" });

		const res = await client.readFile("0123456789abcdef0123456789abcdef", "user-zzz.json");

		expect(res.error?.type).not.toBe(SyncErrorType.FileNotFoundError);
	});
});

describe("AUDIT: device flow with a missing interval", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	/** `Math.max(1, undefined)` is NaN and `setTimeout(NaN)` fires at once: a tight poll loop. */
	it.fails("waits before polling even when GitHub sends no interval", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return new Response(JSON.stringify({ error: "authorization_pending" }));
		}) as unknown as typeof fetch;
		const client = new DeviceFlowClient({ clientId: "c", proxyBaseUrl: "https://p", fetchImpl });
		const controller = new AbortController();

		void client.pollForToken("dc", undefined as unknown as number, { signal: controller.signal }).catch(() => undefined);
		await vi.advanceTimersByTimeAsync(10);
		controller.abort();

		expect(calls).toBe(0);
	});
});

describe("AUDIT: IndexedDB stores first used together", () => {
	/**
	 * Two handles that both find their store missing both reopen at version N+1; only the first
	 * gets the upgrade, the second caches a connection without its store and fails every call.
	 * Not hit by today's startup, which opens the stores one by one.
	 */
	it.fails("lets two stores that are both missing be created concurrently", async () => {
		const env = { indexedDB: new IDBFactory() };
		await KeyValueStore.open("db", "a", env).set("k", 1);
		const b = KeyValueStore.open("db", "b", env);
		const c = KeyValueStore.open("db", "c", env);

		const results = await Promise.allSettled([b.set("k", 1), c.set("k", 1)]);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
	});
});

describe("AUDIT: two peers' identical deletions reach the gist identically", () => {
	it("control: serialize is stable for the same content regardless of key order", () => {
		expect(serialize({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(serialize({ a: [{ c: 2, d: 1 }], b: 1 }));
	});
});
