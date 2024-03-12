export interface Todo {
	id: number;
	text: string;
	completed: boolean;
	creationDate: string;
	completionDate?: string;
	isMarkdown: boolean;
}

export enum TodoScope {
	user = "user",
	workspace = "workspace",
}

export type TodoCount = {
	workspace: number;
	user: number;
};

export interface TodoSlice {
	todos: Todo[];
	lastActionType: string;
	numberOfTodos: number;
	scope: TodoScope;
}

export interface StoreState {
	user: TodoSlice;
	workspace: TodoSlice;
	actionTracker: ActionTrackerState;
	[key: string]: TodoSlice | ActionTrackerState;
}

// Middleware
export interface ActionTrackerState {
	lastSliceName: string;
}
