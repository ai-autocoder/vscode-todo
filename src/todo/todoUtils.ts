import { ExtensionContext } from "vscode";
import { TodoScope, TodoSlice } from "./todoTypes";

/**
 * Calculate the number of incomplete todos in the given state.
 *
 * @param {TodoSlice} state - The state containing the todos.
 * @return {Object} todoCount - An object containing the number of todos in the workspace and for the user.
 */
export function getNumberOfTodos(state: TodoSlice): number {
	return state?.todos.filter((todo) => !todo.completed).length ?? 0;
}

/**
 * Persists the provided slice state to the extension context.
 */
export function persist(state: TodoSlice, context: ExtensionContext): void {
	state.scope === TodoScope.user
		? context.globalState.update("TodoData", state.todos)
		: context.workspaceState.update("TodoData", state.todos);
}

/**
 * Generates a unique ID for a todo, prefixed based on the todo scope ('1' for user, '2' for workspace).
 *
 * @param {TodoSlice} state - State containing todos.
 * @param {TodoScope} scope - Scope of the todo (user or workspace).
 * @return {number} Prefixed unique ID within safe integer range.
 */
export function generateUniqueId(state: TodoSlice, scope: TodoScope): number {
	const todos = state.todos;
	let newId: number;
	const maxRandom = Number.MAX_SAFE_INTEGER / 10;

	do {
		const randomPart = Math.floor(Math.random() * maxRandom);
		// Prefix the random part with '1' or '2' based on the scope
		newId = parseInt(`${scope === TodoScope.user ? 1 : 2}${randomPart}`);
	} while (todos.some((todo) => todo.id === newId));

	return newId;
}
