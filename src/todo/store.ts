import { combineReducers, configureStore, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { getNumberOfTodos, generateUniqueId } from "./todoUtils";
import { Todo, TodoScope, TodoSlice, ActionTrackerState } from "./todoTypes";
import { Middleware } from "@reduxjs/toolkit";

const todoReducers = {
	loadData: (state: TodoSlice, action: PayloadAction<{ data: Todo[] }>) => {
		Object.assign(state.todos, action.payload.data);
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
	},
	addTodo: (state: TodoSlice, action: PayloadAction<{ text: string }>) => {
		state.todos?.unshift({
			id: generateUniqueId(state, state.scope),
			text: action.payload.text,
			completed: false,
			creationDate: new Date().toISOString(),
		});
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
	},
	toggleTodo: (state: TodoSlice, action: PayloadAction<{ id: number }>) => {
		const todo = state.todos?.find((todo) => todo.id === action.payload.id);
		if (!todo) return;

		todo.completed = !todo.completed;
		todo.completionDate = todo.completed ? new Date().toISOString() : undefined;
		// Sort completed todos to be after uncompleted
		state.todos?.sort((a, b) => Number(a.completed) - Number(b.completed));
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
	},
	editTodo: (state: TodoSlice, action: PayloadAction<{ id: number; newText: string }>) => {
		const todo = state.todos?.find((todo) => todo.id === action.payload.id);
		if (!todo) return;

		todo.text = action.payload.newText;
		state.lastActionType = action.type;
	},
	deleteTodo: (state: TodoSlice, action: PayloadAction<{ id: number }>) => {
		const index = state.todos?.findIndex((todo) => todo.id === action.payload.id);
		if (index === undefined || index === -1) return;

		state.todos?.splice(index, 1);
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
	},
	reorderTodo: (state: TodoSlice, action: PayloadAction<{ reorderedTodos: Todo[] }>) => {
		state.todos = action.payload.reorderedTodos;
		state.lastActionType = action.type;
	},
};

const userSlice = createSlice({
	name: "user",
	initialState: {
		todos: [],
		lastActionType: "",
		numberOfTodos: 0,
		scope: TodoScope.user,
	} as TodoSlice,
	reducers: todoReducers,
});

const workspaceSlice = createSlice({
	name: "workspace",
	initialState: {
		todos: [],
		lastActionType: "",
		numberOfTodos: 0,
		scope: TodoScope.workspace,
	} as TodoSlice,
	reducers: todoReducers,
});

const actionTrackerSlice = createSlice({
	name: "actionTracker",
	initialState: {
		lastSliceName: "",
	} as ActionTrackerState,
	reducers: {
		trackAction: (state, action: PayloadAction<{ sliceName: string }>) => {
			state.lastSliceName = action.payload.sliceName;
		},
		resetLastSliceName: (state) => {
			state.lastSliceName = "";
		},
	},
});

// Combine reducers
const rootReducer = combineReducers({
	user: userSlice.reducer,
	workspace: workspaceSlice.reducer,
	actionTracker: actionTrackerSlice.reducer,
});

// Configure the store with the combined reducer
export default function () {
	return configureStore({
		reducer: rootReducer,
		middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(trackActionMiddleware),
	});
}

export const userActions = userSlice.actions;
export const workspaceActions = workspaceSlice.actions;
export const actionTrackerActions = actionTrackerSlice.actions;

const trackActionMiddleware: Middleware = (store) => (next) => (action) => {
	const result = next(action);
	const sliceName = action.type.split("/")[0];
	if (sliceName === "actionTracker") return;
	store.dispatch(actionTrackerSlice.actions.trackAction({ sliceName }));
	return result;
};
