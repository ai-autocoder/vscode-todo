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
import { CreatePosition, getConfig } from "../utilities/config";
import {
	assertNever,
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
	addTodo: TodoActionCreator<{ text: string; position?: CreatePosition }>;
	addTodos: TodoActionCreator<{ texts: string[]; position?: CreatePosition }>;
	editTodo: TodoActionCreator<{ id: number; newText: string }>;
	toggleTodo: TodoActionCreator<{ id: number }>;
	toggleMarkdown: TodoActionCreator<{ id: number }>;
	toggleTodoNote: TodoActionCreator<{ id: number }>;
	deleteTodos: TodoActionCreator<{ ids: number[] }>;
};

export type TodoListItemKind = "task" | "note" | "all";

export type TodoListSortBy = "creationDate" | "completionDate" | "completed";
export type TodoListSortOrder = "asc" | "desc";

export type TodoListFilters = {
	/** Restrict by item kind: "task" (checkable), "note" (free-text), or "all" (default). */
	kind?: TodoListItemKind;
	/** When set, keep only items whose completion state matches (notes are never completed). */
	completed?: boolean;
	/** When set, keep only items whose text begins with this prefix (case-insensitive). */
	textPrefix?: string;
	/** When set, keep only items whose text contains this substring (case-insensitive). */
	search?: string;
	/** Explicit field to sort by. When omitted, the store's insertion order is preserved. */
	sortBy?: TodoListSortBy;
	/** Sort direction; defaults to "asc". Ignored when sortBy is omitted. */
	order?: TodoListSortOrder;
};

