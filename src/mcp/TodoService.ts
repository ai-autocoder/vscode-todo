import { EnhancedStore } from "@reduxjs/toolkit";
import * as vscode from "vscode";
import StorageSyncManager from "../storage/StorageSyncManager";
import { SyncManager } from "../sync/SyncManager";
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
	toggleCollapsed: TodoActionCreator<{ id: number }>;
	deleteTodo: TodoActionCreator<{ id: number }>;
	deleteTodos: TodoActionCreator<{ ids: number[] }>;
};

export type TodoListFilters = {
	noteOnly?: boolean;
	instructionOnly?: boolean;
	textPrefix?: string;
};

export type TodoUpdateFields = {
	text?: string;
	completed?: boolean;
	isMarkdown?: boolean;
	isNote?: boolean;
	collapsed?: boolean;
};

export type ScopedTodo = Todo & {
	scope: "user" | "workspace" | "file";
	filePath?: string;
};

export type PlanHeader = ScopedTodo & {
	slug: string;
	title: string;
};

const INSTRUCTION_PREFIX = "@instr";
const PLAN_ITEM_PREFIX = "@plan:";

export default class TodoService {
	private readOnly = true;
	private allowedScopes = new Set<AllowedScope>(["user", "workspace", "file"]);

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: EnhancedStore<StoreState>,
		private readonly storageSyncManager: StorageSyncManager,
		private readonly syncManager: SyncManager
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

	public getInstructionNotesForFile(filePath: string): ScopedTodo[] {
		this.assertScopeAllowed(TodoScope.currentFile);
		this.assertWorkspaceAvailable(TodoScope.currentFile);

		const resolvedPath = this.resolveFilePath(filePath);
		const notes: ScopedTodo[] = [];

		if (this.isScopeAllowed(TodoScope.currentFile)) {
			notes.push(
				...this.filterInstructionNotes(this.getFileTodos(resolvedPath)).map((todo) => ({
					...todo,
					scope: "file" as const,
					filePath: resolvedPath,
				}))
			);
		}

		if (this.isScopeAllowed(TodoScope.workspace)) {
			notes.push(
				...this.filterInstructionNotes(this.store.getState().workspace.todos).map((todo) => ({
					...todo,
					scope: "workspace" as const,
				}))
			);
		}

		if (this.isScopeAllowed(TodoScope.user)) {
			notes.push(
				...this.filterInstructionNotes(this.store.getState().user.todos).map((todo) => ({
					...todo,
					scope: "user" as const,
				}))
			);
		}

		return notes;
	}

	public getInstructionNotesForScope(
		scope: TodoScope,
		filePath?: string
	): ScopedTodo[] {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);

		const { todos, filePath: resolvedPath } = this.getTodosForScope(scope, filePath);
		const filtered = this.filterInstructionNotes(todos);
		const mappedScope = this.mapScopeToAllowed(scope);

