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

	// A file conflict is settled by the engine’s policy with no prompt, so anything the policy
	// drops is lost silently. Escalating the whole file made prefer-local store the local array
	// verbatim, discarding every todo the other peer had added to that same file.
	//
	// Same repro both ways round, so neither policy is privileged: only the id both sides edited
	// is the policy’s to decide.
	const stageFileConflict = async (engine: GistSyncEngine, gist: FakeGist) => {
		await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "orig")] },
			filesDataPaths: {},
		}); // baseline

		// The extension renames todo 10 and adds 11 to the same file.
		gist.files.set(
			WS_FILE,
			serialize({
				workspaceTodos: [],
				filesData: { [A]: [todo(10, "renamed in vscode"), todo(11, "added in vscode")] },
				filesDataPaths: {},
			})
		);

		// The phone renames the same todo differently and adds 12 to that file.
		return engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "renamed on phone"), todo(12, "added on phone")] },
			filesDataPaths: {},
		});
	};

	it("keeps both peers’ additions to a file whose todo also conflicts (prefer-local)", async () => {
		const gist = new FakeGist();
		const res = await stageFileConflict(makeEngine(gist), gist);

		expect(res.data?.fileConflicts.map((c) => c.filePath)).toEqual([A]);
		const texts = res.data!.data.filesData[A].map((t) => t.text);
		expect(texts).toContain("renamed on phone"); // prefer-local decides the conflicting id
		expect(texts).not.toContain("renamed in vscode");
		expect(texts).toContain("added on phone");
		expect(texts).toContain("added in vscode"); // the regression: dropped silently before
		// And that is what lands on the gist, not just what the caller is handed back.
		expect(readWs(gist).filesData[A].map((t) => t.text)).toEqual(texts);
	});

	it("keeps both peers’ additions to a file whose todo also conflicts (prefer-remote)", async () => {
		const gist = new FakeGist();
		const engine = new GistSyncEngine({
			client: gist,
			gistId: GIST_ID,
			cacheStore: new MemoryCacheStore(),
			conflictPolicy: "prefer-remote",
		});
		const res = await stageFileConflict(engine, gist);

		const texts = res.data!.data.filesData[A].map((t) => t.text);
		expect(texts).toContain("renamed in vscode");
		expect(texts).not.toContain("renamed on phone");
		expect(texts).toContain("added in vscode");
		expect(texts).toContain("added on phone");
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

describe("cold cache bootstrap (data-loss regression)", () => {
	// A cold cache has no `lastCleanRemoteData`, so there is no observed baseline to diff
	// against. Falling back to the remote as the baseline made `remoteChanged` false while an
	// empty local slice made `localChanged` true, so the engine took the "only local changed"
	// branch and PUSHED the empty slice over populated remote content, destroying it.
	//
	// Reachable in the PWA whenever the cache is cleared while the slices are empty: switching
	// gists (resetForNewGist), disconnect + reconnect, a fresh install, or cleared storage.
	it("does not wipe a populated remote when the local slice is empty and the cache is cold", async () => {
		const gist = new FakeGist();
		gist.setRemote({ userTodos: [todo(1, "written from VS Code"), todo(2, "keep me")] });

		const engine = makeEngine(gist);
		const res = await engine.reconcileUser(FILE, { userTodos: [] });

		expect(res.success).toBe(true);
		expect(gist.writes).toBe(0);
		expect(res.data!.pushed).toBe(false);
		// The remote wins the bootstrap and is handed back to the caller.
		expect(res.data!.data.userTodos.map((t) => t.text)).toEqual([
			"written from VS Code",
			"keep me",
		]);
		expect(res.data!.changedRemotely).toBe(true);
	});

	it("adopts the remote as the baseline so the next reconcile is a no-op", async () => {
		const gist = new FakeGist();
		gist.setRemote({ userTodos: [todo(1, "remote")] });
		const engine = makeEngine(gist);

		const first = await engine.reconcileUser(FILE, { userTodos: [] });
		const second = await engine.reconcileUser(FILE, first.data!.data);

		expect(gist.writes).toBe(0);
		expect(second.data!.pushed).toBe(false);
		expect(second.data!.changedRemotely).toBe(false);
	});

	it("still pushes a genuine local edit made after the bootstrap", async () => {
		const gist = new FakeGist();
		gist.setRemote({ userTodos: [todo(1, "remote")] });
		const engine = makeEngine(gist);

		const boot = await engine.reconcileUser(FILE, { userTodos: [] });
		const edited = { userTodos: [...boot.data!.data.userTodos, todo(2, "from phone")] };
		const res = await engine.reconcileUser(FILE, edited);

		expect(res.data!.pushed).toBe(true);
		expect(gist.writes).toBe(1);
		expect(JSON.parse(gist.files.get(FILE)!).userTodos).toHaveLength(2);
	});

	it("a cold cache with non-empty local still does not clobber a populated remote", async () => {
		// Both sides have content and no shared baseline: this must merge, never overwrite.
		const gist = new FakeGist();
		gist.setRemote({ userTodos: [todo(1, "remote only")] });
		const engine = makeEngine(gist);

		const res = await engine.reconcileUser(FILE, { userTodos: [todo(2, "local only")] });

		expect(res.success).toBe(true);
		const texts = res.data!.data.userTodos.map((t) => t.text).sort();
		expect(texts).toContain("remote only");
		expect(texts).toContain("local only");
	});
});

describe("cold cache bootstrap: workspace filesData", () => {
	// The workspace file carries per-file todo lists in `filesData`. A cold cache with an empty
	// local slice must not read as "the user deleted every per-file list".
	// The dangerous variant: a cold cache where the device DOES hold per-file todos. bootstrap
	// merges against strategy.empty(), so every path both sides hold has an empty base and reads
	// as "added on both sides" — which used to escalate to a whole-file conflict with no per-item
	// substrate, and prefer-local then stored the phone’s array over the extension’s todos.
	//
	// bootstrap’s contract is that with no baseline "both sides read as additions and neither is
	// deleted"; that has to hold for filesData too, not just for the todo arrays.
	it("keeps both sides’ per-file todos when bootstrapping with a populated local workspace", async () => {
		const gist = new FakeGist();
		gist.files.set(
			WS_FILE,
			serialize({
				workspaceTodos: [],
				filesData: { [A]: [todo(5, "written in vscode"), todo(6, "also vscode")] },
				filesDataPaths: {},
			})
		);

		const engine = makeEngine(gist);
		const res = await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: { [A]: [todo(1, "on the phone")] },
			filesDataPaths: {},
		});

		const texts = res.data!.data.filesData[A].map((t) => t.text);
		expect(texts).toContain("on the phone");
		expect(texts).toContain("written in vscode"); // was destroyed by the whole-side resolution
		expect(texts).toContain("also vscode");
		// Nothing is lost on the gist either.
		expect(readWs(gist).filesData[A].map((t) => t.text).sort()).toEqual(texts.slice().sort());
	});

	it("preserves remote filesData when bootstrapping with an empty local workspace", async () => {
		const gist = new FakeGist();
		// Computed key: a literal file-path property trips the camelCase lint rule.
		const readmePath = "c:\\repo\\README.md";
		const remote: WorkspaceGistData = {
			workspaceTodos: [todo(1, "ws task")],
			filesData: { [readmePath]: [todo(2, "per-file task")] },
			filesDataPaths: {},
		};
		gist.files.set(WS_FILE, serialize(remote));

		const engine = makeEngine(gist);
		const res = await engine.reconcileWorkspace(WS_FILE, {
			workspaceTodos: [],
			filesData: {},
			filesDataPaths: {},
		});

		expect(gist.writes).toBe(0);
		expect(res.data!.pushed).toBe(false);
		expect(Object.keys(res.data!.data.filesData)).toEqual([readmePath]);
		expect(res.data!.data.workspaceTodos).toHaveLength(1);
	});
});

