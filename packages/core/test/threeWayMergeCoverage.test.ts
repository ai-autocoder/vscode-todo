/**
 * The parts of the merge the engine suites reach only indirectly, or not at all: the
 * `filesDataPaths` union, the per-file decision table, `resolveFileConflict`, insertion-index
 * edge cases, and the summary formatters.
 *
 * The `AUDIT:` cases at the bottom pin known defects with `it.fails` — they pass today because
 * the assertion fails, and start failing (flip them to `it`) once the defect is fixed.
 */

import { describe, it, expect } from "vitest";
import {
	threeWayMerge,
	threeWayMergeWorkspace,
	mergeFilesData,
	mergeFilesDataPaths,
	resolveFileConflict,
	assembleMerged,
	formatMergeSummary,
	formatWorkspaceMergeSummary,
	GistSyncEngine,
	GistFileIO,
	MemoryCacheStore,
	SyncErrorType,
	SyncResult,
	serialize,
	Todo,
	TodoFilesData,
} from "../src/index";

const todo = (id: number, text = `t${id}`, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

const ids = (todos: Todo[] | null | undefined): number[] => (todos ?? []).map((t) => t.id);
const texts = (todos: Todo[] | null | undefined): string[] => (todos ?? []).map((t) => t.text);

describe("mergeFilesDataPaths", () => {
	it("unions both sides' aliases, dropping duplicates by normalized path", () => {
		const merged = mergeFilesDataPaths(
			{},
			{ "C:\\repo\\a.ts": { absPaths: ["C:\\repo\\a.ts"], relPaths: ["src/a.ts"] } },
			{
				"C:\\repo\\a.ts": {
					// Same file seen from a POSIX machine and with a different drive-letter case.
					absPaths: ["c:/repo/a.ts", "/home/me/repo/a.ts"],
					relPaths: ["./src/a.ts", "src\\a.ts", "lib/../src/a.ts"],
				},
			}
		);

		expect(merged["C:\\repo\\a.ts"].absPaths).toEqual(["C:\\repo\\a.ts", "/home/me/repo/a.ts"]);
		expect(merged["C:\\repo\\a.ts"].relPaths).toEqual(["src/a.ts"]);
	});

	it("keeps a key only one side has, and emits keys in sorted order", () => {
		const merged = mergeFilesDataPaths(
			{},
			{ "/z.ts": { absPaths: ["/z.ts"], relPaths: [] } },
			{ "/a.ts": { absPaths: ["/a.ts"], relPaths: ["a.ts"] } }
		);

		expect(Object.keys(merged)).toEqual(["/a.ts", "/z.ts"]);
		expect(merged["/z.ts"]).toEqual({ absPaths: ["/z.ts"], relPaths: [] });
	});

	it("tolerates entries missing either list", () => {
		const merged = mergeFilesDataPaths(
			{},
			{ "/a.ts": { absPaths: ["/a.ts"] } as never },
			{ "/a.ts": { relPaths: ["a.ts"] } as never }
		);

		expect(merged["/a.ts"]).toEqual({ absPaths: ["/a.ts"], relPaths: ["a.ts"] });
	});

	it("treats POSIX paths case-sensitively", () => {
		const merged = mergeFilesDataPaths(
			{},
			{ "/a.ts": { absPaths: ["/repo/A.ts"], relPaths: [] } },
			{ "/a.ts": { absPaths: ["/repo/a.ts"], relPaths: [] } }
		);

		expect(merged["/a.ts"].absPaths).toEqual(["/repo/A.ts", "/repo/a.ts"]);
	});
});

describe("mergeFilesData decision table", () => {
	const base: TodoFilesData = { "/f.ts": [todo(1)] };

	it("takes the remote file when only the remote changed it", () => {
		const out = mergeFilesData(base, base, { "/f.ts": [todo(1, "edited")] });
		expect(texts(out.autoMerged["/f.ts"])).toEqual(["edited"]);
		expect(out.conflicts).toHaveLength(0);
	});

	it("takes the local file when only the local changed it", () => {
		const out = mergeFilesData(base, { "/f.ts": [todo(1), todo(2)] }, base);
		expect(ids(out.autoMerged["/f.ts"])).toEqual([1, 2]);
	});

	it("merges per item when both sides changed the file without touching the same todo", () => {
		const out = mergeFilesData(base, { "/f.ts": [todo(2), todo(1)] }, { "/f.ts": [todo(1), todo(3)] });
		expect(out.conflicts).toHaveLength(0);
		expect(ids(out.autoMerged["/f.ts"])).toEqual([2, 1, 3]);
	});

	it("takes identical changes once", () => {
		const same = { "/f.ts": [todo(1, "same")] };
		const out = mergeFilesData(base, same, same);
		expect(out.conflicts).toHaveLength(0);
		expect(texts(out.autoMerged["/f.ts"])).toEqual(["same"]);
	});

	it("escalates a file-edit-edit conflict carrying its per-item merge", () => {
		const out = mergeFilesData(
			base,
			{ "/f.ts": [todo(1, "local"), todo(2)] },
			{ "/f.ts": [todo(1, "remote"), todo(3)] }
		);

		expect(out.autoMerged["/f.ts"]).toBeUndefined();
		expect(out.conflicts).toHaveLength(1);
		expect(out.conflicts[0].conflictType).toBe("file-edit-edit");
		expect(out.conflicts[0].itemMerge?.conflicts.map((c) => c.todoId)).toEqual([1]);
	});

	it("accepts a remote file deletion when local left the file alone", () => {
		const out = mergeFilesData(base, base, {});
		expect(out.autoMerged).toEqual({});
		expect(out.conflicts).toHaveLength(0);
	});

	it("accepts a local file deletion when the remote left the file alone", () => {
		const out = mergeFilesData(base, {}, base);
		expect(out.autoMerged).toEqual({});
		expect(out.conflicts).toHaveLength(0);
	});

	it("raises file-edit-delete and file-delete-edit, with no per-item substrate", () => {
		const editDelete = mergeFilesData(base, { "/f.ts": [todo(1, "x")] }, {});
		const deleteEdit = mergeFilesData(base, {}, { "/f.ts": [todo(1, "x")] });

		expect(editDelete.conflicts[0].conflictType).toBe("file-edit-delete");
		expect(editDelete.conflicts[0].itemMerge).toBeUndefined();
		expect(deleteEdit.conflicts[0].conflictType).toBe("file-delete-edit");
		expect(deleteEdit.conflicts[0].remote).toEqual([todo(1, "x")]);
	});

	it("merges a file both sides added as two addition sets", () => {
		const out = mergeFilesData({}, { "/n.ts": [todo(1)] }, { "/n.ts": [todo(2)] });
		expect(out.conflicts).toHaveLength(0);
		expect(ids(out.autoMerged["/n.ts"])).toEqual([1, 2]);
	});

	it("escalates file-added-both only for an id collision inside the file", () => {
		const out = mergeFilesData({}, { "/n.ts": [todo(1, "mine")] }, { "/n.ts": [todo(1, "theirs")] });
		expect(out.conflicts[0].conflictType).toBe("file-added-both");
		expect(out.conflicts[0].itemMerge?.conflicts[0].conflictType).toBe("id-collision");
	});

	it("adds a file only one side has", () => {
		const out = mergeFilesData({}, { "/l.ts": [todo(1)] }, { "/r.ts": [todo(2)] });
		expect(Object.keys(out.autoMerged)).toEqual(["/l.ts", "/r.ts"]);
	});

	it("keeps a file emptied on one side distinct from a deleted one", () => {
		const out = mergeFilesData(base, { "/f.ts": [] }, base);
		expect(out.autoMerged["/f.ts"]).toEqual([]);
	});
});

describe("resolveFileConflict", () => {
	it("settles only the conflicting ids, keeping both sides' additions", () => {
		const { conflicts } = mergeFilesData(
			{ "/f.ts": [todo(1)] },
			{ "/f.ts": [todo(1, "local"), todo(2, "local-add")] },
			{ "/f.ts": [todo(1, "remote"), todo(3, "remote-add")] }
		);

		// The remote's addition lands beside its remote neighbour (todo 1), as everywhere else.
		expect(texts(resolveFileConflict(conflicts[0], "local"))).toEqual(["local", "remote-add", "local-add"]);
		expect(texts(resolveFileConflict(conflicts[0], "remote"))).toEqual(["remote", "remote-add", "local-add"]);
	});

	it("drops an item the preferred side deleted", () => {
		const { conflicts } = mergeFilesData(
			{ "/f.ts": [todo(1), todo(2)] },
			// local deleted 1 and edited 2; remote edited 1 and 2 differently
			{ "/f.ts": [todo(2, "local")] },
			{ "/f.ts": [todo(1, "remote"), todo(2, "remote")] }
		);

		expect(texts(resolveFileConflict(conflicts[0], "local"))).toEqual(["local"]);
	});

	it("returns null when the preferred side deleted the whole file", () => {
		const { conflicts } = mergeFilesData({ "/f.ts": [todo(1)] }, {}, { "/f.ts": [todo(1, "x")] });
		expect(resolveFileConflict(conflicts[0], "local")).toBeNull();
		expect(texts(resolveFileConflict(conflicts[0], "remote"))).toEqual(["x"]);
	});
});

describe("threeWayMerge placement", () => {
	it("inserts a remote-only item before its next anchor when the local order swapped the anchors", () => {
		// Remote: A X B. Local reordered to B A. X's previous anchor (A) now sits after its next
		// anchor (B); it must not land past B.
		const res = threeWayMerge(
			[todo(1, "A"), todo(2, "B")],
			[todo(2, "B"), todo(1, "A")],
			[todo(1, "A"), todo(9, "X"), todo(2, "B")]
		);
		expect(texts(res.autoMerged)).toEqual(["X", "B", "A"]);
	});

	it("inserts a remote-only item at the top when its only anchor follows it", () => {
		const res = threeWayMerge([todo(1)], [todo(1)], [todo(9, "X"), todo(1)]);
		expect(texts(res.autoMerged)).toEqual(["X", "t1"]);
	});

	it("appends a remote-only item that has no anchors at all", () => {
		const res = threeWayMerge([todo(1)], [todo(2)], [todo(9, "X")]);
		// local deleted 1 (unchanged remotely → gone), added 2; remote deleted 1, added 9
		expect(texts(res.autoMerged)).toEqual(["t2", "X"]);
	});

	it("gives a delete-edit conflict its remote slot", () => {
		const res = threeWayMerge(
			[todo(1), todo(2), todo(3)],
			[todo(1), todo(3)],
			[todo(1), todo(2, "edited"), todo(3)]
		);
		expect(res.conflicts.map((c) => c.conflictType)).toEqual(["delete-edit"]);
		expect(res.order).toEqual([1, 2, 3]);
		expect(ids(assembleMerged(res, new Map([[2, todo(2, "edited")]])))).toEqual([1, 2, 3]);
	});

	it("keeps a resolver's item for an id the merge never saw", () => {
		const res = threeWayMerge([], [todo(1)], []);
		const out = assembleMerged(res, new Map([[42, todo(42, "stray")]]));
		expect(texts(out)).toEqual(["t1", "stray"]);
	});
});

describe("formatMergeSummary", () => {
	it("counts additions, modifications and deletions against the base", () => {
		const base = [todo(1), todo(2), todo(3)];
		const res = threeWayMerge(base, [todo(1, "edited"), todo(2), todo(4)], base);
		expect(formatMergeSummary(res, base)).toBe("1 added, 1 modified, 1 deleted");
	});

	it("says so when nothing changed", () => {
		const base = [todo(1)];
		expect(formatMergeSummary(threeWayMerge(base, base, base), base)).toBe("No changes");
	});
});

describe("formatWorkspaceMergeSummary", () => {
	it("reports workspace and per-file changes", () => {
		const baseFiles: TodoFilesData = { "/a.ts": [todo(1)], "/b.ts": [todo(2)] };
		const res = threeWayMergeWorkspace(
			[todo(10)],
			[todo(10), todo(11)],
			[todo(10)],
			baseFiles,
			{ "/a.ts": [todo(1, "edited")], "/b.ts": [todo(2)], "/c.ts": [todo(3)], "/d.ts": [todo(4)] },
			baseFiles,
			{},
			{},
			{}
		);
		expect(formatWorkspaceMergeSummary(res, [todo(10)], baseFiles)).toBe(
			"Workspace: 1 added, 2 file(s) added, 1 file(s) modified"
		);
	});

	it("says so when nothing changed", () => {
		const res = threeWayMergeWorkspace([], [], [], {}, {}, {}, {}, {}, {});
		expect(formatWorkspaceMergeSummary(res, [], {})).toBe("No changes");
	});
});

// ---------------------------------------------------------------------------------------------
// AUDIT findings. Each passes today *because* its assertion fails; flip to `it` once fixed.
// ---------------------------------------------------------------------------------------------

class FakeGist implements GistFileIO {
	readonly files = new Map<string, string>();
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
		return { success: true, data: {} };
	}
}

