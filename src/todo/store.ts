import {
	combineReducers,
	configureStore,
	createSlice,
	Middleware,
	MiddlewareAPI,
	PayloadAction,
} from "@reduxjs/toolkit";
import {
	ActionTrackerState,
	CurrentFileSlice,
	FileDataInfoSlice,
	Slices,
	Todo,
	TodoScope,
	TodoSlice,
} from "./todoTypes";
import {
	assertNever,
	generateUniqueId,
	getNumberOfNotes,
	getNumberOfTodos,
	sortTodosWithNotes,
} from "./todoUtils";
import LogChannel from "../utilities/LogChannel";
import { getConfig } from "../utilities/config";

const todoReducers = {
	loadData: (state: TodoSlice, action: PayloadAction<{ data: Todo[] }>) => {
		state.todos = action.payload.data;
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
		state.numberOfNotes = getNumberOfNotes(state);
	},
	addTodo: (state: TodoSlice, action: PayloadAction<{ text: string }>) => {
		const { createPosition, createMarkdownByDefault } = getConfig();
		
		const newTodo = {
			id: generateUniqueId(state.todos),
			text: action.payload.text,
			completed: false,
			creationDate: new Date().toISOString(),
			isMarkdown: createMarkdownByDefault,
			isNote: false,
		};

		switch (createPosition) {
			case "top":
				state.todos?.unshift(newTodo);
				break;
			case "bottom":
				state.todos?.push(newTodo);
				break;
			default:
				LogChannel.log("Invalid createPosition value: " + createPosition);
				assertNever(createPosition);
		}

		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
		state.numberOfNotes = getNumberOfNotes(state);
	},
	toggleTodo: (state: TodoSlice, action: PayloadAction<{ id: number }>) => {
		const todo = state.todos?.find((todo) => todo.id === action.payload.id);
		if (!todo) return;

		todo.completed = !todo.completed;
		todo.completionDate = todo.completed ? new Date().toISOString() : undefined;
		Object.assign(state.todos, sortTodosWithNotes(state.todos));
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
		state.numberOfNotes = getNumberOfNotes(state);
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
		state.numberOfNotes = getNumberOfNotes(state);
	},
	reorderTodo: (state: TodoSlice, action: PayloadAction<{ reorderedTodos: Todo[] }>) => {
		state.todos = action.payload.reorderedTodos;
		state.lastActionType = action.type;
		Object.assign(state.todos, sortTodosWithNotes(state.todos));
	},
	toggleMarkdown: (state: TodoSlice, action: PayloadAction<{ id: number }>) => {
		const todo = state.todos?.find((todo) => todo.id === action.payload.id);
		if (!todo) return;
		todo.isMarkdown = !(todo.isMarkdown ?? false);
		state.lastActionType = action.type;
	},
	toggleTodoNote: (state: TodoSlice, action: PayloadAction<{ id: number }>) => {
		const todo = state.todos?.find((todo) => todo.id === action.payload.id);
		if (!todo) return;
		todo.isNote = !(todo.isNote ?? false);
		if (!todo.isNote) {
			Object.assign(state.todos, sortTodosWithNotes(state.todos));
		}
		state.lastActionType = action.type;
		state.numberOfTodos = getNumberOfTodos(state);
		state.numberOfNotes = getNumberOfNotes(state);
	},
};

const userSlice = createSlice({
	name: "user",
	initialState: {
		todos: [],
		lastActionType: "",
		numberOfTodos: 0,
		numberOfNotes: 0,
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
		numberOfNotes: 0,
		scope: TodoScope.workspace,
	} as TodoSlice,
	reducers: todoReducers,
});

const fileDataInfoSlice = createSlice({
	name: "fileDataInfo",
	initialState: {
		editorFocusedFilePath: "",
		workspaceFilesWithRecords: [],
		lastActionType: "",
	} as FileDataInfoSlice,
	reducers: {
		setCurrentFile: (state, action: PayloadAction<string>) => {
			state.editorFocusedFilePath = action.payload;
			state.lastActionType = action.type;
		},
		setWorkspaceFilesWithRecords: (
			state,
			action: PayloadAction<{ filePath: string; todoNumber: number }[]>
		) => {
			state.workspaceFilesWithRecords = action.payload;
			state.lastActionType = action.type;
		},
	},
});

const currentFileSlice = createSlice({
	name: "currentFile",
	initialState: {
		filePath: "",
		isPinned: false,
		todos: [],
		lastActionType: "",
		numberOfTodos: 0,
		numberOfNotes: 0,
		scope: TodoScope.currentFile,
	} as CurrentFileSlice,
	reducers: {
		...todoReducers,
		loadData: (
			state: CurrentFileSlice,
			action: PayloadAction<{ filePath: string; data: Todo[] }>
		) => {
			state.filePath = action.payload.filePath;
			state.todos = action.payload.data;
			state.lastActionType = action.type;
			state.numberOfTodos = getNumberOfTodos(state);
			state.numberOfNotes = getNumberOfNotes(state);
		},
		pinFile(state: CurrentFileSlice, action: PayloadAction) {
			state.isPinned = !state.isPinned;
			state.lastActionType = action.type;
		},
	},
});

const actionTrackerSlice = createSlice({
	name: "actionTracker",
	initialState: {
		lastSliceName: Slices.unset,
	} as ActionTrackerState,
	reducers: {
		trackAction: (state, action: PayloadAction<{ sliceName: Slices }>) => {
			state.lastSliceName = action.payload.sliceName;
		},
		resetLastSliceName: (state) => {
			state.lastSliceName = Slices.unset;
		},
	},
});

// Combine reducers
const rootReducer = combineReducers({
	user: userSlice.reducer,
	workspace: workspaceSlice.reducer,
	fileDataInfo: fileDataInfoSlice.reducer,
	currentFile: currentFileSlice.reducer,
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
export const fileDataInfoActions = fileDataInfoSlice.actions;
export const currentFileActions = currentFileSlice.actions;
export const actionTrackerActions = actionTrackerSlice.actions;

const trackActionMiddleware: Middleware = (api: MiddlewareAPI) => (next) => (action) => {
	if (
		typeof action === "object" &&
		action !== null &&
		"type" in action &&
		typeof action.type === "string"
	) {
		const result = next(action);
		const sliceName = action.type.split("/")[0] as Slices;
		const knownSliceNames = Object.values(Slices);
		if (
			sliceName !== "" &&
			knownSliceNames.includes(sliceName) &&
			sliceName !== Slices.actionTracker
		) {
			LogChannel.log(
				`Dispatching action: ${action.type}.${"payload" in action ? ` Payload: ${JSON.stringify(action.payload)}` : ""}`
			);

			api.dispatch(actionTrackerSlice.actions.trackAction({ sliceName }));
		}
		return result;
	}
	return next(action);
};