/**
 * Two clients, one gist, one conflicting file — does the exchange settle?
 *
 * The resolution's element order depends on which side is `local`, so the two clients settle
 * the same conflict into *different* orders. `isEqual` compares serialized JSON, so a different
 * order reads as a change: if each client kept re-merging and pushing its own order, every poll
 * would rewrite the file forever. This pins that it converges instead.
 *
 * Worth having explicitly because the per-call tests only ever exercise one engine, and
 * `mergeFilesData(x, x, x) === x` makes a single-client "fixed point" assertion vacuous.
 */
describe("two clients converge after a per-file conflict", () => {
	it("stops writing once both have adopted the merge, having lost nothing", async () => {
		const gist = new FakeGist();
		const phone = makeEngine(gist);
		const code = makeEngine(gist);

		// Both start from the same baseline.
		const seed: WorkspaceGistData = {
			workspaceTodos: [],
			filesData: { [A]: [todo(10, "orig")] },
			filesDataPaths: {},
		};
		let phoneLocal = (await phone.reconcileWorkspace(WS_FILE, seed)).data!.data;
		let codeLocal = (await code.reconcileWorkspace(WS_FILE, seed)).data!.data;

		// Each renames todo 10 differently and adds one of its own to the same file.
		phoneLocal = { ...phoneLocal, filesData: { [A]: [todo(10, "phone"), todo(12, "from phone")] } };
		codeLocal = { ...codeLocal, filesData: { [A]: [todo(10, "vscode"), todo(11, "from vscode")] } };

		// Alternate reconciles, each client adopting the merged result as its new local state —
		// which is what the gateway does with what it gets back.
		const writesPerRound: number[] = [];
		for (let round = 0; round < 6; round++) {
			const before = gist.writes;
			if (round % 2 === 0) {
				phoneLocal = (await phone.reconcileWorkspace(WS_FILE, phoneLocal)).data!.data;
			} else {
				codeLocal = (await code.reconcileWorkspace(WS_FILE, codeLocal)).data!.data;
			}
			writesPerRound.push(gist.writes - before);
		}

		// The tail must be quiet: no client still has something to say.
		expect(writesPerRound.slice(-2)).toEqual([0, 0]);

		// Neither addition was lost along the way, and both clients agree on the contents.
		const onGist = readWs(gist).filesData[A].map((t) => t.text);
		expect(onGist).toContain("from phone");
		expect(onGist).toContain("from vscode");
		expect(phoneLocal.filesData[A].map((t) => t.text).sort()).toEqual(onGist.slice().sort());
		expect(codeLocal.filesData[A].map((t) => t.text).sort()).toEqual(onGist.slice().sort());
	});
});
