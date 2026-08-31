import * as assert from "assert";
import { mergeFilesData } from "../../../sync/ThreeWayMerge";
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
