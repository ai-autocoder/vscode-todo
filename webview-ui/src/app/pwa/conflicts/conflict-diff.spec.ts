import type { Todo } from "@vsc-todo/core";
import {
	canMergeFields,
	describeConflict,
	fieldDiffs,
	isValueStale,
	mergeTodoFields,
} from "./conflict-diff";
import type { PendingConflict, PendingTodoConflict } from "./conflict-types";

const todo = (overrides: Partial<Todo> = {}): Todo => ({
	id: 1,
	text: "Buy milk",
	completed: false,
	creationDate: "2026-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...overrides,
});

const conflict = (overrides: Partial<PendingTodoConflict> = {}): PendingTodoConflict => ({
	kind: "todo",
	key: "user:1",
	scope: "user",
	todoId: 1,
	conflictType: "edit-edit",
	base: todo(),
	local: todo({ text: "local" }),
	remote: todo({ text: "remote" }),
	resolvedValue: todo({ text: "local" }),
	syncedAt: "2026-01-02T00:00:00.000Z",
	...overrides,
});

describe("describeConflict", () => {
	it("should name each todo conflict type from this device's point of view", () => {
		expect(describeConflict(conflict({ conflictType: "edit-edit" }))).toBe("Edited on both devices");
		expect(describeConflict(conflict({ conflictType: "edit-delete" }))).toBe(
			"Edited here, deleted on the other device"
		);
		expect(describeConflict(conflict({ conflictType: "delete-edit" }))).toBe(
			"Deleted here, edited on the other device"
		);
	});

	it("should describe an id collision as two items rather than two versions", () => {
		const keptBoth: PendingConflict = {
			kind: "kept-both",
			key: "user:1",
			scope: "user",
			todoId: 1,
			local: todo(),
			remote: todo({ text: "other" }),
			newId: 99,
			syncedAt: "2026-01-02T00:00:00.000Z",
		};
		expect(describeConflict(keptBoth)).toBe("Two different items with the same id");
	});
});

describe("canMergeFields", () => {
	it("should allow a per-field merge only when both versions exist", () => {
		expect(canMergeFields(conflict({ conflictType: "edit-edit" }))).toBeTrue();
		expect(canMergeFields(conflict({ conflictType: "edit-delete", remote: null }))).toBeFalse();
		expect(canMergeFields(conflict({ conflictType: "delete-edit", local: null }))).toBeFalse();
	});
});

describe("fieldDiffs", () => {
	it("should report only the fields that differ", () => {
		const diffs = fieldDiffs(
			todo({ text: "a", completed: false }),
			todo({ text: "b", completed: true })
		);
		expect(diffs.map((diff) => diff.field)).toEqual(["text", "completed"]);
	});

	it("should treat an absent tags array and an empty one as the same value", () => {
		expect(fieldDiffs(todo(), todo({ tags: [] }))).toEqual([]);
	});

	it("should format both sides for display", () => {
		const [diff] = fieldDiffs(todo({ completed: false }), todo({ completed: true }));
		expect(diff.label).toBe("Status");
		expect(diff.localText).toBe("Not done");
		expect(diff.remoteText).toBe("Done");
	});
});

describe("mergeTodoFields", () => {
	const local = todo({ text: "local text", completed: false, tags: ["home"] });
	const remote = todo({
		text: "remote text",
		completed: true,
		completionDate: "2026-01-03T00:00:00.000Z",
		tags: ["work"],
	});

	it("should keep the local value for every field the user did not move", () => {
		const merged = mergeTodoFields(local, remote, { text: "remote" });
		expect(merged.text).toBe("remote text");
		expect(merged.completed).toBeFalse();
		expect(merged.tags).toEqual(["home"]);
	});

	it("should carry completionDate along with completed", () => {
		const merged = mergeTodoFields(local, remote, { completed: "remote" });
		expect(merged.completed).toBeTrue();
		expect(merged.completionDate).toBe("2026-01-03T00:00:00.000Z");
	});

	it("should drop a completionDate that the chosen side does not have", () => {
		const done = todo({ completed: true, completionDate: "2026-01-03T00:00:00.000Z" });
		const merged = mergeTodoFields(done, todo({ completed: false }), { completed: "remote" });
		expect(merged.completed).toBeFalse();
		expect("completionDate" in merged).toBeFalse();
	});

	it("should keep the local id so the merged todo replaces the same item", () => {
		const merged = mergeTodoFields(local, todo({ id: 42, text: "other" }), { text: "remote" });
		expect(merged.id).toBe(local.id);
	});

	it("should return the local version unchanged when nothing is moved", () => {
		expect(mergeTodoFields(local, remote, {})).toEqual(local);
	});
});

describe("isValueStale", () => {
	it("should not flag an item that still matches what the sync applied", () => {
		expect(isValueStale(todo(), todo())).toBeFalse();
	});

	it("should flag an item edited since the sync", () => {
		expect(isValueStale(todo({ text: "a" }), todo({ text: "b" }))).toBeTrue();
	});

	it("should flag an item deleted since the sync, and one re-added since a deletion", () => {
		expect(isValueStale(todo(), null)).toBeTrue();
		expect(isValueStale(null, todo())).toBeTrue();
	});

	it("should treat a resolved deletion that is still absent as unchanged", () => {
		expect(isValueStale(null, null)).toBeFalse();
	});

	it("should compare per-file lists as whole values", () => {
		expect(isValueStale([todo()], [todo()])).toBeFalse();
		expect(isValueStale([todo()], [todo(), todo({ id: 2 })])).toBeTrue();
	});
});