		return filtered.map((todo) => ({
			...todo,
			scope: mappedScope,
			filePath: scope === TodoScope.currentFile ? resolvedPath : undefined,
		}));
	}

	public getPlanHeadersForScope(scope: TodoScope, filePath?: string): PlanHeader[] {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);

		const { todos, filePath: resolvedPath } = this.getTodosForScope(scope, filePath);
		const mappedScope = this.mapScopeToAllowed(scope);
		const headers: PlanHeader[] = [];

		for (const todo of todos) {
			if (!todo.isNote) {
				continue;
			}
			const parsed = this.parsePlanHeader(todo.text);
			if (!parsed) {
				continue;
			}
			headers.push({
				...todo,
				scope: mappedScope,
				filePath: scope === TodoScope.currentFile ? resolvedPath : undefined,
				slug: parsed.slug,
				title: parsed.title,
			});
		}

		return headers;
	}

	public getPlanItemsForScope(
		scope: TodoScope,
		slug: string,
		filePath?: string
	): ScopedTodo[] {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);

		const normalizedSlug = this.normalizePlanSlug(slug);
		if (!normalizedSlug) {
			throw new Error("Missing plan slug.");
		}

		const { todos, filePath: resolvedPath } = this.getTodosForScope(scope, filePath);
		const prefix = `${PLAN_ITEM_PREFIX}${normalizedSlug}`;
		const items = todos.filter((todo) => this.matchesPrefix(todo.text, prefix));
		const mappedScope = this.mapScopeToAllowed(scope);

		return items.map((todo) => ({
			...todo,
			scope: mappedScope,
			filePath: scope === TodoScope.currentFile ? resolvedPath : undefined,
		}));
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

	public async updateTodo(
		scope: TodoScope,
		id: number,
		fields: TodoUpdateFields,
		filePath?: string
	): Promise<{ scope: TodoScope; filePath?: string; todo: Todo | null }> {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);
		this.assertWritable();

		if (scope === TodoScope.currentFile) {
			const resolvedPath = this.resolveFilePath(filePath);
			const currentFilePath = this.store.getState().currentFile.filePath;
			if (this.isSameFilePath(currentFilePath, resolvedPath)) {
				const todo = this.updateTodoViaStore(currentFileActions, scope, id, fields);
				return { scope, filePath: resolvedPath, todo };
			}
			const todo = await this.updateTodoForNonCurrentFile(resolvedPath, id, fields);
			return { scope, filePath: resolvedPath, todo };
		}

		const todo = this.updateTodoViaStore(
			scope === TodoScope.user ? userActions : workspaceActions,
			scope,
			id,
			fields
		);
		return { scope, todo };
	}

	public async deleteTodos(
		scope: TodoScope,
		ids: number[],
		filePath?: string
	): Promise<{ scope: TodoScope; filePath?: string; deletedIds: number[]; remainingCount: number }> {
		this.assertScopeAllowed(scope);
		this.assertWorkspaceAvailable(scope);
		this.assertWritable();

		if (scope === TodoScope.currentFile) {
			const resolvedPath = this.resolveFilePath(filePath);
			const currentFilePath = this.store.getState().currentFile.filePath;
			if (this.isSameFilePath(currentFilePath, resolvedPath)) {
				const remainingCount = this.deleteTodosViaStore(currentFileActions, scope, ids);
				return { scope, filePath: resolvedPath, deletedIds: ids, remainingCount };
			}
			const remainingCount = await this.deleteTodosForNonCurrentFile(resolvedPath, ids);
			return { scope, filePath: resolvedPath, deletedIds: ids, remainingCount };
		}

		const remainingCount = this.deleteTodosViaStore(
			scope === TodoScope.user ? userActions : workspaceActions,
			scope,
			ids
		);

		return { scope, deletedIds: ids, remainingCount };
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

		const updates: TodoUpdateFields = {};
		if (options.isNote !== undefined) {
			updates.isNote = options.isNote;
		}
		if (options.isMarkdown !== undefined) {
			updates.isMarkdown = options.isMarkdown;
		}

		if (Object.keys(updates).length > 0) {
			const updated = this.updateTodoViaStore(actions, scope, result.todo.id, updates);
			if (updated) {
				return { ...result, todo: updated };
			}
		}

		return result;
	}

	private updateTodoViaStore(
		actions: TodoActions,
		scope: TodoScope,
		id: number,
		fields: TodoUpdateFields
	): Todo | null {
		const current = this.getScopeState(scope).todos.find((todo) => todo.id === id);
		if (!current) {
			return null;
		}

		if (fields.text !== undefined && fields.text !== current.text) {
			this.store.dispatch(actions.editTodo({ id, newText: fields.text }));
		}
		if (fields.completed !== undefined && fields.completed !== current.completed) {
			this.store.dispatch(actions.toggleTodo({ id }));
		}
		if (fields.isMarkdown !== undefined && fields.isMarkdown !== current.isMarkdown) {
			this.store.dispatch(actions.toggleMarkdown({ id }));
		}
		if (fields.isNote !== undefined && fields.isNote !== current.isNote) {
			this.store.dispatch(actions.toggleTodoNote({ id }));
		}
		if (fields.collapsed !== undefined && fields.collapsed !== (current.collapsed ?? false)) {
			this.store.dispatch(actions.toggleCollapsed({ id }));
		}

		const updated = this.getScopeState(scope).todos.find((todo) => todo.id === id) ?? null;
		return updated;
	}

	private deleteTodosViaStore(
		actions: TodoActions,
		scope: TodoScope,
		ids: number[]
	): number {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 1) {
			this.store.dispatch(actions.deleteTodo({ id: uniqueIds[0] }));
		} else if (uniqueIds.length > 1) {
			this.store.dispatch(actions.deleteTodos({ ids: uniqueIds }));
		}
		return this.getScopeState(scope).todos.length;
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

	private async updateTodoForNonCurrentFile(
		filePath: string,
		id: number,
		fields: TodoUpdateFields
	): Promise<Todo | null> {
		const existing = this.getFileTodos(filePath);
		const index = existing.findIndex((todo) => todo.id === id);
		if (index < 0) {
			return null;
		}

		const current = existing[index];
		const updated: Todo = { ...current };

		if (fields.text !== undefined) {
			updated.text = fields.text;
		}
		if (fields.completed !== undefined) {
			updated.completed = fields.completed;
			updated.completionDate = fields.completed ? new Date().toISOString() : undefined;
		}
		if (fields.isMarkdown !== undefined) {
			updated.isMarkdown = fields.isMarkdown;
		}
		if (fields.isNote !== undefined) {
			updated.isNote = fields.isNote;
		}
		if (fields.collapsed !== undefined) {
			updated.collapsed = fields.collapsed;
		}

		const nextTodos = [...existing];
		nextTodos[index] = updated;

		const shouldResort =
			(fields.completed !== undefined && fields.completed !== current.completed) ||
			(fields.isNote !== undefined && fields.isNote !== current.isNote);
		const finalTodos = shouldResort ? sortTodosWithNotes(nextTodos) : nextTodos;

		await this.persistFileTodos(filePath, finalTodos);
		return finalTodos.find((todo) => todo.id === id) ?? null;
	}

	private async deleteTodosForNonCurrentFile(filePath: string, ids: number[]): Promise<number> {
		const existing = this.getFileTodos(filePath);
		const deleteIds = new Set(ids);
		const updated = existing.filter((todo) => !deleteIds.has(todo.id));
		await this.persistFileTodos(filePath, updated);
		return updated.length;
	}

	private async persistFileTodos(filePath: string, todos: Todo[]): Promise<void> {
		const slice: CurrentFileSlice = {
			filePath,
			isPinned: false,
			todos,
			lastActionType: "mcp/update",
			numberOfTodos: todos.filter((todo) => !todo.completed && !todo.isNote).length,
			numberOfNotes: todos.filter((todo) => todo.isNote).length,
			scope: TodoScope.currentFile,
		};

		await this.storageSyncManager.persistSlice(slice);
		this.refreshWorkspaceFileList();

		const workspaceMode = this.context.workspaceState.get<string>("syncMode", "local");
		if (workspaceMode === "github") {
			this.syncManager.triggerDebounceSync("workspace");
		}
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

		if (filters.instructionOnly) {
			filtered = this.filterInstructionNotes(filtered);
		} else if (filters.noteOnly) {
			filtered = filtered.filter((todo) => todo.isNote);
		}

		if (filters.textPrefix) {
			filtered = filtered.filter((todo) =>
				this.matchesPrefix(todo.text, filters.textPrefix ?? "")
			);
		}

		return filtered;
	}

	private filterInstructionNotes(todos: Todo[]): Todo[] {
		return todos.filter((todo) => todo.isNote && this.matchesInstructionPrefix(todo.text));
	}

	private matchesInstructionPrefix(text: string): boolean {
		const trimmed = text.trimStart();
		const lower = trimmed.toLowerCase();
		if (!lower.startsWith(INSTRUCTION_PREFIX)) {
			return false;
		}
		if (lower.length === INSTRUCTION_PREFIX.length) {
			return true;
		}
		const nextChar = lower.charAt(INSTRUCTION_PREFIX.length);
		return nextChar === ":" || /\s/.test(nextChar);
	}

	private normalizePlanSlug(slug: string): string {
		return slug.trim().toLowerCase();
	}

	private parsePlanHeader(text: string): { slug: string; title: string } | null {
		const trimmed = text.trimStart();
		const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
		const match = firstLine.match(/^@plan\s+([^\s]+)(?:\s+(.*))?$/i);
		if (!match) {
			return null;
		}
		const slug = this.normalizePlanSlug(match[1] ?? "");
		if (!slug) {
			return null;
		}
		const title = (match[2] ?? "").trim();
		return { slug, title };
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
