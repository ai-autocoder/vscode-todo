import { Component, Input, OnInit } from "@angular/core";
import { TodoService } from "../todo/todo.service";
import { ExportFormats, ImportFormats, TodoScope } from "../../../../src/todo/todoTypes";
import { combineLatest, map, Observable } from "rxjs";
import { GitHubSyncInfo } from "../../../../src/panels/message";

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
	isGitHubSyncEnabled!: Observable<boolean>;
	isSyncing!: Observable<boolean>;
	syncTooltip!: Observable<string>;
	@Input() currentScope!: TodoScope;

	constructor(readonly todoService: TodoService) {}

	ngOnInit(): void {
		this.enableWideView = this.todoService.enableWideView;
		this.isGitHubConnected = this.todoService.isGitHubConnected;
		this.isGistIdConfigured = this.todoService.hasGistId;
		this.isGitHubSyncEnabled = this.todoService.gitHubSyncInfo.pipe(
			map((info) => info.isGitHubSyncEnabled)
		);
		this.isSyncing = this.todoService.isSyncing;
		this.syncTooltip = combineLatest([
			this.todoService.gitHubSyncInfo,
			this.todoService.isSyncing,
			this.todoService.now,
		]).pipe(map(([info, isSyncing, nowMs]) => this.buildSyncTooltip(info, isSyncing, nowMs)));
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

	private buildSyncTooltip(info: GitHubSyncInfo, isSyncing: boolean, nowMs: number): string {
		if (!info.isGitHubSyncEnabled) {
			return (
				"GitHub Gist sync is off for all scopes. " +
				"Enable it via Settings menu > Sync Mode > User/Workspace."
			);
		}

		const summary = isSyncing ? "Syncing with GitHub Gist..." : "Sync GitHub Gist now.";
		const userDetail = info.userSyncEnabled
			? `User: last synced ${this.formatElapsed(info.userLastSynced, nowMs)}`
			: "User: GitHub sync off";
		const workspaceDetail = info.workspaceSyncEnabled
			? `Workspace: last synced ${this.formatElapsed(info.workspaceLastSynced, nowMs)}`
			: "Workspace: GitHub sync off";

		return `${summary}\nScopes:\n${userDetail}\n${workspaceDetail}`;
	}

	private formatElapsed(lastSynced: string | undefined, nowMs: number): string {
		if (!lastSynced) {
			return "never";
		}

		const lastMs = Date.parse(lastSynced);
		if (Number.isNaN(lastMs)) {
			return "unknown";
		}

		const deltaSeconds = Math.max(0, Math.floor((nowMs - lastMs) / 1000));

		if (deltaSeconds < 60) {
			return "just now";
		}

		const minutes = Math.floor(deltaSeconds / 60);
		if (minutes < 60) {
			return `${minutes}m ago`;
		}

		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return `${hours}h ago`;
		}

		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
}
