/**
 * Framework-agnostic todo mutations — the pure core of the extension's Redux reducers.
 *
 * The VS Code extension's `src/todo/store.ts` defines these same operations as Redux Toolkit
 * reducers, but that module imports `vscode` (via `getConfig`/`LogChannel`) and so cannot run
 * in a browser. The PWA's `GistGateway` needs identical local behavior (an add must generate
 * the same kind of id, a toggle must stamp `completionDate` and re-sort, etc.) before it
 * serializes a slice to the gist. To guarantee the two never drift, the logic lives here once
 * and is consumed by both:
 *
 *   - the PWA (now, via `applyTodoAction`),
 *   - the extension (eventually, replacing the bodies in `store.ts` — see the plan's deferred
 *     migration).
 *
 * These functions **mutate** the passed `TodoSliceState` in place (matching Redux Toolkit's
 * Immer-draft style) and return nothing. Config that the extension read from `getConfig()`
 * (`createPosition`, `createMarkdownByDefault`, the sort option) is passed in explicitly as
 * {@link ReducerConfig}.
 */

import { Todo, TodoSlice } from "./todoTypes";
import { generateUniqueId, sortTodosWithNotes, TaskSortOption } from "./pure";

/** Where a newly created todo/note is inserted into its list. */
export type CreatePosition = "top" | "bottom";

/** The slice fields these mutations read/write. Structurally a {@link TodoSlice}. */
export type TodoSliceState = Pick<
	TodoSlice,
	"todos" | "lastActionType" | "numberOfTodos" | "numberOfNotes"
>;

/** Config the extension previously sourced from `getConfig()`. */
export interface ReducerConfig {
	createPosition: CreatePosition;
	createMarkdownByDefault: boolean;
	taskSortingOptions: TaskSortOption;
}

const countTodos = (state: TodoSliceState): number =>
	state?.todos.filter((t) => !t.completed && !t.isNote).length ?? 0;

const countNotes = (state: TodoSliceState): number =>
	state?.todos.filter((t) => t.isNote).length ?? 0;

/** Recomputes the cached `numberOfTodos`/`numberOfNotes`. */
export function recountTodos(state: TodoSliceState): void {
	state.numberOfTodos = countTodos(state);
	state.numberOfNotes = countNotes(state);
}

/**
 * Inserts an already-built block of todos at the given position, preserving the block's order.
 * A "top" insert puts the block at the front (first element topmost). A "bottom" insert
 * appends then re-sorts the whole list; `sortTodosWithNotes` is stable and a fresh block is
 * all-incomplete, so the block stays contiguous while completed items settle below it.
 * (Verbatim behavior of `insertTodos` in `src/todo/store.ts`.)
 */
function insertTodos(
	state: TodoSliceState,
	block: Todo[],
	position: CreatePosition,
	option: TaskSortOption
): void {
	switch (position) {
		case "top":
			state.todos.unshift(...block);
			break;
		case "bottom":
			state.todos.push(...block);
			Object.assign(state.todos, sortTodosWithNotes(state.todos, option));
			break;
	}
	recountTodos(state);
}

// --- Payload shapes (match store.ts reducers) ---
export interface AddTodoPayload {
	text: string;
	position?: CreatePosition;
}
export interface AddTodosPayload {
	texts: string[];
	position?: CreatePosition;
}
export interface UndoDeletePayload {
	id: number;
	text: string;
	completed: boolean;
	creationDate: string;
	isMarkdown: boolean;
	isNote: boolean;
	collapsed?: boolean;
	tags?: string[];
	itemPosition: number;
}

/**
 * The mutation set, mirroring `todoReducers` in `src/todo/store.ts` one-to-one. Each takes the
 * slice state, a payload, and the config (where the original read `getConfig()`). `lastActionType`
 * is set to the matching Redux action type string (`"<scope>/<name>"` is applied by the caller;
 * here we store the bare reducer name to stay scope-agnostic, exactly as the slice name prefix
 * is added by Redux — the webview only compares suffixes via `lastActionType`).
 */
