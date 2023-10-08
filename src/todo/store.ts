import {
	AnyAction,
	configureStore,
	createSlice,
	PayloadAction,
	ThunkMiddleware,
} from "@reduxjs/toolkit";
import { ToolkitStore } from "@reduxjs/toolkit/dist/configureStore";
import { ExtensionContext, workspace } from "vscode";

const nextId = {
	userTodos: 0,
	workspaceTodos: 0,
};

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
	} as FullData,
	reducers: {
		loadData: (todos: FullData, action: PayloadAction<{ data: FullData }>) => {
			return action.payload.data;
		},
		addTodo: (todos: FullData, action: PayloadAction<{ level: TodoLevel; text: string }>) => {
			if (action.payload.level === TodoLevel.user) {
				todos.userTodos.push({
					id: nextId.userTodos++,
					text: action.payload.text,
					completed: false,
					creationDate: new Date().toISOString(),
				});
			} else if (action.payload.level === TodoLevel.workspace) {
				todos.workspaceTodos.push({
					id: nextId.workspaceTodos++,
					text: action.payload.text,
					completed: false,
					creationDate: new Date().toISOString(),
				});
			}
		},
		toggleTodo: (todos: FullData, action: PayloadAction<{ level: TodoLevel; id: number }>) => {
			if (action.payload.level === TodoLevel.user) {
				const todo = todos.userTodos.find((t) => t.id === action.payload.id);
				if (todo) {
					todo.completed = !todo.completed;
					todo.completionDate = new Date().toISOString();
				}
			} else if (action.payload.level === TodoLevel.workspace) {
				const todo = todos.workspaceTodos.find((t) => t.id === action.payload.id);
				if (todo) {
					todo.completed = !todo.completed;
					todo.completionDate = new Date().toISOString();
				}
			}
		},
		editTodo: (
			todos: FullData,
			action: PayloadAction<{ level: TodoLevel; id: number; newText: string }>
		) => {
			if (action.payload.level === TodoLevel.user) {
				const todo = todos.userTodos.find((t) => t.id === action.payload.id);
				if (todo) {
					todo.text = action.payload.newText;
				}
			} else if (action.payload.level === TodoLevel.workspace) {
				const todo = todos.workspaceTodos.find((t) => t.id === action.payload.id);
				if (todo) {
					todo.text = action.payload.newText;
				}
			}
		},
		deleteTodo: (todos: FullData, action: PayloadAction<{ level: TodoLevel; id: number }>) => {
			if (action.payload.level === TodoLevel.user) {
				const index = todos.userTodos.findIndex((t) => t.id === action.payload.id);
				if (index !== -1) {
					todos.userTodos.splice(index, 1);
				}
			} else if (action.payload.level === TodoLevel.workspace) {
				const index = todos.workspaceTodos.findIndex((t) => t.id === action.payload.id);
				if (index !== -1) {
					todos.workspaceTodos.splice(index, 1);
				}
			}
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

export function persist(store: ToolkitStore, context: ExtensionContext): void {
	context.globalState.update("TodoData", store.getState().userTodos);
	context.workspaceState.update("TodoData", store.getState().workspaceTodos);
}
