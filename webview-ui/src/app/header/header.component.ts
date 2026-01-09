import { Component, Input, OnInit } from "@angular/core";
import { TodoService } from "../todo/todo.service";
import { ExportFormats, ImportFormats, TodoScope } from "../../../../src/todo/todoTypes";
import { BehaviorSubject, combineLatest, map, Observable } from "rxjs";
import { GitHubSyncInfo, UserSyncMode, WorkspaceSyncMode } from "../../../../src/panels/message";

type SyncModeInfo = {
	scope: TodoScope;
	scopeLabel: string;
	scopeNote: string;
	isUserScope: boolean;
	mode: UserSyncMode | WorkspaceSyncMode;
	modeLabel: string;
	modeIcon: "github" | "local" | "profile";
	isGitHubMode: boolean;
	gistFile: string;
	pillLabel: string;
	pillTooltip: string;
	pillAriaLabel: string;
};

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
	isSyncMenuOpen = false;
	enableWideView!: Observable<boolean>;
	isGitHubConnected!: Observable<boolean>;
	isGistIdConfigured!: Observable<boolean>;
	isGitHubSyncEnabled!: Observable<boolean>;
	isSyncing!: Observable<boolean>;
	syncTooltip!: Observable<string>;
	syncModeInfo!: Observable<SyncModeInfo>;
	private wideViewDelayHandle: number | null = null;
	private currentScopeSource = new BehaviorSubject<TodoScope>(TodoScope.user);
	private currentScopeValue: TodoScope = TodoScope.user;

	@Input()
	set currentScope(value: TodoScope) {
		this.currentScopeValue = value;
		this.currentScopeSource.next(value);
	}
	get currentScope(): TodoScope {
		return this.currentScopeValue;
	}

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
		this.syncModeInfo = combineLatest([
			this.todoService.gitHubSyncInfo,
			this.currentScopeSource,
		]).pipe(map(([info, scope]) => this.buildSyncModeInfo(info, scope)));
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
		if (this.wideViewDelayHandle !== null) {
			clearTimeout(this.wideViewDelayHandle);
		}

		this.wideViewDelayHandle = window.setTimeout(() => {
			this.todoService.setWideViewEnabled(isEnabled);
			this.wideViewDelayHandle = null;
		}, 150);
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

	onSyncMenuOpened() {
		this.isSyncMenuOpen = true;
	}

	onSyncMenuClosed() {
		this.isSyncMenuOpen = false;
	}

	setUserSyncMode(mode: UserSyncMode) {
		this.todoService.setUserSyncMode(mode);
	}

	setWorkspaceSyncMode(mode: WorkspaceSyncMode) {
		this.todoService.setWorkspaceSyncMode(mode);
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

	setGistFileForCurrentScope() {
		if (this.currentScope === TodoScope.user) {
			this.setUserFile();
			return;
		}
		this.setWorkspaceFile();
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
				"Enable it via the Sync menu in the header."
			);
		}

		const summary = isSyncing
			? "Syncing all GitHub-enabled scopes..."
			: "Sync all GitHub-enabled scopes now.";
		const userDetail = info.userSyncEnabled
			? `User: last synced ${this.formatElapsed(info.userLastSynced, nowMs)}`
			: "User: GitHub sync off";
		const workspaceDetail = info.workspaceSyncEnabled
			? `Workspace: last synced ${this.formatElapsed(info.workspaceLastSynced, nowMs)}`
			: "Workspace: GitHub sync off";

		return `${summary}\nScopes:\n${userDetail}\n${workspaceDetail}`;
	}

	private buildSyncModeInfo(info: GitHubSyncInfo, scope: TodoScope): SyncModeInfo {
		const isUserScope = scope === TodoScope.user;
		const scopeLabel = isUserScope
			? "User"
			: scope === TodoScope.workspace
				? "Workspace"
				: "Workspace (File)";
		const scopeNote = scope === TodoScope.currentFile ? "File tab uses workspace sync." : "";
		const mode = isUserScope ? info.userSyncMode : info.workspaceSyncMode;
		const modeLabel = this.getSyncModeLabel(mode);
		const modeIcon = this.getSyncModeIcon(mode);
		const isGitHubMode = mode === "github";
		const gistFile = isGitHubMode
			? isUserScope
				? info.userFile
				: info.workspaceFile
			: "";
		const pillLabel = isGitHubMode && gistFile
			? `Sync: ${scopeLabel} - ${modeLabel} - ${gistFile}`
			: `Sync: ${scopeLabel} - ${modeLabel}`;
		const pillTooltipBase = `${scopeLabel} sync mode: ${modeLabel}.`;
		const scopeNotePart = scopeNote ? ` ${scopeNote}` : "";
		const filePart = isGitHubMode && gistFile ? ` Gist file: ${gistFile}` : "";
		const pillTooltip = `${pillTooltipBase}${scopeNotePart}${filePart}`.trim();
		const pillAriaLabel = `Sync settings for ${scopeLabel}. Mode: ${modeLabel}.`;

		return {
			scope,
			scopeLabel,
			scopeNote,
			isUserScope,
			mode,
			modeLabel,
			modeIcon,
			isGitHubMode,
			gistFile,
			pillLabel,
			pillTooltip,
			pillAriaLabel,
		};
	}

	private getSyncModeLabel(mode: UserSyncMode | WorkspaceSyncMode): string {
		switch (mode) {
			case "github":
				return "GitHub";
			case "profile-sync":
				return "Profile Sync";
			case "profile-local":
			case "local":
				return "Local";
			default:
				return "Local";
		}
	}

	private getSyncModeIcon(mode: UserSyncMode | WorkspaceSyncMode): "github" | "local" | "profile" {
		switch (mode) {
			case "github":
				return "github";
			case "profile-sync":
				return "profile";
			case "profile-local":
			case "local":
			default:
				return "local";
		}
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
