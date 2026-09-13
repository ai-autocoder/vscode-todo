import { describe, it, expect } from "vitest";
import { threeWayMerge, Todo } from "../src/index";

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

describe("threeWayMerge", () => {
	it("auto-merges non-overlapping edits to different items", () => {
		const base = [todo(1, "a"), todo(2, "b")];
		const local = [todo(1, "a-local"), todo(2, "b")];
		const remote = [todo(1, "a"), todo(2, "b-remote")];

		const { autoMerged, conflicts } = threeWayMerge(base, local, remote);

		expect(conflicts).toHaveLength(0);
		expect(autoMerged.find((t) => t.id === 1)?.text).toBe("a-local");
		expect(autoMerged.find((t) => t.id === 2)?.text).toBe("b-remote");
	});

	it("flags an edit-edit conflict when both sides change the same item", () => {
		const base = [todo(1, "a")];
		const local = [todo(1, "a-local")];
		const remote = [todo(1, "a-remote")];

		const { autoMerged, conflicts } = threeWayMerge(base, local, remote);

		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ todoId: 1, conflictType: "edit-edit" });
		// Conflicted item is excluded from the auto-merged set for the caller to resolve.
		expect(autoMerged.find((t) => t.id === 1)).toBeUndefined();
	});

	it("pulls in a remote-only addition", () => {
		const base = [todo(1, "a")];
		const local = [todo(1, "a")];
		const remote = [todo(1, "a"), todo(2, "added-remotely")];

		const { autoMerged, conflicts } = threeWayMerge(base, local, remote);

		expect(conflicts).toHaveLength(0);
		expect(autoMerged.map((t) => t.id)).toEqual([1, 2]);
	});

	it("accepts a remote deletion when local left the item untouched", () => {
		const base = [todo(1, "a"), todo(2, "b")];
		const local = [todo(1, "a"), todo(2, "b")];
		const remote = [todo(1, "a")];

		const { autoMerged, conflicts } = threeWayMerge(base, local, remote);

		expect(conflicts).toHaveLength(0);
		expect(autoMerged.map((t) => t.id)).toEqual([1]);
	});

	it("flags edit-delete when local edits an item the remote deleted", () => {
		const base = [todo(1, "a")];
		const local = [todo(1, "a-local")];
		const remote: Todo[] = [];

		const { conflicts } = threeWayMerge(base, local, remote);

		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ todoId: 1, conflictType: "edit-delete" });
	});

	it("keeps both additions when each side adds a distinct item", () => {
		const base: Todo[] = [];
		const local = [todo(1, "local-add")];
		const remote = [todo(2, "remote-add")];

		const { autoMerged, conflicts } = threeWayMerge(base, local, remote);

		expect(conflicts).toHaveLength(0);
		expect(new Set(autoMerged.map((t) => t.id))).toEqual(new Set([1, 2]));
	});
});
