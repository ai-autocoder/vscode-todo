import { Component, Input, OnInit } from "@angular/core";
import { TodoService } from "../todo/todo.service";
import { ExportFormats, ImportFormats, TodoScope } from "../../../../src/todo/todoTypes";
import { Observable } from "rxjs";

@Component({
    selector: "app-header",
    templateUrl: "./header.component.html",
    styleUrl: "./header.component.css",
    standalone: false
})
export class HeaderComponent implements OnInit {
	ExportFormats = ExportFormats;
	ImportFormats = ImportFormats;
	isImportMenuOpen = false;
	isExportMenuOpen = false;
	isSettingsMenuOpen = false;
	enableWideView!: Observable<boolean>;
	isGitHubConnected!: Observable<boolean>;
	isGistIdConfigured!: Observable<boolean>;
	isSyncing!: Observable<boolean>;
	@Input() currentScope!: TodoScope;

	constructor(readonly todoService: TodoService) {}

	ngOnInit(): void {
		this.enableWideView = this.todoService.enableWideView;
		this.isGitHubConnected = this.todoService.isGitHubConnected;
		this.isGistIdConfigured = this.todoService.hasGistId;
		this.isSyncing = this.todoService.isSyncing;
	}

	import(format: ImportFormats) {
		this.todoService.import(format);
	}

	export(format: ExportFormats) {
		this.todoService.export(format);
	}

	onImportMenuOpened() {
		this.isImportMenuOpen = true;
	}

	onImportMenuClosed() {
		this.isImportMenuOpen = false;
	}

	onExportMenuOpened() {
		this.isExportMenuOpen = true;
	}

	onExportMenuClosed() {
		this.isExportMenuOpen = false;
	}

	setWideViewEnabled(isEnabled: boolean) {
		this.todoService.setWideViewEnabled(isEnabled);
	}

	deleteAll() {
		this.todoService.deleteAll(this.currentScope);
	}

	deleteCompleted() {
		this.todoService.deleteCompleted(this.currentScope);
	}

	get hasCompletedTodos(): boolean {
		switch (this.currentScope) {
			case TodoScope.user:
				return this.todoService.userTodos.some(todo => todo.completed && !todo.isNote);
			case TodoScope.workspace:
				return this.todoService.workspaceTodos.some(todo => todo.completed && !todo.isNote);
			case TodoScope.currentFile:
				return this.todoService.currentFileTodos.some(todo => todo.completed && !todo.isNote);
			default:
				return false;
		}
	}

	get isListEmpty(): boolean {
		switch (this.currentScope) {
			case TodoScope.user:
				return this.todoService.userTodos.length === 0;
			case TodoScope.workspace:
				return this.todoService.workspaceTodos.length === 0;
			case TodoScope.currentFile:
				return this.todoService.currentFileTodos.length === 0;
			default:
				return true;
		}
	}

	get allCollapsed(): boolean {
		const items = this.getTodosByScope();
		return items.length > 0 && items.every((t) => t.collapsed === true);
	}

	get hasAnyCollapsed(): boolean {
		const items = this.getTodosByScope();
		return items.some((t) => t.collapsed === true);
	}

	private getTodosByScope() {
		switch (this.currentScope) {
			case TodoScope.user:
				return this.todoService.userTodos;
			case TodoScope.workspace:
				return this.todoService.workspaceTodos;
			case TodoScope.currentFile:
				return this.todoService.currentFileTodos;
			default:
				return [];
		}
	}

	toggleAllCollapsed() {
		const nextCollapsed = !this.allCollapsed;
		this.todoService.setAllCollapsed(this.currentScope, { collapsed: nextCollapsed });
	}

	onSettingsMenuOpened() {
		this.isSettingsMenuOpen = true;
	}

	onSettingsMenuClosed() {
		this.isSettingsMenuOpen = false;
	}

	selectUserSyncMode() {
		this.todoService.selectUserSyncMode();
	}

	selectWorkspaceSyncMode() {
		this.todoService.selectWorkspaceSyncMode();
	}

	connectGitHub() {
		this.todoService.connectGitHub();
	}

	disconnectGitHub() {
		this.todoService.disconnectGitHub();
	}

	setUserFile() {
		this.todoService.setUserFile();
	}

	setWorkspaceFile() {
		this.todoService.setWorkspaceFile();
	}

	openGistIdSettings() {
		this.todoService.openGistIdSettings();
	}

	viewGistOnGitHub() {
		this.todoService.viewGistOnGitHub();
	}

	syncNow() {
		this.todoService.syncNow();
	}
}
