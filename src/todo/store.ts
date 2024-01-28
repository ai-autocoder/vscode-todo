import { configureStore, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { ExtensionContext } from "vscode";
import { getNumberOfTodos, TodoCount } from "./todoUtils";

export interface Todo {
	id: number;
	text: string;
	completed: boolean;
	creationDate: string;
	completionDate?: string;
}

export interface FullData {
	workspaceTodos: Todo[];
	userTodos: Todo[];
	lastActionType?: string;
	numberOfTodos: TodoCount;
}

export enum TodoLevel {
	user = "user",
	workspace = "workspace",
}

const todosSlice = createSlice({
	name: "todos",
	initialState: {
		userTodos: [],
		workspaceTodos: [],
		lastActionType: undefined,
		numberOfTodos: { workspace: 0, user: 0 },
	} as FullData,
	reducers: {
		loadData: (state: FullData, action: PayloadAction<{ data: FullData }>) => {
			Object.assign(state, action.payload.data);
			state.lastActionType = action.type;
			state.numberOfTodos = getNumberOfTodos(state);
		},
		addTodo: (state: FullData, action: PayloadAction<{ level: TodoLevel; text: string }>) => {
			const todoArr = getTodoArr(state, action.payload.level);

			todoArr?.unshift({
				id: generateUniqueId(todoArr),
				text: action.payload.text,
				completed: false,
				creationDate: new Date().toISOString(),
			});
			state.lastActionType = action.type;
			state.numberOfTodos = getNumberOfTodos(state);
		},
		toggleTodo: (state: FullData, action: PayloadAction<{ level: TodoLevel; id: number }>) => {
			const todoArr = getTodoArr(state, action.payload.level);
			const todo = todoArr?.find((todo) => todo.id === action.payload.id);
			if (!todo) return;

			todo.completed = !todo.completed;
			todo.completionDate = todo.completed ? new Date().toISOString() : undefined;
			// Sort completed todos to be after uncompleted
			todoArr?.sort((a, b) => Number(a.completed) - Number(b.completed));
			state.lastActionType = action.type;
			state.numberOfTodos = getNumberOfTodos(state);
		},
		editTodo: (
			state: FullData,
			action: PayloadAction<{ level: TodoLevel; id: number; newText: string }>
		) => {
			const todoArr = getTodoArr(state, action.payload.level);
			const todo = todoArr?.find((todo) => todo.id === action.payload.id);
			if (!todo) return;

			todo.text = action.payload.newText;
			state.lastActionType = action.type;
		},
		deleteTodo: (state: FullData, action: PayloadAction<{ level: TodoLevel; id: number }>) => {
			const todoArr = getTodoArr(state, action.payload.level);
			const index = todoArr?.findIndex((todo) => todo.id === action.payload.id);
			if (index === undefined || index === -1) return;

			todoArr?.splice(index, 1);
			state.lastActionType = action.type;
			state.numberOfTodos = getNumberOfTodos(state);
		},
		reorderTodo: (
			state: FullData,
			action: PayloadAction<{ level: TodoLevel; reorderedTodos: Todo[] }>
		) => {
			if (action.payload.level === TodoLevel.user) {
				state.userTodos = action.payload.reorderedTodos;
			} else if (action.payload.level === TodoLevel.workspace) {
				state.workspaceTodos = action.payload.reorderedTodos;
			}
			state.lastActionType = action.type;
		},
	},
});

// Create a store
export default function () {
	return configureStore({
		reducer: todosSlice.reducer,
	});
}
// Export actions
export const storeActions = todosSlice.actions;

/**
 * Persists the provided state to the extension context.
 */
export function persist(state: FullData, context: ExtensionContext): void {
	context.globalState.update("TodoData", state.userTodos);
	context.workspaceState.update("TodoData", state.workspaceTodos);
}

/**
 * Generates a unique ID that does not exist in the given array of todos.
 *
 * @param {Todo[]} todos - The array of todos to check for existing IDs.
 * @return {number} The generated unique ID.
 */
function generateUniqueId(todos: Todo[]): number {
	let newId: number;
	do {
		newId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
	} while (todos.some((todo) => todo.id === newId));
	return newId;
}
/**
 * Retrieves the todo array based on the specified level.
 *
 * @param {FullData} todos - The full data containing all the todos.
 * @param {TodoLevel} level - The level of the todos to retrieve.
 * @return {Todo[] | undefined} The corresponding todo array based on the level.
 */
function getTodoArr(todos: FullData, level: TodoLevel): Todo[] | undefined {
	switch (level) {
		case TodoLevel.user:
			return todos.userTodos;
		case TodoLevel.workspace:
			return todos.workspaceTodos;
		default:
			console.log(`Invalid TodoLevel: ${level}`);
			return;
	}
}
