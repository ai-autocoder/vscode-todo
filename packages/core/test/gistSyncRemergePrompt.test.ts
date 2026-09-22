/**
 * The mid-flight re-merge asks the user too.
 *
 * `reconcileWithLocalEdits` folds a finished reconcile into local state that moved on while the
 * reconcile was on the network. It runs a second three-way merge, and that merge can conflict —
 * a todo the user edited mid-flight that the reconcile was also changing. Both of those versions
 * are the user's, so settling it behind their back is the same silent overwrite the
 * {@link ConflictResolver} exists to prevent: the PWA showed a dialog for the reconcile's own
 * conflicts and then quietly kept local for this one.
 *
 * The one thing that cannot work here is cancelling. By the time this merge runs the gist has
 * been written and the baseline moved, so there is no write to call off; declining degrades to
 * "not now" — the policy settles it and the caller records it for review.
 */

import { describe, expect, it } from "vitest";
import {
	ConflictDecisions,
	ConflictResolver,
	ConflictSet,
	GistSyncEngine,
	MemoryCacheStore,
} from "../src/index";
import { GlobalGistData, WorkspaceGistData } from "../src/syncTypes";
import { Todo } from "../src/todoTypes";

const todo = (id: number, text: string, extra: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2026-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...extra,
});

/** The engine never reaches the network on these paths, so the client can refuse everything. */
const deadClient = {
	readFile: async () => ({ success: false as const, error: undefined }),
	writeFile: async () => ({ success: false as const, error: undefined }),
};

function makeEngine(resolver?: ConflictResolver): GistSyncEngine {
	return new GistSyncEngine({
		client: deadClient,
		gistId: "g",
		cacheStore: new MemoryCacheStore(),
		conflictResolver: resolver,
	});
}

/**
 * One todo, edited two ways since the snapshot: the reconcile brought down the other device's
 * text, and the user retyped it here while that was in flight.
 */
const snapshot: GlobalGistData = { userTodos: [todo(1, "base")] };
const reconciled: GlobalGistData = { userTodos: [todo(1, "from the other device")] };
const currentLocal: GlobalGistData = { userTodos: [todo(1, "typed mid-flight")] };

describe("mid-flight re-merge conflicts", () => {
	it("asks the resolver instead of silently applying the policy", async () => {
		const seen: ConflictSet[] = [];
		const engine = makeEngine(async ({ todos }) => {
			seen.push(...todos);
			return { todos: new Map() };
		});

		await engine.reconcileWithLocalEdits(snapshot, reconciled, currentLocal);

		expect(seen).toHaveLength(1);
		expect(seen[0].todoId).toBe(1);
		expect(seen[0].conflictType).toBe("edit-edit");
		// Both versions are offered, so the dialog can show what it is choosing between.
		expect(seen[0].local!.text).toBe("typed mid-flight");
		expect(seen[0].remote!.text).toBe("from the other device");
	});

	it("applies the side the user picked", async () => {
		const engine = makeEngine(async () => ({
			todos: new Map([[1, todo(1, "from the other device")]]),
		}));

		const { data } = await engine.reconcileWithLocalEdits(snapshot, reconciled, currentLocal);

		// Without the prompt this path always kept local; the whole point is that it no longer does.
		expect(data.userTodos[0].text).toBe("from the other device");
	});

	it("falls back to the policy when the resolver declines, rather than aborting", async () => {
		// A hidden page, or a dismissed dialog. The reconcile has already written, so there is
		// nothing to call off — this must resolve, not throw.
		const engine = makeEngine(async () => null);

		const { data, conflicts } = await engine.reconcileWithLocalEdits(
			snapshot,
			reconciled,
			currentLocal
		);

		expect(data.userTodos[0].text).toBe("typed mid-flight");
		// Still reported, so the caller can put it on its review screen.
		expect(conflicts).toHaveLength(1);
	});

	it("still reports a conflict the user settled, so the caller can tell them apart", async () => {
		const engine = makeEngine(async () => ({ todos: new Map([[1, todo(1, "picked")]]) }));

		const { conflicts } = await engine.reconcileWithLocalEdits(snapshot, reconciled, currentLocal);

		// The engine reports every conflict it saw; filtering the decided ones out is the caller's
		// job, since only it knows which ids the dialog came back with.
		expect(conflicts).toHaveLength(1);
	});

	it("needs no resolver: without one the policy settles it exactly as before", async () => {
		const engine = makeEngine();

		const { data } = await engine.reconcileWithLocalEdits(snapshot, reconciled, currentLocal);

		expect(data.userTodos[0].text).toBe("typed mid-flight");
	});

	it("asks once for the workspace todos and the per-file lists together", async () => {
		// Both come out of a single merge, so two prompts would make the user answer half a
		// decision and then the other half.
		let asks = 0;
		let sawTodo = false;
		let sawFile = false;
		const engine = makeEngine(async ({ todos, files }) => {
			asks++;
			sawTodo = todos.length > 0;
			sawFile = files.length > 0;
			return { todos: new Map(), files: new Map() };
		});

		const wsSnapshot: WorkspaceGistData = {
			workspaceTodos: [todo(1, "base")],
			filesData: { "a.ts": [todo(2, "base note")] },
			filesDataPaths: {},
		};
		const wsReconciled: WorkspaceGistData = {
			workspaceTodos: [todo(1, "theirs")],
			filesData: { "a.ts": [todo(2, "their note")] },
			filesDataPaths: {},
		};
		const wsLocal: WorkspaceGistData = {
			workspaceTodos: [todo(1, "mine")],
			filesData: { "a.ts": [todo(2, "my note")] },
			filesDataPaths: {},
		};

		await engine.reconcileWorkspaceWithLocalEdits(wsSnapshot, wsReconciled, wsLocal);

		expect(asks).toBe(1);
		expect(sawTodo).toBe(true);
		expect(sawFile).toBe(true);
	});

	it("applies a workspace decision to the per-file list as well", async () => {
		const decisions: ConflictDecisions = {
			todos: new Map(),
			files: new Map([["a.ts", [todo(2, "their note")]]]),
		};
		const engine = makeEngine(async () => decisions);

		const { data } = await engine.reconcileWorkspaceWithLocalEdits(
			{
				workspaceTodos: [],
				filesData: { "a.ts": [todo(2, "base note")] },
				filesDataPaths: {},
			},
			{
				workspaceTodos: [],
				filesData: { "a.ts": [todo(2, "their note")] },
				filesDataPaths: {},
			},
			{
				workspaceTodos: [],
				filesData: { "a.ts": [todo(2, "my note")] },
				filesDataPaths: {},
			}
		);

		// The file-level decision used to be dropped here: this path passed no decisions to
		// `resolveFiles` at all, so the policy kept local whatever the user said.
		expect(data.filesData!["a.ts"][0].text).toBe("their note");
	});
});
