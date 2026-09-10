/**
 * The extension and the PWA must agree on what changed.
 *
 * This is the regression suite for the bug that made two-device editing unreliable. The
 * extension's `isEqual` used to be `JSON.stringify(a) === JSON.stringify(b)`, which is sensitive
 * to object *key* order, while the PWA writes the gist through the shared `serialize()`, which
 * emits keys in sorted order. The two therefore disagreed about identical content:
 *
 *  - `hasRemoteChanges` fired after every push from the other device, even a push that changed
 *    nothing in this list, so the extension downloaded over local state that was not dirty;
 *  - inside the three-way merge, todos nobody had touched were reported as modified, so a local
 *    edit to todo A collided with the *unchanged* remote copy of A and raised an `edit-edit`
 *    conflict whose REMOTE column was simply A's old text. That is the "conflict dialog with the
 *    wrong remote values" symptom.
 *
 * The key orders below are not hypothetical. The extension's reducers build a todo as
 * `{id, text, completed, creationDate, isMarkdown, isNote}` (see `addTodo` in todo/store.ts) and
 * Immer appends `completionDate` last when a task is ticked off, so neither is in sorted order.
 * These tests pin that the comparison and the merge both look through key order — via the
 * SHARED implementations, which is the only way the two peers can stay in step.
 */

import * as assert from "assert";
import { isEqual } from "../../todo/todoUtils";
import { serialize, threeWayMerge } from "../../core";
import { Todo } from "../../todo/todoTypes";

/** A todo in the exact key order the extension's `addTodo` reducer produces. */
function reducerOrderTodo(id: number, text: string): Todo {
	return {
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	};
}

/**
 * The same value after a round trip through the gist as the PWA writes it: `serialize()` sorts
 * keys, and `JSON.parse` preserves the file's order, so what comes back is key-sorted.
 */
function afterPwaRoundTrip<T>(value: T): T {
	return JSON.parse(serialize(value)) as T;
}

suite("Cross-peer equality and merge", () => {
	test("a todo is unchanged by a round trip through the PWA's serializer", () => {
		const mine = reducerOrderTodo(1, "buy milk");
		const theirs = afterPwaRoundTrip(mine);

		// The bytes really do differ — otherwise this test proves nothing.
		assert.notStrictEqual(
			JSON.stringify(mine),
			JSON.stringify(theirs),
			"key order must actually differ, or the regression cannot reproduce"
		);
		assert.strictEqual(isEqual(mine, theirs), true, "same content must compare equal");
	});

	test("a completed todo survives the round trip too", () => {
		// Ticking a task off appends `completionDate` after `isNote`, which sorted order puts
		// between `completed` and `creationDate`.
		const mine: Todo = {
			...reducerOrderTodo(2, "ship it"),
			completed: true,
			completionDate: "2026-02-02T00:00:00.000Z",
		};

		assert.strictEqual(isEqual(mine, afterPwaRoundTrip(mine)), true);
	});

	test("array order is still significant", () => {
		// Todo order is user-visible, so the canonical comparison must NOT sort arrays.
		const a = [reducerOrderTodo(1, "first"), reducerOrderTodo(2, "second")];
		const b = [a[1], a[0]];

		assert.strictEqual(isEqual(a, b), false, "reordering a list is a real change");
	});

	test("the other device rewriting the file does not make an untouched todo look modified", () => {
		const base = [reducerOrderTodo(1, "one"), reducerOrderTodo(2, "two")];
		// The PWA pushed an edit to todo 2, which re-serialized the whole file with sorted keys.
		const remote = afterPwaRoundTrip([base[0], { ...base[1], text: "two, edited on the phone" }]);

		const result = threeWayMerge(base, base, remote);

		assert.deepStrictEqual(result.conflicts, [], "no conflicts: only one side edited anything");
		const merged = result.autoMerged.slice().sort((x, y) => x.id - y.id);
		assert.strictEqual(merged.length, 2);
		assert.strictEqual(merged[0].text, "one");
		assert.strictEqual(merged[1].text, "two, edited on the phone");
	});

	/**
	 * The headline case: two devices editing *different* items at the same time is not a
	 * conflict, and used to be reported as one on every item the extension had created.
	 */
	test("editing different todos on the two devices merges without a conflict", () => {
		const base = [reducerOrderTodo(1, "todo X"), reducerOrderTodo(2, "todo Y")];
		const local = [{ ...base[0], text: "todo X (edited in VS Code)" }, base[1]];
		const remote = afterPwaRoundTrip([base[0], { ...base[1], text: "todo Y (edited in the PWA)" }]);

		const result = threeWayMerge(base, local, remote);

		assert.deepStrictEqual(
			result.conflicts.map((c) => c.todoId),
			[],
			"neither todo was edited on both sides"
		);
		const byId = new Map(result.autoMerged.map((t) => [t.id, t.text]));
		assert.strictEqual(byId.get(1), "todo X (edited in VS Code)", "local edit kept");
		assert.strictEqual(byId.get(2), "todo Y (edited in the PWA)", "remote edit kept");
	});

	/**
	 * Order is part of what the two peers have to agree on. Both run this merge, so if the
	 * extension put a new todo at the top and the PWA's next reconcile rebuilt the list in some
	 * other order, the two would push each other's arrangements back and forth forever.
	 */
	test("a todo added at the top stays at the top through a merge", () => {
		const base = [reducerOrderTodo(1, "todo X"), reducerOrderTodo(2, "todo Y")];
		// The extension's `createPosition: top` puts the new todo first.
		const local = [reducerOrderTodo(3, "todo Z"), ...base];
		const remote = afterPwaRoundTrip([base[0], { ...base[1], text: "todo Y (edited in the PWA)" }]);

		const result = threeWayMerge(base, local, remote);

		assert.deepStrictEqual(
			result.autoMerged.map((t) => t.text),
			["todo Z", "todo X", "todo Y (edited in the PWA)"]
		);
	});

	test("a genuine edit-edit conflict is still reported", () => {
		const base = [reducerOrderTodo(1, "todo X")];
		const local = [{ ...base[0], text: "mine" }];
		const remote = afterPwaRoundTrip([{ ...base[0], text: "theirs" }]);

		const result = threeWayMerge(base, local, remote);

		assert.strictEqual(result.conflicts.length, 1, "both sides changed the same todo");
		assert.strictEqual(result.conflicts[0].conflictType, "edit-edit");
		// And the sides shown to the user are the real ones, not a key-order artefact.
		assert.strictEqual(result.conflicts[0].local!.text, "mine");
		assert.strictEqual(result.conflicts[0].remote!.text, "theirs");
	});

	test("both peers serialize identical content to identical bytes", () => {
		// The extension now writes through the same `serialize()` the PWA uses, so a push that
		// changes nothing cannot change the file and cannot look like a remote change next poll.
		const data = { userTodos: [reducerOrderTodo(1, "one")] };

		assert.strictEqual(serialize(data), serialize(afterPwaRoundTrip(data)));
	});
});
