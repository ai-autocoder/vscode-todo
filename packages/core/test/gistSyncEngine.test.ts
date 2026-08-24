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

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

/** In-memory stand-in for the gist: filename -> raw JSON content. */
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

	/** Simulate an edit made by the VS Code extension directly on the remote. */
	setRemote(data: GlobalGistData): void {
		this.files.set(FILE, serialize(data));
	}
}

const makeEngine = (gist: FakeGist) =>
	new GistSyncEngine({ client: gist, gistId: GIST_ID, cacheStore: new MemoryCacheStore() });

describe("GistSyncEngine.reconcileUser", () => {
	it("seeds the gist file when it does not exist yet", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "hello")] });

		expect(res.success).toBe(true);
		expect(res.data?.pushed).toBe(true);
		expect(gist.files.has(FILE)).toBe(true);
		expect(JSON.parse(gist.files.get(FILE)!).userTodos).toHaveLength(1);
	});

	it("is a no-op when nothing changed since the last sync", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "hello")] };

		await engine.reconcileUser(FILE, local); // seed
		const writesAfterSeed = gist.writes;
		const res = await engine.reconcileUser(FILE, local); // again, unchanged

		expect(res.data?.pushed).toBe(false);
		expect(res.data?.changedRemotely).toBe(false);
		expect(gist.writes).toBe(writesAfterSeed);
	});

	it("pulls a remote-only change", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: GlobalGistData = { userTodos: [todo(1, "hello")] };

		await engine.reconcileUser(FILE, local); // establish baseline
		gist.setRemote({ userTodos: [todo(1, "hello"), todo(2, "from vscode")] });

		const res = await engine.reconcileUser(FILE, local); // local unchanged

		expect(res.data?.changedRemotely).toBe(true);
		expect(res.data?.pushed).toBe(false);
		expect(res.data?.data.userTodos.map((t) => t.id)).toEqual([1, 2]);
	});

	it("pushes a local-only change", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "hello")] }); // baseline
		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "hello"), todo(2, "from phone")] });

		expect(res.data?.pushed).toBe(true);
		expect(JSON.parse(gist.files.get(FILE)!).userTodos).toHaveLength(2);
	});

	it("auto-merges concurrent non-overlapping edits from both sides", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "a"), todo(2, "b")] }); // baseline
		// VS Code edits item 2 on the remote; phone edits item 1 locally.
		gist.setRemote({ userTodos: [todo(1, "a"), todo(2, "b-from-vscode")] });

		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "a-from-phone"), todo(2, "b")] });

		expect(res.success).toBe(true);
		expect(res.data?.conflicts).toHaveLength(0);
		const merged = res.data!.data.userTodos;
		expect(merged.find((t) => t.id === 1)?.text).toBe("a-from-phone");
		expect(merged.find((t) => t.id === 2)?.text).toBe("b-from-vscode");
	});

	it("surfaces an edit-edit conflict and applies prefer-local by default", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "a")] }); // baseline
		gist.setRemote({ userTodos: [todo(1, "a-from-vscode")] });

		const res = await engine.reconcileUser(FILE, { userTodos: [todo(1, "a-from-phone")] });

		expect(res.data?.conflicts).toHaveLength(1);
		expect(res.data?.conflicts[0]).toMatchObject({ todoId: 1, conflictType: "edit-edit" });
		// prefer-local: the phone's text wins, and it is written back to the gist.
		expect(res.data?.data.userTodos[0].text).toBe("a-from-phone");
		expect(JSON.parse(gist.files.get(FILE)!).userTodos[0].text).toBe("a-from-phone");
	});

	it("settles to a no-op on the next reconcile after a merge", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);

		await engine.reconcileUser(FILE, { userTodos: [todo(1, "a")] });
		gist.setRemote({ userTodos: [todo(1, "a"), todo(2, "b")] });
		const merged = (await engine.reconcileUser(FILE, { userTodos: [todo(1, "a")] })).data!.data;

		const res = await engine.reconcileUser(FILE, merged); // feed merged back in
		expect(res.data?.pushed).toBe(false);
		expect(res.data?.changedRemotely).toBe(false);
	});
});

const WS_FILE = "workspace-myproject.json";
/** File paths used as `filesData` keys (computed, so the camelCase lint rule does not apply). */
const A = "src/a.ts";
const B = "src/b.ts";

