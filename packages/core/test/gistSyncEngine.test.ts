import { describe, it, expect } from "vitest";
import {
	GistSyncEngine,
	GistFileIO,
	MemoryCacheStore,
	GlobalGistData,
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
