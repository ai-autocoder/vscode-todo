import { FullData } from "./store";

/**
 * Calculate the number of incomplete todos in the given state.
 *
 * @param {FullData} state - The state containing the todos.
 * @return {Object} todoCount - An object containing the number of todos in the workspace and for the user.
 */
export function getNumberOfTodos(state: FullData): TodoCount {
	const workspace = state.workspaceTodos?.filter((todo) => !todo.completed).length ?? 0;
	const user = state.userTodos?.filter((todo) => !todo.completed).length ?? 0;
	return { workspace, user };
}

/**
 * Type definition for the count of todos.
 */
export type TodoCount = {
	workspace: number;
	user: number;
};
