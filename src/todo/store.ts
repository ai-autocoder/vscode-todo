import { configureStore, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { getNumberOfTodos, generateUniqueId, getTodoArr } from "./todoUtils";
import { Todo, FullData, TodoLevel } from "./todoTypes";

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
