import * as assert from "assert";
import { mergeFilesData, resolveFileConflict } from "../../../core";
import { Todo } from "../../../todo/todoTypes";

/**
 * Per-file merge semantics for the extension's copy of the merge.
 *
 * `mergeFilesData` is duplicated in `packages/core/src/threeWayMerge.ts`, which the PWA runs.
 * The two peers sync the same gist, so they MUST resolve the same situation identically —
 * these tests mirror `packages/core/test/gistSyncConcurrency.test.ts` so a change to one copy
 * that is not made to the other shows up as a failure rather than as divergent behaviour in
 * the field. That matters more here than usual: this half only ships on a Marketplace release,
 * so an unnoticed regression can sit in the tree for weeks.
 *
 * The behaviour being pinned: a file's todo array is merged **per todo**, not as one opaque
 * value. Two people adding a todo to the same file are not in conflict; treating the array
 * atomically made that a `file-edit-edit` conflict whose only resolutions (keep-local /
 * keep-remote) each discarded one side's addition outright.
 */

const filePath = "src/main.ts";

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

const textsOf = (todos: Todo[] | undefined): string[] => (todos ?? []).map((t) => t.text);

suite("mergeFilesData merges per todo, not per file", () => {
	test("keeps additions made to the same file on both sides", () => {
		const result = mergeFilesData(
			{ [filePath]: [todo(1, "shared")] },
			{ [filePath]: [todo(1, "shared"), todo(2, "added in vscode")] },
			{ [filePath]: [todo(1, "shared"), todo(7, "added in pwa")] }
		);

		assert.deepStrictEqual(result.conflicts, [], "non-overlapping additions are not a conflict");
		const merged = textsOf(result.autoMerged[filePath]);
		assert.ok(merged.includes("added in vscode"), "local addition should survive");
		assert.ok(merged.includes("added in pwa"), "remote addition should survive");
		assert.strictEqual(merged.length, 3);
	});

	test("keeps a local addition alongside a remote edit of a different todo", () => {
		const result = mergeFilesData(
			{ [filePath]: [todo(1, "original")] },
			{ [filePath]: [todo(1, "original"), todo(2, "mine")] },
			{ [filePath]: [todo(1, "renamed remotely")] }
		);

		assert.deepStrictEqual(result.conflicts, []);
		const merged = textsOf(result.autoMerged[filePath]);
		assert.ok(merged.includes("renamed remotely"), "remote edit should be applied");
		assert.ok(merged.includes("mine"), "unrelated local addition should survive");
	});

	test("honours a remote deletion while keeping an unrelated local addition", () => {
		const result = mergeFilesData(
			{ [filePath]: [todo(1, "doomed"), todo(2, "kept")] },
			{ [filePath]: [todo(1, "doomed"), todo(2, "kept"), todo(3, "mine")] },
			{ [filePath]: [todo(2, "kept")] }
		);

		assert.deepStrictEqual(result.conflicts, []);
		const merged = textsOf(result.autoMerged[filePath]);
		assert.ok(!merged.includes("doomed"), "remote deletion should be honoured");
		assert.ok(merged.includes("kept"));
		assert.ok(merged.includes("mine"), "unrelated local addition should survive");
	});

	test("still reports a file conflict when the same todo is edited differently on both sides", () => {
		const result = mergeFilesData(
			{ [filePath]: [todo(1, "original")] },
			{ [filePath]: [todo(1, "vscode rename")] },
			{ [filePath]: [todo(1, "pwa rename")] }
		);

		assert.deepStrictEqual(
			result.conflicts.map((c) => c.conflictType),
			["file-edit-edit"],
			"a genuine same-id edit-edit must still escalate to the caller's policy"
		);
		assert.strictEqual(
			result.autoMerged[filePath],
			undefined,
			"a conflicted file is left out of the auto-merged set"
		);
	});

	test("is unchanged when only one side touched the file", () => {
		const remoteOnly = mergeFilesData(
			{ [filePath]: [todo(1, "a")] },
			{ [filePath]: [todo(1, "a")] },
			{ [filePath]: [todo(1, "a"), todo(2, "remote")] }
		);
		assert.deepStrictEqual(remoteOnly.conflicts, []);
		assert.deepStrictEqual(textsOf(remoteOnly.autoMerged[filePath]), ["a", "remote"]);

		const localOnly = mergeFilesData(
			{ [filePath]: [todo(1, "a")] },
			{ [filePath]: [todo(1, "a"), todo(2, "local")] },
			{ [filePath]: [todo(1, "a")] }
		);
		assert.deepStrictEqual(localOnly.conflicts, []);
		assert.deepStrictEqual(textsOf(localOnly.autoMerged[filePath]), ["a", "local"]);
	});

	test("merges independently across files", () => {
		const other = "src/other.ts";
		const result = mergeFilesData(
			{ [filePath]: [todo(1, "a")], [other]: [todo(10, "x")] },
			{ [filePath]: [todo(1, "a"), todo(2, "local")], [other]: [todo(10, "x")] },
			{ [filePath]: [todo(1, "a")], [other]: [todo(10, "x"), todo(11, "remote")] }
		);

		assert.deepStrictEqual(result.conflicts, []);
		assert.ok(textsOf(result.autoMerged[filePath]).includes("local"));
		assert.ok(textsOf(result.autoMerged[other]).includes("remote"));
	});

	test("re-merging an already merged result is a fixed point", () => {
		const base = { [filePath]: [todo(1, "shared")] };
		const first = mergeFilesData(
			base,
			{ [filePath]: [todo(1, "shared"), todo(2, "local")] },
			{ [filePath]: [todo(1, "shared"), todo(7, "remote")] }
		);
		const settled = first.autoMerged;

		// Both sides now hold `settled`; the next reconcile must not keep rewriting the file.
		const second = mergeFilesData(settled, settled, settled);
		assert.deepStrictEqual(second.conflicts, []);
		assert.deepStrictEqual(
			textsOf(second.autoMerged[filePath]),
			textsOf(settled[filePath]),
			"a settled file should merge to itself, or every reconcile would push a no-op write"
		);
	});
});

