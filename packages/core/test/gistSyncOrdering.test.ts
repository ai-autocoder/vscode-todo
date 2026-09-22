/**
 * Ordering regressions: a *merging* sync must not rebuild the list in the baseline's order.
 *
 * `threeWayMerge` already produces a position-aware `autoMerged` (local order, with remote-only
 * additions spliced next to their remote neighbours). Everything downstream has to preserve that
 * skeleton, or new todos land at the bottom regardless of `createPosition: top` and every
 * drag-and-drop reorder is undone on the next merging sync.
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
	ConflictPolicy,
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

	async readFile(_gistId: string, fileName: string): Promise<SyncResult<string>> {
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

	remoteUser(): GlobalGistData {
		return JSON.parse(this.files.get(FILE)!) as GlobalGistData;
	}
}

const makeEngine = (gist: FakeGist, policy: ConflictPolicy = "prefer-local") =>
	new GistSyncEngine({
		client: gist,
		gistId: GIST_ID,
		cacheStore: new MemoryCacheStore(),
		conflictPolicy: policy,
	});

describe("merging sync preserves list order", () => {
	it("keeps a todo added at the top at the top when both sides changed", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const base = [todo(1, "A"), todo(2, "B"), todo(3, "C")];

		await engine.reconcileUser(FILE, { userTodos: base }); // seed the baseline
		// The other device edited C…
		gist.setRemote({ userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C-edited")] });
		// …while this device added D at the top.
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(4, "D"), todo(1, "A"), todo(2, "B"), todo(3, "C")],
		});

		expect(res.success).toBe(true);
		expect(texts(res.data?.data.userTodos)).toEqual(["D", "A", "B", "C-edited"]);
		expect(texts(gist.remoteUser().userTodos)).toEqual(["D", "A", "B", "C-edited"]);
	});

	it("keeps a local reorder when the remote only edits content", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });
		gist.setRemote({ userTodos: [todo(1, "A"), todo(2, "B-edited"), todo(3, "C")] });
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(3, "C"), todo(1, "A"), todo(2, "B")],
		});

		expect(texts(res.data?.data.userTodos)).toEqual(["C", "A", "B-edited"]);
	});

	it("lands a remote-only addition next to its remote neighbour", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B")] });
		// Remote inserted X between A and B.
		gist.setRemote({ userTodos: [todo(1, "A"), todo(9, "X"), todo(2, "B")] });
		// Local added D at the top.
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(4, "D"), todo(1, "A"), todo(2, "B")],
		});

		expect(texts(res.data?.data.userTodos)).toEqual(["D", "A", "X", "B"]);
	});

	it("keeps the local position of a todo whose conflict is resolved to the remote side", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist, "prefer-remote");

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });
		gist.setRemote({ userTodos: [todo(1, "A"), todo(2, "B-remote"), todo(3, "C")] });
		// Local moved B to the front and edited it too, so B is a genuine edit-edit conflict.
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(2, "B-local"), todo(1, "A"), todo(3, "C")],
		});

		expect(res.data?.conflicts).toHaveLength(1);
		// prefer-remote picks the remote text, but the item stays where the user put it.
		expect(texts(res.data?.data.userTodos)).toEqual(["B-remote", "A", "C"]);
	});

	it("keeps a conflicted todo in place when the local side wins", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });
		gist.setRemote({ userTodos: [todo(1, "A"), todo(2, "B-remote"), todo(3, "C")] });
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(2, "B-local"), todo(1, "A"), todo(3, "C")],
		});

		expect(texts(res.data?.data.userTodos)).toEqual(["B-local", "A", "C"]);
	});

	it("keeps a keep-both copy next to the item it was raised from", async () => {
		const gist = new FakeGist();
		const engine = new GistSyncEngine({
			client: gist,
			gistId: GIST_ID,
			cacheStore: new MemoryCacheStore(),
			conflictResolver: async ({ todos }) => ({
				todos: new Map([[todos[0].todoId, todos[0].local]]),
				extraTodos: new Map([[todos[0].todoId, [todo(99, "X-remote-copy")]]]),
			}),
		});

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A")] });
		// Both sides independently created a todo that drew id 7.
		gist.setRemote({ userTodos: [todo(1, "A"), todo(7, "X-remote")] });
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(7, "X-local"), todo(1, "A")],
		});

		expect(res.data?.conflicts).toHaveLength(1);
		// X-local keeps the position the user gave it, and the copy sits next to it rather than
		// at the bottom of the list where it would read as an unrelated new todo.
		expect(texts(res.data?.data.userTodos)).toEqual(["X-local", "X-remote-copy", "A"]);
	});

	it("converges: a second reconcile on either peer changes nothing", async () => {
		const gist = new FakeGist();
		const a = makeEngine(gist);
		const b = makeEngine(gist);

		await a.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B")] });
		await b.reconcileUser(FILE, { userTodos: [] }); // b bootstraps from the remote

		// a adds at the top, b edits B — both since the shared baseline.
		const afterA = await a.reconcileUser(FILE, {
			userTodos: [todo(4, "D"), todo(1, "A"), todo(2, "B")],
		});
		const afterB = await b.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B-edited")] });

		expect(texts(afterA.data?.data.userTodos)).toEqual(["D", "A", "B"]);
		expect(texts(afterB.data?.data.userTodos)).toEqual(["D", "A", "B-edited"]);

		// a still has to catch up with b's edit; the order must survive that, and settle.
		const settleA = await a.reconcileUser(FILE, afterB.data!.data);
		expect(texts(settleA.data?.data.userTodos)).toEqual(["D", "A", "B-edited"]);

		// From here both peers are on the same baseline: no writes, no order ping-pong.
		const idleA = await a.reconcileUser(FILE, settleA.data!.data);
		const idleB = await b.reconcileUser(FILE, settleA.data!.data);
		expect(texts(idleA.data?.data.userTodos)).toEqual(["D", "A", "B-edited"]);
		expect(texts(idleB.data?.data.userTodos)).toEqual(["D", "A", "B-edited"]);
		expect(idleA.data?.pushed).toBe(false);
		expect(idleB.data?.pushed).toBe(false);
	});

	it("does not duplicate an item when a list holds the same id twice", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A")] });
		gist.setRemote({ userTodos: [todo(1, "A"), todo(5, "R")] });
		// Only a hand-edited gist produces this, but the merge keys by id: without one slot per
		// id the second copy wins both slots and the list carries it twice.
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(1, "A"), todo(9, "dup-one"), { ...todo(9, "dup-two") }],
		});

		const result = texts(res.data?.data.userTodos);
		expect(result.filter((t) => t.startsWith("dup-"))).toHaveLength(1);
		expect(new Set(res.data?.data.userTodos.map((t) => t.id)).size).toBe(
			res.data?.data.userTodos.length
		);
	});

	it("keeps the order of a local-only change (control)", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });
		const res = await engine.reconcileUser(FILE, {
			userTodos: [todo(3, "C"), todo(1, "A"), todo(2, "B")],
		});

		expect(texts(res.data?.data.userTodos)).toEqual(["C", "A", "B"]);
		expect(texts(gist.remoteUser().userTodos)).toEqual(["C", "A", "B"]);
	});
});

describe("mid-flight edits keep their position", () => {
	it("keeps a todo added at the top while a reconcile was on the network", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const snapshot: GlobalGistData = { userTodos: [todo(1, "A"), todo(2, "B")] };
		const reconciled: GlobalGistData = { userTodos: [todo(1, "A"), todo(2, "B")] };
		const currentLocal: GlobalGistData = { userTodos: [todo(4, "D"), todo(1, "A"), todo(2, "B")] };

		const { data } = await engine.reconcileWithLocalEdits(snapshot, reconciled, currentLocal);

		expect(texts(data.userTodos)).toEqual(["D", "A", "B"]);
	});

	it("keeps a mid-flight reorder while folding in what the remote contributed", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const snapshot: GlobalGistData = { userTodos: [todo(1, "A"), todo(2, "B")] };
		const reconciled: GlobalGistData = { userTodos: [todo(1, "A"), todo(2, "B"), todo(5, "R")] };
		const currentLocal: GlobalGistData = { userTodos: [todo(2, "B"), todo(1, "A")] };

		const { data } = await engine.reconcileWithLocalEdits(snapshot, reconciled, currentLocal);

		// The reorder holds, and R keeps the neighbour it has on the remote (it follows B there,
		// so it follows B here) rather than being appended to whatever the local order ends with.
		expect(texts(data.userTodos)).toEqual(["B", "R", "A"]);
	});

	it("keeps a workspace mid-flight addition at the top", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const snapshot: WorkspaceGistData = {
			workspaceTodos: [todo(1, "A"), todo(2, "B")],
			filesData: {},
			filesDataPaths: {},
		};
		const currentLocal: WorkspaceGistData = {
			workspaceTodos: [todo(4, "D"), todo(1, "A"), todo(2, "B")],
			filesData: {},
			filesDataPaths: {},
		};

		const { data } = await engine.reconcileWorkspaceWithLocalEdits(snapshot, snapshot, currentLocal);

		expect(texts(data.workspaceTodos)).toEqual(["D", "A", "B"]);
	});
});

describe("workspace merges preserve order", () => {
	it("keeps a workspace todo added at the top when both sides changed", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const seed: WorkspaceGistData = {
			workspaceTodos: [todo(1, "A"), todo(2, "B")],
			filesData: {},
			filesDataPaths: {},
		};

		await engine.reconcileWorkspace(WS_FILE, seed);
		gist.setRemote(
			{ workspaceTodos: [todo(1, "A"), todo(2, "B-edited")], filesData: {}, filesDataPaths: {} },
			WS_FILE
		);
		const res = await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [todo(4, "D"), todo(1, "A"), todo(2, "B")],
			filesData: {},
			filesDataPaths: {},
		});

		expect(texts(res.data?.data.workspaceTodos)).toEqual(["D", "A", "B-edited"]);
	});

	it("keeps per-file todo order when a file conflict is settled", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const path = "src/app.ts";
		const seed: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: { [path]: [todo(1, "A"), todo(2, "B")] },
			filesDataPaths: {},
		};

		await engine.reconcileWorkspace(WS_FILE, seed);
		gist.setRemote(
			{
				workspaceTodos: [],
				filesData: { [path]: [todo(1, "A"), todo(2, "B-remote")] },
				filesDataPaths: {},
			},
			WS_FILE
		);
		// Local added D at the top of the file's list and edited B differently → file conflict.
		const res = await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: { [path]: [todo(4, "D"), todo(1, "A"), todo(2, "B-local")] },
			filesDataPaths: {},
		});

		expect(res.data?.fileConflicts).toHaveLength(1);
		expect(texts(res.data?.data.filesData?.[path])).toEqual(["D", "A", "B-local"]);
	});
});