export const todoMutations = {
	loadData(state: TodoSliceState, payload: { data: Todo[] }): void {
		state.todos = payload.data;
		state.lastActionType = "loadData";
		recountTodos(state);
	},

	addTodo(state: TodoSliceState, payload: AddTodoPayload, config: ReducerConfig): void {
		const position = payload.position ?? config.createPosition;
		const newTodo: Todo = {
			id: generateUniqueId(state.todos),
			text: payload.text,
			completed: false,
			creationDate: new Date().toISOString(),
			isMarkdown: config.createMarkdownByDefault,
			isNote: false,
		};
		insertTodos(state, [newTodo], position, config.taskSortingOptions);
		state.lastActionType = "addTodo";
	},

	addTodos(state: TodoSliceState, payload: AddTodosPayload, config: ReducerConfig): void {
		const position = payload.position ?? config.createPosition;
		const block: Todo[] = [];
		for (const text of payload.texts) {
			block.push({
				id: generateUniqueId([...state.todos, ...block]),
				text,
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: config.createMarkdownByDefault,
				isNote: false,
			});
		}
		insertTodos(state, block, position, config.taskSortingOptions);
		state.lastActionType = "addTodos";
	},

	toggleTodo(state: TodoSliceState, payload: { id: number }, config: ReducerConfig): void {
		const todo = state.todos?.find((t) => t.id === payload.id);
		if (!todo) {
			return;
		}
		todo.completed = !todo.completed;
		todo.completionDate = todo.completed ? new Date().toISOString() : undefined;
		Object.assign(state.todos, sortTodosWithNotes(state.todos, config.taskSortingOptions));
		state.lastActionType = "toggleTodo";
		recountTodos(state);
	},

	editTodo(state: TodoSliceState, payload: { id: number; newText: string }): void {
		const todo = state.todos?.find((t) => t.id === payload.id);
		if (!todo) {
			return;
		}
		todo.text = payload.newText;
		state.lastActionType = "editTodo";
	},

	deleteTodo(state: TodoSliceState, payload: { id: number }): void {
		const index = state.todos?.findIndex((t) => t.id === payload.id);
		if (index === undefined || index === -1) {
			return;
		}
		state.todos?.splice(index, 1);
		state.lastActionType = "deleteTodo";
		recountTodos(state);
	},

	deleteTodos(state: TodoSliceState, payload: { ids: number[] }): void {
		state.todos = state.todos.filter((t) => !payload.ids.includes(t.id));
		state.lastActionType = "deleteTodos";
		recountTodos(state);
	},

	deleteCompleted(state: TodoSliceState): void {
		state.todos = state.todos.filter((t) => !t.completed || t.isNote);
		state.lastActionType = "deleteCompleted";
		recountTodos(state);
	},

	undoDelete(state: TodoSliceState, payload: UndoDeletePayload): void {
		const restoredItem: Todo = {
			id: generateUniqueId(state.todos),
			text: payload.text,
			completed: payload.completed,
			creationDate: payload.creationDate,
			isMarkdown: payload.isMarkdown,
			isNote: payload.isNote,
			collapsed: payload.collapsed ?? false,
			tags: payload.tags,
		};
		state.todos?.splice(payload.itemPosition, 0, restoredItem);
		state.lastActionType = "undoDelete";
		recountTodos(state);
	},

	toggleCollapsed(state: TodoSliceState, payload: { id: number }): void {
		const todo = state.todos?.find((t) => t.id === payload.id);
		if (!todo) {
			return;
		}
		todo.collapsed = !todo.collapsed;
		state.lastActionType = "toggleCollapsed";
	},

	setAllCollapsed(state: TodoSliceState, payload: { collapsed: boolean }): void {
		state.todos?.forEach((t) => {
			t.collapsed = payload.collapsed;
		});
		state.lastActionType = "setAllCollapsed";
	},

	reorderTodo(state: TodoSliceState, payload: { reorderedTodos: Todo[] }, config: ReducerConfig): void {
		state.todos = payload.reorderedTodos;
		state.lastActionType = "reorderTodo";
		Object.assign(state.todos, sortTodosWithNotes(state.todos, config.taskSortingOptions));
	},

	toggleMarkdown(state: TodoSliceState, payload: { id: number }): void {
		const todo = state.todos?.find((t) => t.id === payload.id);
		if (!todo) {
			return;
		}
		todo.isMarkdown = !(todo.isMarkdown ?? false);
		state.lastActionType = "toggleMarkdown";
	},

	toggleTodoNote(state: TodoSliceState, payload: { id: number }, config: ReducerConfig): void {
		const todo = state.todos?.find((t) => t.id === payload.id);
		if (!todo) {
			return;
		}
		todo.isNote = !(todo.isNote ?? false);
		if (!todo.isNote) {
			Object.assign(state.todos, sortTodosWithNotes(state.todos, config.taskSortingOptions));
		}
		state.lastActionType = "toggleTodoNote";
		recountTodos(state);
	},

	setTags(state: TodoSliceState, payload: { id: number; tags: string[] }): void {
		const todo = state.todos?.find((t) => t.id === payload.id);
		if (!todo) {
			return;
		}
		// Replace semantics: an empty list clears the field entirely.
		todo.tags = payload.tags.length > 0 ? payload.tags : undefined;
		state.lastActionType = "setTags";
	},
};