describe("AUDIT: a reorder made only on the other device", () => {
	/**
	 * `threeWayMerge` always builds on the local order. That is right when local reordered, and
	 * a coin-flip when both did — but when only the REMOTE reordered, local's order is just the
	 * stale base order, and using it silently reverts the other device's drag-and-drop. It then
	 * gets pushed, so the other device pulls its own reorder away. Any unrelated local change
	 * (an edit, a completion, an addition) is enough to take this merge path.
	 */
	it.fails("keeps the remote's reorder when local only edited content", async () => {
		const gist = new FakeGist();
		const engine = new GistSyncEngine({ client: gist, gistId: "g", cacheStore: new MemoryCacheStore() });
		await engine.reconcileUser("u.json", { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] });

		// The phone dragged C to the top…
		gist.files.set("u.json", serialize({ userTodos: [todo(3, "C"), todo(1, "A"), todo(2, "B")] }));
		// …while the laptop only edited A's text.
		const res = await engine.reconcileUser("u.json", {
			userTodos: [todo(1, "A-edited"), todo(2, "B"), todo(3, "C")],
		});

		expect(texts(res.data?.data.userTodos)).toEqual(["C", "A-edited", "B"]);
	});

	it.fails("keeps a reorder pulled in by the reconcile when folding a mid-flight edit", async () => {
		const engine = new GistSyncEngine({ client: new FakeGist(), gistId: "g" });
		const snapshot = { userTodos: [todo(1, "A"), todo(2, "B"), todo(3, "C")] };
		const reconciled = { userTodos: [todo(3, "C"), todo(1, "A"), todo(2, "B")] }; // pulled reorder
		const current = { userTodos: [todo(1, "A-edited"), todo(2, "B"), todo(3, "C")] }; // typed meanwhile

		const res = await engine.reconcileWithLocalEdits(snapshot, reconciled, current);

		expect(texts(res.data.userTodos)).toEqual(["C", "A-edited", "B"]);
	});

	it("control: with no local change at all the remote reorder is simply pulled", async () => {
		const gist = new FakeGist();
		const engine = new GistSyncEngine({ client: gist, gistId: "g", cacheStore: new MemoryCacheStore() });
		const start = [todo(1, "A"), todo(2, "B"), todo(3, "C")];
		await engine.reconcileUser("u.json", { userTodos: start });
		gist.files.set("u.json", serialize({ userTodos: [todo(3, "C"), todo(1, "A"), todo(2, "B")] }));

		const res = await engine.reconcileUser("u.json", { userTodos: start });

		expect(texts(res.data?.data.userTodos)).toEqual(["C", "A", "B"]);
	});
});

describe("AUDIT: filesDataPaths never forgets a key", () => {
	/**
	 * `mergeFilesDataPaths` ignores its base, so an alias entry one side removed is re-added from
	 * the other side's unchanged copy, forever. Deleting a file's list removes its `filesData`
	 * entry, but its `filesDataPaths` entry survives every merge: the gist accumulates orphaned
	 * aliases for files that no longer have todos.
	 */
	it.fails("drops an alias entry the local side removed and the remote left unchanged", () => {
		const entry = { "/gone.ts": { absPaths: ["/gone.ts"], relPaths: ["gone.ts"] } };
		const merged = mergeFilesDataPaths(entry, {}, entry);
		expect(merged).toEqual({});
	});
});