export type PaginationOptions = {
	limit?: number;
	offset?: number;
	/**
	 * Optional secondary cap on the serialized size of a page, in characters. The count
	 * `limit` is applied first; when `maxChars` is set, the page is then trimmed so its
	 * serialized payload stays under this budget. Items are never split — a single item
	 * larger than the budget is still returned alone so paging can always progress.
	 */
	maxChars?: number;
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

/**
 * Secondary, size-based trim applied after the count-based {@link paginate}. Walks the
 * already-sliced page accumulating each item's serialized length and cuts the page off
 * once `maxChars` would be exceeded, then recomputes `count` / `hasMore` / `nextOffset`
 * so a follow-up call (using `nextOffset` as its offset) returns the remainder.
 *
 * Items are never split or truncated. If the first item alone exceeds the budget it is
 * still returned (a page is never empty while items remain), so paging always advances.
 * When `maxChars` is undefined or non-positive, the page passes through unchanged.
 */
function applyCharBudget<T>(page: PaginatedResult<T>, maxChars?: number): PaginatedResult<T> {
	if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars <= 0) {
		return page;
	}

	let used = 0;
	let kept = 0;
	for (const item of page.items) {
		const size = JSON.stringify(item).length;
		// Always keep the first item even if it alone exceeds the budget, so paging progresses.
		if (kept > 0 && used + size > maxChars) {
			break;
		}
		used += size;
		kept += 1;
	}

	if (kept === page.items.length) {
		return page;
	}

	const items = page.items.slice(0, kept);
	const trimmedCount = page.items.length - kept;
	// Where this page ended before trimming: nextOffset if more remained, else total
	// (the page reached the end of the list). Subtract what we trimmed to get the new
	// boundary, which the caller passes back as `offset` to fetch the remainder.
	const previousEnd = page.nextOffset !== undefined ? page.nextOffset : page.total;
	return {
		items,
		total: page.total,
		count: items.length,
		hasMore: true,
		nextOffset: previousEnd - trimmedCount,
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
		const sorted = this.applySort(filtered, filters);

		return {
			scope,
			filePath,
			todos: sorted,
		};
	}

	public listTodosPaginated(
		scope: TodoScope,
		filters: TodoListFilters & { filePath?: string } = {},
		pagination: PaginationOptions = {}
	): { scope: TodoScope; filePath?: string } & PaginatedResult<Todo> {
		const { filePath, todos } = this.listTodos(scope, filters);
		const page = applyCharBudget(paginate(todos, pagination), pagination.maxChars);
		return {
			scope,
			filePath,
			...page,
		};
	}

	public async addTodo(
		scope: TodoScope,
		text: string,
		options: {
			isNote?: boolean;
			isMarkdown?: boolean;
			filePath?: string;
			position?: CreatePosition;
		} = {}
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

	/**
	 * Create several todos/notes in one call, preserving the given order. Unlike calling
	 * addTodo in a loop (which would reverse the block under createPosition "top" and emit
	 * one change event per item), this inserts the whole block as a single action so the
	 * resulting list reflects `items` order verbatim. `position` defaults to the store's
	 * createPosition setting when omitted.
	 */
	public async addTodos(
		scope: TodoScope,
		items: Array<{ text: string; isNote?: boolean; isMarkdown?: boolean }>,
		options: { filePath?: string; position?: CreatePosition } = {}
	): Promise<{ scope: TodoScope; filePath?: string; todos: Todo[] }> {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);
		this.assertWritable();

		if (scope === TodoScope.currentFile) {
			const filePath = this.resolveFilePath(options.filePath);
			const currentFilePath = this.store.getState().currentFile.filePath;
			if (this.isSameFilePath(currentFilePath, filePath)) {
				return this.addTodosViaStore(currentFileActions, scope, items, options.position, filePath);
			}
			return this.addTodosForNonCurrentFile(filePath, items, options.position);
		}

		return this.addTodosViaStore(
			scope === TodoScope.user ? userActions : workspaceActions,
			scope,
			items,
			options.position
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
				// Idempotent: leave an already-matching item (and its completionDate) untouched.
				if (todo.completed === completed) {
					return;
				}
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
		options?: { filePath?: string; position?: CreatePosition }
	): { scope: TodoScope; filePath?: string; todo: Todo } | null {
		const state = this.getScopeState(scope);
		const beforeIds = new Set(state.todos.map((todo) => todo.id));
		this.store.dispatch(actions.addTodo({ text, position: options?.position }));
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
		options: { isNote?: boolean; isMarkdown?: boolean; filePath?: string; position?: CreatePosition },
		filePath?: string
	): { scope: TodoScope; filePath?: string; todo: Todo } | null {
		const result = this.addTodoViaStore(actions, scope, text, {
			filePath,
			position: options.position,
		});
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

	private addTodosViaStore(
		actions: TodoActions,
		scope: TodoScope,
		items: Array<{ text: string; isNote?: boolean; isMarkdown?: boolean }>,
		position: CreatePosition | undefined,
		filePath?: string
	): { scope: TodoScope; filePath?: string; todos: Todo[] } {
		const beforeIds = new Set(this.getScopeState(scope).todos.map((todo) => todo.id));
		this.store.dispatch(actions.addTodos({ texts: items.map((item) => item.text), position }));

		// Collect the freshly added items in the order they appear in the post-dispatch list.
		// Invariant that makes positional alignment with `items` valid: the addTodos reducer
		// always creates the block as contiguous, all-incomplete tasks and inserts it as a unit
		// (unshift for "top"; push + stable sortTodosWithNotes for "bottom"). A fresh block never
		// reorders among itself under either sort type, so its display order equals input order.
		// (The notes-interleaved batch test in the suite locks this in.)
		const added: Todo[] = [];
		for (const todo of this.getScopeState(scope).todos) {
			if (!beforeIds.has(todo.id)) {
				added.push(todo);
			}
		}

		// Apply each item's optional isNote/isMarkdown flag by id (same per-item toggle pattern
		// as addTodoWithOptions).
		items.forEach((item, index) => {
			const todo = added[index];
			if (!todo) {
				return;
			}
			if (item.isNote !== undefined && item.isNote !== todo.isNote) {
				this.store.dispatch(actions.toggleTodoNote({ id: todo.id }));
			}
			if (item.isMarkdown !== undefined && item.isMarkdown !== todo.isMarkdown) {
				this.store.dispatch(actions.toggleMarkdown({ id: todo.id }));
			}
		});

		// Re-read so the returned items reflect any flag toggles, preserving input order.
		const finalById = new Map(
			this.getScopeState(scope).todos.map((todo) => [todo.id, todo] as const)
		);
		const todos = added.map((todo) => finalById.get(todo.id) ?? todo);
		return { scope, filePath, todos };
	}

	private async addTodosForNonCurrentFile(
		filePath: string,
		items: Array<{ text: string; isNote?: boolean; isMarkdown?: boolean }>,
		position: CreatePosition | undefined
	): Promise<{ scope: TodoScope; filePath: string; todos: Todo[] }> {
		const existing = this.getFileTodos(filePath);
		const config = getConfig();
		const resolvedPosition = position ?? config.createPosition;

		const block: Todo[] = [];
		for (const item of items) {
			block.push({
				id: generateUniqueId([...existing, ...block]),
				text: item.text,
				completed: false,
				creationDate: new Date().toISOString(),
				isMarkdown: item.isMarkdown ?? config.createMarkdownByDefault,
				isNote: item.isNote ?? false,
			});
		}

		let updatedTodos: Todo[];
		if (resolvedPosition === "top") {
			updatedTodos = [...block, ...existing];
		} else {
			updatedTodos = sortTodosWithNotes([...existing, ...block]);
		}

		await this.persistFileTodos(filePath, updatedTodos);
		return { scope: TodoScope.currentFile, filePath, todos: block };
	}

	private async addTodoForNonCurrentFile(
		filePath: string,
		text: string,
		options: { isNote?: boolean; isMarkdown?: boolean; position?: CreatePosition }
	): Promise<{ scope: TodoScope; filePath: string; todo: Todo } | null> {
		const existing = this.getFileTodos(filePath);
		const config = getConfig();
		const position = options.position ?? config.createPosition;
		const newTodo: Todo = {
			id: generateUniqueId(existing),
			text,
			completed: false,
			creationDate: new Date().toISOString(),
			isMarkdown: options.isMarkdown ?? config.createMarkdownByDefault,
			isNote: options.isNote ?? false,
		};

		let updatedTodos: Todo[];
		if (position === "top") {
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
		// Compose independent predicates so new filters (e.g. a future tag filter) slot in
		// as one more entry without reworking the chain. An item is kept only if it passes
		// every active predicate.
		const predicates: Array<(todo: Todo) => boolean> = [];

		if (filters.kind === "task") {
			predicates.push((todo) => !todo.isNote);
		} else if (filters.kind === "note") {
			predicates.push((todo) => todo.isNote);
		}

		if (filters.completed !== undefined) {
			const completed = filters.completed;
			predicates.push((todo) => todo.completed === completed);
		}

		if (filters.textPrefix) {
			const prefix = filters.textPrefix;
			predicates.push((todo) => this.matchesPrefix(todo.text, prefix));
		}

		if (filters.search) {
			const needle = filters.search.toLowerCase();
			predicates.push((todo) => todo.text.toLowerCase().includes(needle));
		}

		if (predicates.length === 0) {
			return [...todos];
		}

		return todos.filter((todo) => predicates.every((predicate) => predicate(todo)));
	}

	/**
	 * Sort by an explicit field requested via the MCP query. Distinct from the UI's
	 * config-driven sortTodosWithNotes — this honors exactly what the caller asked for.
	 * When sortBy is omitted, the store's insertion order is preserved. The sort is
	 * stable (equal keys keep insertion order), and direction defaults to ascending.
	 */
	private applySort(todos: Todo[], filters: TodoListFilters): Todo[] {
		if (!filters.sortBy) {
			return todos;
		}

		const direction = filters.order === "desc" ? -1 : 1;
		const sortBy = filters.sortBy;
		const compare = (a: Todo, b: Todo): number => {
			switch (sortBy) {
				case "completed":
					// false (open) before true (done) in ascending order.
					return (Number(a.completed) - Number(b.completed)) * direction;
				case "creationDate":
					// ISO 8601 timestamps compare correctly as strings.
					return a.creationDate.localeCompare(b.creationDate) * direction;
				case "completionDate":
					// Open items have no completionDate; treat as empty so they group together.
					return (a.completionDate ?? "").localeCompare(b.completionDate ?? "") * direction;
				default:
					// Exhaustiveness guard: adding a TodoListSortBy member without a case here
					// becomes a compile error rather than a silent fall-through to no-sort.
					return assertNever(sortBy);
			}
		};

		return todos.slice().sort(compare);
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
