import { ExtensionContext } from "vscode";
import { FullData, Todo, TodoCount, TodoLevel } from "./todoTypes";

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
export function generateUniqueId(todos: Todo[]): number {
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
export function getTodoArr(todos: FullData, level: TodoLevel): Todo[] | undefined {
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
