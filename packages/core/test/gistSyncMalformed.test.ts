/**
 * An unreadable gist file must never be read as "the other device deleted everything".
 *
 * The parsers used to map invalid JSON, a wrong top-level shape and an empty file all to an
 * empty list, which the engine cannot distinguish from a genuine deletion — so it synced the
 * deletion, and with local edits in play it pushed the survivors *over* the broken file. These
 * tests pin the opposite: abort before any merge or write, leave cache and baseline untouched,
 * and resume normally once the file is readable again.
 */

import { describe, it, expect } from "vitest";
import {
	GistSyncEngine,
	GistFileIO,
	MemoryCacheStore,
	GlobalGistData,
	WorkspaceGistData,
	SyncErrorType,
	SyncResult,
	serialize,
	Todo,
} from "../src/index";

const GIST_ID = "0123456789abcdef0123456789abcdef";
const FILE = "user-todos.json";
const WS_FILE = "workspace-todos.json";

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

const texts = (todos: Todo[] | undefined): string[] => (todos ?? []).map((t) => t.text);

class FakeGist implements GistFileIO {
	readonly files = new Map<string, string>();
	writes = 0;
	reads = 0;
	/** Raw content served instead of the stored file once `reads` passes `breakFromRead`. */
	private breakFromRead = Number.POSITIVE_INFINITY;
	private brokenRaw = "{ not json";

	async readFile(_gistId: string, fileName: string): Promise<SyncResult<string>> {
		this.reads++;
		if (this.reads > this.breakFromRead) {
			return { success: true, data: this.brokenRaw };
		}
		if (!this.files.has(fileName)) {
			return {
				success: false,
				error: { type: SyncErrorType.FileNotFoundError, message: "not found", timestamp: "", retryable: false },
			};
		}
		return { success: true, data: this.files.get(fileName)! };
	}

	async writeFile(_gistId: string, fileName: string, content: string): Promise<SyncResult<unknown>> {
		this.writes++;
		this.files.set(fileName, content);
		return { success: true, data: {} };
	}

	setRemote(data: GlobalGistData | WorkspaceGistData, fileName = FILE): void {
		this.files.set(fileName, serialize(data));
	}

	/** Put arbitrary (possibly unparseable) bytes in the file, as a hand edit on github.com would. */
	setRaw(raw: string, fileName = FILE): void {
		this.files.set(fileName, raw);
	}

	/** Serve `raw` from the n-th read onwards (1-based), simulating a mid-flight corruption. */
	breakAfter(reads: number, raw = "{ not json"): void {
		this.breakFromRead = reads;
		this.brokenRaw = raw;
	}
}

const makeEngine = (gist: FakeGist, store = new MemoryCacheStore()) =>
	new GistSyncEngine({ client: gist, gistId: GIST_ID, cacheStore: store });

const expectUnreadableFailure = (res: SyncResult<unknown>, fileName = FILE) => {
	expect(res.success).toBe(false);
	// Not a ValidationError: that one is GitHub rejecting what we sent, which has a different
	// recovery. This is the file on GitHub being damaged.
	expect(res.error?.type).toBe(SyncErrorType.CorruptDataError);
	expect(res.error?.retryable).toBe(false);
	// The message has to name the file, or the user cannot tell which gist file to go and fix.
	expect(res.error?.message).toContain(fileName);
};