/**
 * How a file conflict is settled once it has escalated.
 *
 * A file conflict is decided by policy — the modal's "Keep Local Files" / "Keep Remote Files",
 * or the PWA engine's default — and the user never sees the individual todos, so whatever the
 * decision drops is gone with no dialog and no way back. Escalation used to hand the caller the
 * raw local/remote arrays, and storing the winning one discarded every todo the other side had
 * added to that same file.
 *
 * The conflict now carries the per-item merge it escalated from, and `resolveFileConflict`
 * settles only the ids that genuinely conflict against that substrate.
 *
 * Mirrors `describe("resolveFileConflict settles only the conflicting todos")` in
 * `packages/core/test/gistSyncConcurrency.test.ts`.
 */
suite("resolveFileConflict settles only the conflicting todos", () => {
	/** id 1 renamed differently on both sides, plus an unrelated addition on each side. */
	const conflicted = () =>
		mergeFilesData(
			{ [filePath]: [todo(1, "orig")] },
			{ [filePath]: [todo(1, "vscode rename"), todo(2, "added in vscode")] },
			{ [filePath]: [todo(1, "pwa rename"), todo(7, "added in pwa")] }
		).conflicts[0];

	test("escalates with the per-item merge attached", () => {
		const conflict = conflicted();
		assert.strictEqual(conflict.conflictType, "file-edit-edit");
		// Only id 1 is the policy's to decide; the two additions already settled on their own.
		assert.deepStrictEqual(
			conflict.itemMerge?.conflicts.map((c) => c.todoId),
			[1]
		);
		// Id 1 holds a slot in `order` even though nothing has settled it yet, so the PWA's
		// addition anchors after it — the same placement it would get if id 1 had merged cleanly.
		assert.deepStrictEqual(conflict.itemMerge?.order, [1, 7, 2]);
		assert.deepStrictEqual(textsOf(conflict.itemMerge?.autoMerged), [
			"added in pwa",
			"added in vscode",
		]);
	});

	test("keeps both sides' additions when the local side is preferred", () => {
		const texts = textsOf(resolveFileConflict(conflicted(), "local") ?? undefined);
		assert.ok(texts.includes("vscode rename"), "the policy's call on the conflicting id");
		assert.ok(!texts.includes("pwa rename"));
		assert.ok(texts.includes("added in vscode"));
		assert.ok(texts.includes("added in pwa"), "the regression: silently dropped before");
	});

	test("keeps both sides' additions when the remote side is preferred", () => {
		const texts = textsOf(resolveFileConflict(conflicted(), "remote") ?? undefined);
		assert.ok(texts.includes("pwa rename"));
		assert.ok(!texts.includes("vscode rename"));
		assert.ok(texts.includes("added in pwa"));
		assert.ok(texts.includes("added in vscode"), "the regression: silently dropped before");
	});

	test("honours a deletion made by the preferred side", () => {
		// Local renamed id 1 while remote deleted it and added another todo: an edit-delete
		// inside the file, which escalates the file just the same.
		const conflict = mergeFilesData(
			{ [filePath]: [todo(1, "orig"), todo(2, "kept")] },
			{ [filePath]: [todo(1, "vscode rename"), todo(2, "kept")] },
			{ [filePath]: [todo(2, "kept"), todo(7, "added in pwa")] }
		).conflicts[0];

		const texts = textsOf(resolveFileConflict(conflict, "remote") ?? undefined);
		assert.ok(!texts.includes("vscode rename"), "the remote deletion stands");
		assert.ok(texts.includes("kept"));
		assert.ok(texts.includes("added in pwa"));
	});

	test("takes the whole preferred side when there is no per-item substrate", () => {
		// The file itself was deleted remotely while edited locally: nothing to merge per item.
		const conflict = mergeFilesData(
			{ [filePath]: [todo(1, "orig")] },
			{ [filePath]: [todo(1, "vscode rename")] },
			{}
		).conflicts[0];

		assert.strictEqual(conflict.conflictType, "file-edit-delete");
		assert.strictEqual(conflict.itemMerge, undefined);
		assert.deepStrictEqual(textsOf(resolveFileConflict(conflict, "local") ?? undefined), [
			"vscode rename",
		]);
		// Nothing on the remote side, so preferring remote means accepting the deletion.
		assert.strictEqual(resolveFileConflict(conflict, "remote"), null);
	});

	test("a resolution becomes a clean base for the next reconcile", () => {
		// mergeFilesData(x, x, x) returns x for any x, so asserting that proves nothing. What
		// matters is that once the resolution is on the gist it behaves as an ordinary base: the
		// next edit merges into it without re-conflicting on the id that was settled.
		const settled = resolveFileConflict(conflicted(), "local")!;
		const next = mergeFilesData(
			{ [filePath]: settled },
			{ [filePath]: [...settled, todo(9, "added later")] },
			{ [filePath]: settled }
		);

		assert.deepStrictEqual(next.conflicts, [], "the settled id must not conflict again");
		assert.deepStrictEqual(textsOf(next.autoMerged[filePath]), [
			...textsOf(settled),
			"added later",
		]);
	});
});