/** Read the workspace file back off the fake gist. */
const readWs = (gist: FakeGist): WorkspaceGistData => JSON.parse(gist.files.get(WS_FILE)!);

describe("GistSyncEngine.reconcileWorkspace", () => {
	it("round-trips filesData and filesDataPaths through a push", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: WorkspaceGistData = {
			workspaceTodos: [todo(1, "ws task")],
			filesData: { [A]: [todo(10, "fix a")] },
			filesDataPaths: { [A]: { absPaths: ["/repo/src/a.ts"], relPaths: [A] } },
		};

		const res = await engine.reconcileWorkspace(WS_FILE, local);

		expect(res.success).toBe(true);
		const written = readWs(gist);
		expect(written.workspaceTodos).toHaveLength(1);
		expect(written.filesData[A]).toHaveLength(1);
		expect(written.filesDataPaths?.[A].absPaths).toEqual(["/repo/src/a.ts"]);
	});

	it("preserves remote per-file todos when the local side passes them back unchanged", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const seeded: WorkspaceGistData = {
			workspaceTodos: [todo(1, "ws task")],
			filesData: { [A]: [todo(10, "fix a")] },
			filesDataPaths: {},
		};
		await engine.reconcileWorkspace(WS_FILE, seeded); // baseline

		// The PWA edits only workspaceTodos but echoes filesData back as-is.
		const res = await engine.reconcileWorkspace(WS_FILE, {
			...seeded,
			workspaceTodos: [todo(1, "ws task"), todo(2, "from phone")],
		});

		expect(res.data?.data.filesData[A]).toHaveLength(1);
		expect(readWs(gist).filesData[A]).toHaveLength(1);
	});

	it("treats an empty local filesData as a deletion (why the gateway must round-trip it)", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "fix a")] },
			filesDataPaths: {},
		});

		// Regression guard: this is exactly what the gateway used to send.
		const res = await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: {},
			filesDataPaths: {},
		});

		expect(res.data?.data.filesData[A]).toBeUndefined();
	});

	it("pulls a remote per-file edit made by the extension", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "fix a")] },
			filesDataPaths: {},
		};
		await engine.reconcileWorkspace(WS_FILE, local); // baseline

		gist.files.set(
			WS_FILE,
			serialize({
				workspaceTodos: [],
				filesData: { [A]: [todo(10, "fix a"), todo(11, "and b")] },
				filesDataPaths: {},
			})
		);

		const res = await engine.reconcileWorkspace(WS_FILE, local); // local unchanged

		expect(res.data?.changedRemotely).toBe(true);
		expect(res.data?.data.filesData[A].map((t) => t.id)).toEqual([10, 11]);
	});

	it("auto-merges per-file edits made on both sides in different files", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const base: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "fix a")] },
			filesDataPaths: {},
		};
		await engine.reconcileWorkspace(WS_FILE, base); // baseline

		// Extension adds a todo to a different file.
		gist.files.set(
			WS_FILE,
			serialize({
				workspaceTodos: [],
				filesData: { [A]: [todo(10, "fix a")], [B]: [todo(20, "fix b")] },
				filesDataPaths: {},
			})
		);
		// PWA adds one to the file it has open.
		const res = await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "fix a"), todo(12, "from phone")] },
			filesDataPaths: {},
		});

		const merged = res.data!.data.filesData;
		expect(merged[A].map((t) => t.id)).toEqual([10, 12]);
		expect(merged[B].map((t) => t.id)).toEqual([20]);
	});

	it("is a no-op on the second reconcile with unchanged data", async () => {
		const gist = new FakeGist();
		const engine = makeEngine(gist);
		const local: WorkspaceGistData = {
			workspaceTodos: [todo(1, "ws")],
			filesData: { [A]: [todo(10, "fix a")] },
			filesDataPaths: {},
		};

		await engine.reconcileWorkspace(WS_FILE, local);
		const writesAfterSeed = gist.writes;
		const res = await engine.reconcileWorkspace(WS_FILE, local);

		expect(res.data?.pushed).toBe(false);
		expect(res.data?.changedRemotely).toBe(false);
		expect(gist.writes).toBe(writesAfterSeed);
	});
});
