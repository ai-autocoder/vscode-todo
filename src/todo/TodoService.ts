import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import StorageSyncManager from "../storage/StorageSyncManager";
import {
	currentFileActions,
	editorFocusAndRecordsActions,
	userActions,
	workspaceActions,
} from "../todo/store";
import {
	CurrentFileSlice,
	StoreState,
	Todo,
	TodoFilesData,
	TodoFilesDataPaths,
	TodoScope,
} from "../todo/todoTypes";
import { getConfig } from "../utilities/config";
import {
	ensureFilesDataPaths,
	generateUniqueId,
	getRelativePathIfInsideWorkspace,
	getWorkspaceFilesWithRecords,
	getWorkspacePath,
	normalizeAbsolutePath,
	normalizeRelativePath,
	resolveFilesDataKey,
	sortTodosWithNotes,
} from "../todo/todoUtils";

type AllowedScope = "user" | "workspace" | "file";
type TodoActionCreator<Payload> = (payload: Payload) => { type: string; payload: Payload };
type TodoActions = {
	addTodo: TodoActionCreator<{ text: string }>;
	editTodo: TodoActionCreator<{ id: number; newText: string }>;
	toggleTodo: TodoActionCreator<{ id: number }>;
	toggleMarkdown: TodoActionCreator<{ id: number }>;
	toggleTodoNote: TodoActionCreator<{ id: number }>;
	deleteTodos: TodoActionCreator<{ ids: number[] }>;
};

export type TodoListFilters = {
	noteOnly?: boolean;
	textPrefix?: string;
};

export type PaginationOptions = {
	limit?: number;
	offset?: number;
};

export type PaginatedResult<T> = {
	items: T[];
	total: number;
	count: number;
	hasMore: boolean;
	nextOffset?: number;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;

function paginate<T>(items: T[], options: PaginationOptions = {}): PaginatedResult<T> {
	const total = items.length;
	const limit = normalizeLimit(options.limit);
	const offset = normalizeOffset(options.offset);
	const page = items.slice(offset, offset + limit);
	const consumed = offset + page.length;
	const hasMore = consumed < total;
	return {
		items: page,
		total,
		count: page.length,
		hasMore,
		nextOffset: hasMore ? consumed : undefined,
	};
}

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		return DEFAULT_PAGE_LIMIT;
	}
	const rounded = Math.floor(limit);
	if (rounded <= 0) {
		return DEFAULT_PAGE_LIMIT;
	}
	return Math.min(rounded, MAX_PAGE_LIMIT);
}

function normalizeOffset(offset?: number): number {
	if (typeof offset !== "number" || !Number.isFinite(offset)) {
		return 0;
	}
	const rounded = Math.floor(offset);
	return rounded > 0 ? rounded : 0;
}

