import { describe, it, expect } from "vitest";
import { todoMutations, ReducerConfig, TodoSliceState, Todo } from "../src/index";

const cfg = (over: Partial<ReducerConfig> = {}): ReducerConfig => ({
	createPosition: "bottom",
	createMarkdownByDefault: false,
	taskSortingOptions: "sortType1",
	...over,
});

const slice = (todos: Todo[] = []): TodoSliceState => ({
	todos,
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
});

const todo = (id: number, over: Partial<Todo> = {}): Todo => ({
	id,
	text: `t${id}`,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

describe("todoMutations.addTodo", () => {
	it("inserts at top when position=top and respects createMarkdownByDefault", () => {
		const s = slice([todo(1)]);
		todoMutations.addTodo(s, { text: "new", position: "top" }, cfg({ createMarkdownByDefault: true }));
		expect(s.todos[0].text).toBe("new");
		expect(s.todos[0].isMarkdown).toBe(true);
		expect(s.todos[0].completed).toBe(false);
		expect(s.lastActionType).toBe("addTodo");
		expect(s.numberOfTodos).toBe(2);
	});

	it("appends at bottom by default (config position)", () => {
		const s = slice([todo(1)]);
		todoMutations.addTodo(s, { text: "new" }, cfg({ createPosition: "bottom" }));
		expect(s.todos[s.todos.length - 1].text).toBe("new");
	});

	it("generates an id not colliding with existing items", () => {
		const s = slice([todo(1)]);
		todoMutations.addTodo(s, { text: "new" }, cfg());
		const ids = s.todos.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("todoMutations.addTodos", () => {
	it("keeps batch ids unique and preserves order on a top insert", () => {
		const s = slice([todo(1)]);
		todoMutations.addTodos(s, { texts: ["a", "b", "c"], position: "top" }, cfg());
		expect(s.todos.slice(0, 3).map((t) => t.text)).toEqual(["a", "b", "c"]);
		expect(new Set(s.todos.map((t) => t.id)).size).toBe(s.todos.length);
	});
});

describe("todoMutations.toggleTodo", () => {
	it("sets completionDate on complete and clears it on reopen", () => {
		const s = slice([todo(1)]);
		todoMutations.toggleTodo(s, { id: 1 }, cfg());
		expect(s.todos.find((t) => t.id === 1)?.completed).toBe(true);
		expect(s.todos.find((t) => t.id === 1)?.completionDate).toBeTypeOf("string");
		todoMutations.toggleTodo(s, { id: 1 }, cfg());
		expect(s.todos.find((t) => t.id === 1)?.completed).toBe(false);
		expect(s.todos.find((t) => t.id === 1)?.completionDate).toBeUndefined();
	});

	it("moves a completed task below an incomplete one (sortType1)", () => {
		const s = slice([todo(1), todo(2)]);
		todoMutations.toggleTodo(s, { id: 1 }, cfg());
		expect(s.todos.map((t) => t.id)).toEqual([2, 1]);
		expect(s.numberOfTodos).toBe(1);
	});

	it("does not reorder when sorting is disabled", () => {
		const s = slice([todo(1), todo(2)]);
		todoMutations.toggleTodo(s, { id: 1 }, cfg({ taskSortingOptions: "disabled" }));
		expect(s.todos.map((t) => t.id)).toEqual([1, 2]);
	});
});

describe("todoMutations.setTags", () => {
	it("sets tags and clears the field to undefined when empty", () => {
		const s = slice([todo(1)]);
		todoMutations.setTags(s, { id: 1, tags: ["x", "y"] });
		expect(s.todos[0].tags).toEqual(["x", "y"]);
		todoMutations.setTags(s, { id: 1, tags: [] });
		expect(s.todos[0].tags).toBeUndefined();
	});
});

describe("todoMutations.deleteCompleted", () => {
	it("removes completed tasks but keeps notes", () => {
		const s = slice([todo(1, { completed: true }), todo(2), todo(3, { isNote: true, completed: true })]);
		todoMutations.deleteCompleted(s);
		expect(s.todos.map((t) => t.id).sort()).toEqual([2, 3]);
	});
});

describe("todoMutations.undoDelete", () => {
	it("restores an item at the recorded position with a fresh id", () => {
		const s = slice([todo(1), todo(2)]);
		todoMutations.undoDelete(s, {
			id: 99,
			text: "restored",
			completed: false,
			creationDate: "2020-01-01T00:00:00.000Z",
			isMarkdown: false,
			isNote: false,
			itemPosition: 1,
		});
		expect(s.todos[1].text).toBe("restored");
		expect(s.todos[1].id).not.toBe(99); // a new unique id is generated
		expect(s.todos.map((t) => t.text)).toEqual(["t1", "restored", "t2"]);
	});
});

describe("todoMutations.reorderTodo", () => {
	it("applies the new order then re-sorts completed below", () => {
		const s = slice([todo(1), todo(2, { completed: true }), todo(3)]);
		todoMutations.reorderTodo(s, { reorderedTodos: [todo(2, { completed: true }), todo(3), todo(1)] }, cfg());
		// completed item (2) settles after the incomplete ones, which keep their reordered order
		expect(s.todos.map((t) => t.id)).toEqual([3, 1, 2]);
	});
});

describe("todoMutations.toggleTodoNote", () => {
	it("flips isNote and recounts", () => {
		const s = slice([todo(1)]);
		todoMutations.toggleTodoNote(s, { id: 1 }, cfg());
		expect(s.todos[0].isNote).toBe(true);
		expect(s.numberOfNotes).toBe(1);
		expect(s.numberOfTodos).toBe(0);
	});
});
