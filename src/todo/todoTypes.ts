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

export type TodoCount = {
	workspace: number;
	user: number;
};