export default class TodoService {
	private readOnly = true;
	private allowedScopes = new Set<AllowedScope>(["user", "workspace", "file"]);

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: EnhancedStore<StoreState>,
		private readonly storageSyncManager: StorageSyncManager
	) {}

	public updateAccess(readOnly: boolean, allowedScopes: AllowedScope[]): void {
		this.readOnly = readOnly;
		this.allowedScopes = new Set(
			allowedScopes.filter((scope) => scope === "user" || scope === "workspace" || scope === "file")
		);
	}

	public isScopeAllowed(scope: TodoScope): boolean {
		return this.allowedScopes.has(this.mapScopeToAllowed(scope));
	}

	public getCounts(): {
		user?: { todos: number; notes: number };
		workspace?: { todos: number; notes: number };
		currentFile?: { todos: number; notes: number; filePath: string };
	} {
		const state = this.store.getState();
		const result: {
			user?: { todos: number; notes: number };
			workspace?: { todos: number; notes: number };
			currentFile?: { todos: number; notes: number; filePath: string };
		} = {};

		if (this.isScopeAllowed(TodoScope.user)) {
			result.user = {
				todos: state.user.numberOfTodos,
				notes: state.user.numberOfNotes,
			};
		}

		if (this.isScopeAllowed(TodoScope.workspace)) {
			result.workspace = {
				todos: state.workspace.numberOfTodos,
				notes: state.workspace.numberOfNotes,
			};
		}

		if (this.isScopeAllowed(TodoScope.currentFile)) {
			result.currentFile = {
				todos: state.currentFile.numberOfTodos,
				notes: state.currentFile.numberOfNotes,
				filePath: state.currentFile.filePath,
			};
		}

		return result;
	}

	public listFiles(): Array<{ filePath: string; todoNumber: number }> {
		this.assertScopeAllowed(TodoScope.currentFile);
		this.assertWorkspaceAvailable(TodoScope.currentFile);
		const { filesData } = this.getFilesSnapshot();
		return getWorkspaceFilesWithRecords(filesData);
	}

	public listFilesPaginated(
		pagination: PaginationOptions = {}
	): PaginatedResult<{ filePath: string; todoNumber: number }> {
		return paginate(this.listFiles(), pagination);
	}

	public listTodos(
		scope: TodoScope,
		filters: TodoListFilters & { filePath?: string } = {}
	): { scope: TodoScope; filePath?: string; todos: Todo[] } {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);

		const { todos, filePath } = this.getTodosForScope(scope, filters.filePath);
		const filtered = this.applyFilters(todos, filters);

		return {
			scope,
			filePath,
			todos: filtered,
		};
	}

	public listTodosPaginated(
		scope: TodoScope,
		filters: TodoListFilters & { filePath?: string } = {},
		pagination: PaginationOptions = {}
	): { scope: TodoScope; filePath?: string } & PaginatedResult<Todo> {
		const { filePath, todos } = this.listTodos(scope, filters);
		const page = paginate(todos, pagination);
		return {
			scope,
			filePath,
			...page,
		};
	}

	public async addTodo(
		scope: TodoScope,
		text: string,
		options: { isNote?: boolean; isMarkdown?: boolean; filePath?: string } = {}
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo } | null> {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);
		this.assertWritable();

		if (scope === TodoScope.currentFile) {
			const filePath = this.resolveFilePath(options.filePath);
			const currentFilePath = this.store.getState().currentFile.filePath;
			if (this.isSameFilePath(currentFilePath, filePath)) {
				return this.addTodoWithOptions(currentFileActions, scope, text, options, filePath);
			}
			return this.addTodoForNonCurrentFile(filePath, text, options);
		}

		return this.addTodoWithOptions(
			scope === TodoScope.user ? userActions : workspaceActions,
			scope,
			text,
			options
		);
	}

	public async updateTodoText(
		scope: TodoScope,
		id: number,
		newText: string,
		options: { filePath?: string } = {}
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo }> {
		return this.mutateTodo(scope, id, options.filePath, {
			dispatch: (actions) => actions.editTodo({ id, newText }),
			mutateFile: (todo) => {
				todo.text = newText;
			},
		});
	}

	public async setCompleted(
		scope: TodoScope,
		id: number,
		completed: boolean,
		options: { filePath?: string } = {}
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo }> {
		return this.mutateTodo(scope, id, options.filePath, {
			// toggleTodo flips, so only dispatch when the value actually changes (idempotent).
			dispatch: (actions, current) =>
				current.completed === completed ? undefined : actions.toggleTodo({ id }),
			mutateFile: (todo) => {
				todo.completed = completed;
				todo.completionDate = completed ? new Date().toISOString() : undefined;
			},
		});
	}

	public async setNote(
		scope: TodoScope,
		id: number,
		isNote: boolean,
		options: { filePath?: string } = {}
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo }> {
		return this.mutateTodo(scope, id, options.filePath, {
			dispatch: (actions, current) =>
				current.isNote === isNote ? undefined : actions.toggleTodoNote({ id }),
			mutateFile: (todo) => {
				todo.isNote = isNote;
			},
		});
	}

	public async setMarkdown(
		scope: TodoScope,
		id: number,
		isMarkdown: boolean,
		options: { filePath?: string } = {}
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo }> {
		return this.mutateTodo(scope, id, options.filePath, {
			dispatch: (actions, current) =>
				current.isMarkdown === isMarkdown ? undefined : actions.toggleMarkdown({ id }),
			mutateFile: (todo) => {
				todo.isMarkdown = isMarkdown;
			},
		});
	}

	public async deleteTodos(
		scope: TodoScope,
		ids: number[],
		options: { filePath?: string } = {}
	): Promise<{ scope: TodoScope; filePath?: string; deleted: Todo[]; count: number }> {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);
		this.assertWritable();

		const idSet = new Set(ids);

		if (scope === TodoScope.currentFile) {
			const filePath = this.resolveFilePath(options.filePath);
			if (!this.isActiveFile(filePath)) {
				let deleted: Todo[] = [];
				await this.mutateFileTodos(filePath, (todos) => {
					deleted = todos.filter((todo) => idSet.has(todo.id));
					return todos.filter((todo) => !idSet.has(todo.id));
				});
				return { scope, filePath, deleted, count: deleted.length };
			}
			const deleted = this.store
				.getState()
				.currentFile.todos.filter((todo) => idSet.has(todo.id));
			this.store.dispatch(currentFileActions.deleteTodos({ ids }));
			return { scope, filePath, deleted, count: deleted.length };
		}

		const deleted = this.getScopeState(scope).todos.filter((todo) => idSet.has(todo.id));
		this.store.dispatch(this.actionsForScope(scope).deleteTodos({ ids }));
		return { scope, filePath: undefined, deleted, count: deleted.length };
	}

	private async mutateTodo(
		scope: TodoScope,
		id: number,
		filePath: string | undefined,
		handlers: {
			dispatch: (
				actions: TodoActions,
				current: Todo
			) => { type: string } | undefined;
			mutateFile: (todo: Todo) => void;
		}
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo }> {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);
		this.assertWritable();

		if (scope === TodoScope.currentFile) {
			const resolvedPath = this.resolveFilePath(filePath);
			if (!this.isActiveFile(resolvedPath)) {
				let updated: Todo | undefined;
				await this.mutateFileTodos(resolvedPath, (todos) => {
					const target = todos.find((todo) => todo.id === id);
					if (!target) {
						throw this.notFoundError(id, scope);
					}
					handlers.mutateFile(target);
					updated = target;
					return todos;
				});
				return { scope, filePath: resolvedPath, todo: updated as Todo };
			}
			const updated = this.applyStoreMutation(scope, currentFileActions, id, handlers.dispatch);
			return { scope, filePath: resolvedPath, todo: updated };
		}

		const updated = this.applyStoreMutation(scope, this.actionsForScope(scope), id, handlers.dispatch);
		return { scope, filePath: undefined, todo: updated };
	}

	private applyStoreMutation(
		scope: TodoScope,
		actions: TodoActions,
		id: number,
		dispatch: (actions: TodoActions, current: Todo) => { type: string } | undefined
	): Todo {
		const current = this.getScopeState(scope).todos.find((todo) => todo.id === id);
		if (!current) {
			throw this.notFoundError(id, scope);
		}
		const action = dispatch(actions, current);
		if (action) {
			this.store.dispatch(action);
		}
		const updated = this.getScopeState(scope).todos.find((todo) => todo.id === id);
		return updated ?? current;
	}

	private async mutateFileTodos(
		filePath: string,
		mutator: (todos: Todo[]) => Todo[]
	): Promise<Todo[]> {
		const current = this.getFileTodos(filePath).map((todo) => ({ ...todo }));
		const updated = mutator(current);
		await this.persistFileTodos(filePath, updated);
		return updated;
	}

	private actionsForScope(scope: TodoScope): TodoActions {
		switch (scope) {
			case TodoScope.user:
				return userActions;
			case TodoScope.workspace:
				return workspaceActions;
			case TodoScope.currentFile:
				return currentFileActions;
		}
	}

	private isActiveFile(filePath: string): boolean {
		const currentFilePath = this.store.getState().currentFile.filePath;
		return this.isSameFilePath(currentFilePath, filePath);
	}

	private notFoundError(id: number, scope: TodoScope): Error {
		return new Error(`No todo with id ${id} was found in scope "${scope}".`);
	}

	private addTodoViaStore(
		actions: TodoActions,
		scope: TodoScope,
		text: string,
		options?: { filePath?: string }
	): { scope: TodoScope; filePath?: string; todo: Todo } | null {
		const state = this.getScopeState(scope);
		const beforeIds = new Set(state.todos.map((todo) => todo.id));
		this.store.dispatch(actions.addTodo({ text }));
		const updated = this.getScopeState(scope).todos;
		const added = updated.find((todo) => !beforeIds.has(todo.id));

		if (!added) {
			return null;
		}

		return { scope, filePath: options?.filePath, todo: added };
	}

	private addTodoWithOptions(
		actions: TodoActions,
		scope: TodoScope,
		text: string,
		options: { isNote?: boolean; isMarkdown?: boolean; filePath?: string },
		filePath?: string
	): { scope: TodoScope; filePath?: string; todo: Todo } | null {
		const result = this.addTodoViaStore(actions, scope, text, { filePath });
		if (!result) {
			return null;
		}

		if (options.isNote !== undefined && options.isNote !== result.todo.isNote) {
			this.store.dispatch(actions.toggleTodoNote({ id: result.todo.id }));
		}
		if (options.isMarkdown !== undefined && options.isMarkdown !== result.todo.isMarkdown) {
			this.store.dispatch(actions.toggleMarkdown({ id: result.todo.id }));
		}

		const updated = this.getScopeState(scope).todos.find((todo) => todo.id === result.todo.id);
		return updated ? { ...result, todo: updated } : result;
	}

	private async addTodoForNonCurrentFile(
		filePath: string,
		text: string,
		options: { isNote?: boolean; isMarkdown?: boolean }
	): Promise<{ scope: TodoScope; filePath: string; todo: Todo } | null> {
		const existing = this.getFileTodos(filePath);
		const config = getConfig();
		const newTodo: Todo = {
			id: generateUniqueId(existing),
			text,
			completed: false,
			creationDate: new Date().toISOString(),
			isMarkdown: options.isMarkdown ?? config.createMarkdownByDefault,
			isNote: options.isNote ?? false,
		};

		let updatedTodos: Todo[];
		if (config.createPosition === "top") {
			updatedTodos = [newTodo, ...existing];
		} else {
			updatedTodos = [...existing, newTodo];
			updatedTodos = sortTodosWithNotes(updatedTodos);
		}

		await this.persistFileTodos(filePath, updatedTodos);
		return { scope: TodoScope.currentFile, filePath, todo: newTodo };
	}

	private async persistFileTodos(filePath: string, todos: Todo[]): Promise<void> {
		const slice: CurrentFileSlice = {
			filePath,
			isPinned: false,
			todos,
			lastActionType: "todo/update",
			numberOfTodos: todos.filter((todo) => !todo.completed && !todo.isNote).length,
			numberOfNotes: todos.filter((todo) => todo.isNote).length,
			scope: TodoScope.currentFile,
		};

		await this.storageSyncManager.persistSlice(slice);
		this.refreshWorkspaceFileList();
	}

	private refreshWorkspaceFileList(): void {
		const { filesData, filesDataPaths } = this.getFilesSnapshot();
		const normalizedPaths = ensureFilesDataPaths(filesData, filesDataPaths, getWorkspacePath());
		this.store.dispatch(
			editorFocusAndRecordsActions.setWorkspaceFilesWithRecords({
				workspaceFilesWithRecords: getWorkspaceFilesWithRecords(filesData),
				filesDataPaths: normalizedPaths,
			})
		);
	}

	private getTodosForScope(
		scope: TodoScope,
		filePath?: string
	): { todos: Todo[]; filePath?: string } {
		if (scope === TodoScope.currentFile) {
			const resolvedPath = this.resolveFilePath(filePath);
			const currentPath = this.store.getState().currentFile.filePath;
			if (currentPath && this.isSameFilePath(currentPath, resolvedPath)) {
				return { todos: this.store.getState().currentFile.todos, filePath: currentPath };
			}
			return {
				todos: this.getFileTodos(resolvedPath),
				filePath: resolvedPath,
			};
		}

		const slice = this.getScopeState(scope);
		return { todos: slice.todos };
	}

	private getScopeState(scope: TodoScope): { todos: Todo[] } {
		const state = this.store.getState();
		switch (scope) {
			case TodoScope.user:
				return state.user;
			case TodoScope.workspace:
				return state.workspace;
			case TodoScope.currentFile:
				return state.currentFile;
		}
	}

	private getFileTodos(filePath: string): Todo[] {
		const { filesData, filesDataPaths } = this.getFilesSnapshot();
		const resolved = resolveFilesDataKey({ filePath, filesData, filesDataPaths });
		if (resolved.key && filesData[resolved.key]) {
			return filesData[resolved.key] ?? [];
		}
		return [];
	}

	private getFilesSnapshot(): { filesData: TodoFilesData; filesDataPaths: TodoFilesDataPaths } {
		const filesData = (this.context.workspaceState.get("TodoFilesData") as TodoFilesData) ?? {};
		const filesDataPaths =
			(this.context.workspaceState.get("TodoFilesDataPaths") as TodoFilesDataPaths) ?? {};
		return { filesData, filesDataPaths };
	}

	private resolveFilePath(filePath?: string): string {
		const resolved = filePath ?? this.store.getState().currentFile.filePath;
		if (!resolved) {
			throw new Error("File scope requires an active file or explicit filePath.");
		}
		return resolved;
	}

	private assertWorkspaceAvailable(scope: TodoScope): void {
		if (scope === TodoScope.user) {
			return;
		}
		if (!getWorkspacePath()) {
			throw new Error("Workspace scope requires an open folder.");
		}
	}

	private assertScopeAllowed(scope: TodoScope): void {
		if (!this.isScopeAllowed(scope)) {
			throw new Error(`Scope "${scope}" is not permitted by MCP settings.`);
		}
	}

	private assertWritable(): void {
		if (this.readOnly) {
			throw new Error("MCP server is in read-only mode.");
		}
	}

	private mapScopeToAllowed(scope: TodoScope): AllowedScope {
		if (scope === TodoScope.currentFile) {
			return "file";
		}
		return scope;
	}

	private applyFilters(todos: Todo[], filters: TodoListFilters): Todo[] {
		let filtered = [...todos];

		if (filters.noteOnly) {
			filtered = filtered.filter((todo) => todo.isNote);
		}

		if (filters.textPrefix) {
			filtered = filtered.filter((todo) =>
				this.matchesPrefix(todo.text, filters.textPrefix ?? "")
			);
		}

		return filtered;
	}

	private matchesPrefix(text: string, prefix: string): boolean {
		const trimmed = text.trimStart();
		return trimmed.toLowerCase().startsWith(prefix.trimStart().toLowerCase());
	}

	private isSameFilePath(left: string, right: string): boolean {
		if (!left || !right) {
			return false;
		}
		if (normalizeAbsolutePath(left) === normalizeAbsolutePath(right)) {
			return true;
		}
		const leftRel = getRelativePathIfInsideWorkspace(left);
		const rightRel = getRelativePathIfInsideWorkspace(right);
		if (leftRel && rightRel) {
			return normalizeRelativePath(leftRel) === normalizeRelativePath(rightRel);
		}
		if (leftRel) {
			return normalizeRelativePath(leftRel) === normalizeRelativePath(right);
		}
		if (rightRel) {
			return normalizeRelativePath(left) === normalizeRelativePath(rightRel);
		}
		return false;
	}
}