describe("an unreadable user file aborts the sync instead of syncing a deletion", () => {
	it("fails without touching local data when nothing changed locally", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "A"), todo(2, "B")] };

		await engine.reconcileUser(FILE, local); // seed
		const writesAfterSeed = gist.writes;
		gist.setRaw("{ not json");

		const res = await engine.reconcileUser(FILE, local);

		expectUnreadableFailure(res);
		expect(gist.writes).toBe(writesAfterSeed);
		// The cached copy still holds the todos, so a reload does not come back empty.
		expect(texts((await engine.loadCachedUser(FILE))?.userTodos)).toEqual(["A", "B"]);
	});

	it("does not push the survivors over the broken file when there are local edits", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });
		gist.setRaw("{ not json");

		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(1, "A"), todo(2, "B-edited"), todo(3, "C")],
		});

		expectUnreadableFailure(res);
		// Whatever is in the file is still exactly what was there — the user can recover it from
		// the gist's revision history.
		expect(gist.files.get(FILE)).toBe("{ not json");
	});

	it("rejects valid JSON of the wrong shape", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "A"), todo(2, "B")] };

		await engine.reconcileUser(FILE, local);
		gist.setRaw(JSON.stringify({ todos: [todo(1, "A")] }));

		expectUnreadableFailure(await engine.reconcileUser(FILE, local));
	});

	it("rejects a file that holds only whitespace", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "A")] };

		await engine.reconcileUser(FILE, local);
		// Neither peer can write this — both clients refuse empty content — so it is damage,
		// not an empty list.
		gist.setRaw("   \n  ");

		expectUnreadableFailure(await engine.reconcileUser(FILE, local));
	});

	it("rejects a list holding an item without a usable id", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "A")] };

		await engine.reconcileUser(FILE, local);
		// The merge is keyed by id: an item without one silently collapses into another.
		gist.setRaw(JSON.stringify({ userTodos: [{ text: "no id", completed: false }] }));

		expectUnreadableFailure(await engine.reconcileUser(FILE, local));
	});

	it("still accepts a todo whose id is a string", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "A")] };

		await engine.reconcileUser(FILE, local);
		// The import path used to let a truthy non-numeric id through, so files written by older
		// builds hold these (it no longer mints them). A string keys the merge just as well, and
		// rejecting one would strand the sync for good: the same todo is in local state, so
		// restoring the file would only push it back out.
		gist.setRaw(JSON.stringify({ userTodos: [todo(1, "A"), { ...todo(0, "B"), id: "abc" }] }));

		const res = await engine.reconcileUser(FILE, local);

		expect(res.success).toBe(true);
		expect(texts(res.data?.data.userTodos)).toEqual(["A", "B"]);
	});

	it("rejects a list that is not an array", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "A")] };

		await engine.reconcileUser(FILE, local);
		gist.setRaw(JSON.stringify({ userTodos: { "1": todo(1, "A") } }));

		expectUnreadableFailure(await engine.reconcileUser(FILE, local));
	});

	it("leaves the baseline intact, so the next readable sync merges normally", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B")] });
		gist.setRaw("{ not json");
		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B")] });

		// Someone restores the file from the gist's revision history, with an extra todo.
		gist.setRemote({ userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });
		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B")] });

		expect(res.success).toBe(true);
		// A preserved baseline makes this a plain remote-only change: pulled, not merged, and
		// certainly not read as a local deletion of C.
		expect(res.data?.changedRemotely).toBe(true);
		expect(res.data?.pushed).toBe(false);
		expect(texts(res.data?.data.userTodos)).toEqual(["A", "B", "C"]);
	});

	it("fails on a cold cache rather than adopting an empty list", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		gist.setRaw("{ not json");

		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "A")] });

		expectUnreadableFailure(res);
		expect(gist.writes).toBe(0);
		expect(gist.files.get(FILE)).toBe("{ not json");
	});

	it("does not write when the file goes unreadable inside the write window", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B")] });
		const writesAfterSeed = gist.writes;
		const readsAfterSeed = gist.reads;
		// The reconcile's own read succeeds; the verifying re-read comes back broken.
		gist.breakAfter(readsAfterSeed + 1);

		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")],
		});

		expectUnreadableFailure(res);
		expect(gist.writes).toBe(writesAfterSeed);
	});

	it("does not seed over a file whose content it cannot read", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		// First read: absent. The re-read that guards against a peer creating the file returns
		// content we cannot parse — which is not permission to overwrite it.
		gist.breakAfter(1);

		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "A")] });

		expectUnreadableFailure(res);
		expect(gist.writes).toBe(0);
	});
});

describe("an unreadable workspace file aborts the sync", () => {
	const wsData = (todos: Todo[]): WorkspaceGistData => ({
		workspaceTodos: todos,
		filesData: {},
		filesDataPaths: {},
	});

	it("fails on invalid JSON instead of deleting every workspace todo", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local = wsData([todo(1, "A")]);

		await engine.reconcileWorkspace(WS_FILE, local);
		gist.setRaw("{ not json", WS_FILE);

		const res = await engine.reconcileWorkspace(WS_FILE, local);

		expectUnreadableFailure(res, WS_FILE);
		expect(gist.files.get(WS_FILE)).toBe("{ not json");
	});

	it("rejects a wrong-shaped workspace file", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local = wsData([todo(1, "A")]);

		await engine.reconcileWorkspace(WS_FILE, local);
		gist.setRaw(JSON.stringify({ todos: [] }), WS_FILE);

		expectUnreadableFailure(await engine.reconcileWorkspace(WS_FILE, local), WS_FILE);
	});

	it("rejects a malformed per-file list", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local = wsData([todo(1, "A")]);

		await engine.reconcileWorkspace(WS_FILE, local);
		gist.setRaw(
			JSON.stringify({ workspaceTodos: [], filesData: { "src/app.ts": "not a list" } }),
			WS_FILE
		);

		expectUnreadableFailure(await engine.reconcileWorkspace(WS_FILE, local), WS_FILE);
	});

	it("still accepts a workspace file with no filesData key", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local = wsData([todo(1, "A")]);

		await engine.reconcileWorkspace(WS_FILE, local);
		// Hand-edited or written by an older build: the key is simply absent, which is not damage.
		gist.setRaw(JSON.stringify({ workspaceTodos: [todo(1, "A"), todo(2, "B")] }), WS_FILE);

		const res = await engine.reconcileWorkspace(WS_FILE, local);

		expect(res.success).toBe(true);
		expect(texts(res.data?.data.workspaceTodos)).toEqual(["A", "B"]);
	});
});