/**
 * The same data loss as above, on the other branch that has a per-item substrate.
 *
 * A file path absent from the base but present on both sides is `file-added-both`, and it used
 * to escalate with no substrate at all — so resolution took one whole side and destroyed the
 * other's todos for that file. "Added on both sides" is not a conflict: the base is simply
 * empty, which is exactly what a three-way merge of two addition sets handles.
 *
 * This is the more reachable half of the bug. Both peers merge against an empty base whenever
 * they have no clean baseline — `SyncManager`'s "first time with new code" branch, and the
 * PWA engine's `bootstrap` — so on a cold cache EVERY file path both sides hold took it.
 *
 * Mirrors `describe("mergeFilesData merges a file added on both sides")` in
 * `packages/core/test/gistSyncConcurrency.test.ts`.
 */
suite("mergeFilesData merges a file added on both sides", () => {
	test("keeps both sides' todos instead of escalating", () => {
		const result = mergeFilesData(
			{},
			{ [filePath]: [todo(2, "added in vscode")] },
			{ [filePath]: [todo(7, "added in pwa")] }
		);

		// Disjoint additions to a file neither side had before: nothing to resolve.
		assert.deepStrictEqual(result.conflicts, []);
		const texts = textsOf(result.autoMerged[filePath]);
		assert.ok(texts.includes("added in vscode"), "local addition should survive");
		assert.ok(texts.includes("added in pwa"), "remote addition should survive");
	});

	test("escalates with a substrate when the two sides really do collide on an id", () => {
		// Same id, different text, and neither side has a base version: an id-collision.
		const result = mergeFilesData(
			{},
			{ [filePath]: [todo(1, "vscode text"), todo(2, "added in vscode")] },
			{ [filePath]: [todo(1, "pwa text"), todo(7, "added in pwa")] }
		);

		assert.deepStrictEqual(
			result.conflicts.map((c) => c.conflictType),
			["file-added-both"]
		);
		const conflict = result.conflicts[0];
		assert.deepStrictEqual(
			conflict.itemMerge?.conflicts.map((c) => c.conflictType),
			["id-collision"]
		);

		// Whichever way the policy falls, only id 1 is decided by it.
		const local = textsOf(resolveFileConflict(conflict, "local") ?? undefined);
		assert.ok(local.includes("vscode text"));
		assert.ok(!local.includes("pwa text"));
		assert.ok(local.includes("added in vscode"));
		assert.ok(local.includes("added in pwa"));

		const remote = textsOf(resolveFileConflict(conflict, "remote") ?? undefined);
		assert.ok(remote.includes("pwa text"));
		assert.ok(!remote.includes("vscode text"));
		assert.ok(remote.includes("added in vscode"));
		assert.ok(remote.includes("added in pwa"));
	});
});
