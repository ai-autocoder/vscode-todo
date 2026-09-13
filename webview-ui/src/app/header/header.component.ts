import { Component, ElementRef, Input, OnInit, ViewChild, inject } from "@angular/core";
import { TodoService } from "../todo/todo.service";
import { environment } from "../../environments/environment";
import { ExportFormats, ImportFormats, TodoScope } from "../../../../src/todo/todoTypes";
import { BehaviorSubject, combineLatest, map, Observable } from "rxjs";
import {
	GitHubSyncInfo,
	McpStatus,
	SyncStatusInfo,
	SyncStatusValue,
	UserSyncMode,
	WorkspaceSyncMode,
} from "../../../../src/panels/message";

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

/**
 * The always-visible sync indicator, beside the menu button.
 *
 * Reports the scope of the tab in view — the File tab included, which syncs with the workspace
 * — so a scope that is Dirty in the background never claims the foreground tab is behind.
 */
type SyncIndicatorInfo = {
	status: SyncStatusValue;
	/**
	 * Hidden entirely when the current scope is not gist-backed. The extension has local and
	 * profile-sync modes, where there is no remote to be ahead of and the glyph would be a
	 * permanent "offline" with no way to act on it; the PWA has only GitHub, so it is always on.
	 */
	visible: boolean;
	icon: "sync-idle" | "sync-ok" | "sync-dirty" | "sync-error";
	spinning: boolean;
	/** Dirty and Error are the two states a manual sync can do something about. */
	actionable: boolean;
	tooltip: string;
	ariaLabel: string;
};

type McpControlInfo = {
	status: McpStatus;
	icon: "mcp-play" | "mcp-stop";
	tooltip: string;
	ariaLabel: string;
	disabled: boolean;
};

@Component({
	selector: "app-header",
	templateUrl: "./header.component.html",
	styleUrl: "./header.component.css",
	standalone: false,
})
export class HeaderComponent implements OnInit {
	private readonly todoService = inject(TodoService);

	ExportFormats = ExportFormats;
	ImportFormats = ImportFormats;
	isImportMenuOpen = false;
	isExportMenuOpen = false;
	isSettingsMenuOpen = false;
	isSyncMenuOpen = false;
	enableWideView!: Observable<boolean>;
	showTags!: Observable<boolean>;
	isGitHubConnected!: Observable<boolean>;
	isGistIdConfigured!: Observable<boolean>;
	isGitHubSyncEnabled!: Observable<boolean>;
	isSyncing!: Observable<boolean>;
	syncTooltip!: Observable<string>;
	syncIndicator!: Observable<SyncIndicatorInfo>;
	syncModeInfo!: Observable<SyncModeInfo>;
	mcpControlInfo!: Observable<McpControlInfo>;
	/**
	 * The MCP server lives in the extension host, which the standalone PWA does not have, so
	 * the control is hidden there rather than shown permanently disabled.
	 */
	readonly isMcpSupported = !environment.pwa;
	/**
	 * "Local" and "Profile Sync" are extension concepts — the latter is VS Code Settings Sync,
	 * which has no meaning in a browser — and the PWA is gist-backed by construction: it has no
	 * globalState/workspaceState to fall back to, so `GistGateway` reports "github" for both
	 * scopes and ignores the mode commands. Showing the picker there offered three choices where
	 * only one exists, and the two dead entries silently did nothing when clicked.
	 */
	readonly isSyncModeSelectable = !environment.pwa;

	private wideViewDelayHandle: number | null = null;
	private currentScopeSource = new BehaviorSubject<TodoScope>(TodoScope.user);
	private currentScopeValue: TodoScope = TodoScope.user;
	private searchFocusHandle: number | null = null;
	readonly searchQuery = this.todoService.searchQuery;

	@ViewChild("searchInput")
	private searchInput?: ElementRef<HTMLInputElement>;

	@Input()
	set currentScope(value: TodoScope) {
		this.currentScopeValue = value;
		this.currentScopeSource.next(value);
	}
	get currentScope(): TodoScope {
		return this.currentScopeValue;
	}

	ngOnInit(): void {
		this.enableWideView = this.todoService.enableWideView;
		this.showTags = this.todoService.showTags;
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
		this.syncIndicator = combineLatest([
			this.todoService.gitHubSyncInfo,
			this.todoService.syncStatus,
			this.currentScopeSource,
			this.todoService.now,
		]).pipe(
			map(([info, status, scope, nowMs]) =>
				this.buildSyncIndicatorInfo(info, status, scope, nowMs)
			)
		);
		this.mcpControlInfo = this.todoService.mcpStatus.pipe(
			map((status) => this.buildMcpControlInfo(status))
		);
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

	setShowTagsEnabled(isEnabled: boolean) {
		this.todoService.setShowTagsEnabled(isEnabled);
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
				return this.todoService.userTodos.some((todo) => todo.completed && !todo.isNote);
			case TodoScope.workspace:
				return this.todoService.workspaceTodos.some((todo) => todo.completed && !todo.isNote);
			case TodoScope.currentFile:
				return this.todoService.currentFileTodos.some((todo) => todo.completed && !todo.isNote);
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

	clearSearch() {
		this.todoService.clearSearchQuery();
		this.queueSearchFocus(false);
	}

	onSearchInput(event: Event) {
		const target = event.target as HTMLInputElement | null;
		this.todoService.setSearchQuery(target?.value ?? "");
	}

	onSearchEscape(event: Event) {
		event.preventDefault();
		event.stopPropagation();
		this.todoService.clearSearchQuery();
		this.searchInput?.nativeElement.blur();
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

	toggleMcp(status: McpStatus) {
		if (status.running) {
			this.todoService.stopMcpServer();
		} else {
			this.todoService.startMcpServer();
		}
	}

	private buildSyncTooltip(info: GitHubSyncInfo, isSyncing: boolean, nowMs: number): string {
		if (!info.isGitHubSyncEnabled) {
			return "GitHub Gist sync is off for all scopes. " + "Enable it via the Sync menu in the header.";
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

	/**
	 * Builds the indicator beside the menu button.
	 *
	 * The status is read for the scope in view, not for whichever scope changed last: the File
	 * tab is workspace-backed (as the sync menu already tells the user), so it reports the
	 * workspace's state rather than a state of its own.
	 */
	private buildSyncIndicatorInfo(
		info: GitHubSyncInfo,
		status: SyncStatusInfo,
		scope: TodoScope,
		nowMs: number
	): SyncIndicatorInfo {
		const isUserScope = scope === TodoScope.user;
		const mode = isUserScope ? info.userSyncMode : info.workspaceSyncMode;
		const scopeStatus = isUserScope ? status.user : status.workspace;
		const lastSynced = isUserScope ? info.userLastSynced : info.workspaceLastSynced;
		const scopeLabel = isUserScope ? "User" : scope === TodoScope.workspace ? "Workspace" : "File";
		// In the PWA the gist is the only backing store there is, so the indicator is permanent;
		// in the extension a scope can be local or profile-synced, where it would say nothing.
		const visible = environment.pwa || mode === "github";
		// Only when there is a timestamp: `formatElapsed` answers "never" without one, and
		// "up to date, last synced never" contradicts itself.
		const elapsed = lastSynced ? `, last synced ${this.formatElapsed(lastSynced, nowMs)}` : "";
		const scopeNote =
			scope === TodoScope.currentFile ? " The File tab syncs with the workspace list." : "";

		switch (scopeStatus.status) {
			case "syncing":
				return {
					status: scopeStatus.status,
					visible,
					icon: "sync-idle",
					spinning: true,
					actionable: false,
					tooltip: `Syncing ${scopeLabel} with GitHub...${scopeNote}`,
					ariaLabel: `${scopeLabel} sync: syncing`,
				};
			case "dirty":
				return {
					status: scopeStatus.status,
					visible,
					icon: "sync-dirty",
					spinning: false,
					actionable: scopeStatus.canRetry,
					tooltip: `${scopeLabel} has changes not yet on GitHub. Click to sync now.${scopeNote}`,
					ariaLabel: `${scopeLabel} sync: unsaved changes. Activate to sync now.`,
				};
			case "error":
				// A failure the host says retrying cannot fix — a revoked token, a missing gist —
				// must not offer one: the working recovery is elsewhere (the PWA's notice, the
				// extension's Sync menu), and the tooltip has to point there instead of inviting
				// a press that spends a round trip to fail again.
				return scopeStatus.canRetry
					? {
							status: scopeStatus.status,
							visible,
							icon: "sync-error",
							spinning: false,
							actionable: true,
							tooltip: `${scopeLabel} could not sync with GitHub. Click to try again.${scopeNote}`,
							ariaLabel: `${scopeLabel} sync: failed. Activate to try again.`,
						}
					: {
							status: scopeStatus.status,
							visible,
							icon: "sync-error",
							spinning: false,
							actionable: false,
							tooltip: `${scopeLabel} is not syncing with GitHub. Retrying will not help; reconnect or choose another gist from the sync notice or menu.${scopeNote}`,
							ariaLabel: `${scopeLabel} sync: stopped. Reconnect from the sync menu.`,
						};
			case "synced":
				return {
					status: scopeStatus.status,
					visible,
					icon: "sync-ok",
					spinning: false,
					actionable: false,
					tooltip: `${scopeLabel} is up to date with GitHub${elapsed}.${scopeNote}`,
					ariaLabel: `${scopeLabel} sync: up to date`,
				};
			case "offline":
			default:
				return {
					status: "offline",
					visible,
					icon: "sync-idle",
					spinning: false,
					actionable: false,
					// The pre-first-sync state, and the one a disconnected PWA sits in. Not an
					// error: nothing has failed yet, so it must not read like something has.
					tooltip: `${scopeLabel} has not synced yet.${scopeNote}`,
					ariaLabel: `${scopeLabel} sync: not synced yet`,
				};
		}
	}

	/**
	 * The indicator acts only where the host says a manual sync can help: Dirty, and an Error
	 * the host reported as retryable.
	 */
	syncFromIndicator(info: SyncIndicatorInfo): void {
		if (!info.actionable) {
			return;
		}
		this.todoService.syncNow();
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
		const gistFile = isGitHubMode ? (isUserScope ? info.userFile : info.workspaceFile) : "";
		const pillLabel =
			isGitHubMode && gistFile
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

	private queueSearchFocus(selectText: boolean): void {
		if (this.searchFocusHandle !== null) {
			clearTimeout(this.searchFocusHandle);
		}

		this.searchFocusHandle = window.setTimeout(() => {
			this.searchFocusHandle = null;
			const input = this.searchInput?.nativeElement;
			if (!input) {
				return;
			}
			input.focus();
			if (selectText) {
				input.select();
			}
		}, 0);
	}

	private buildMcpControlInfo(status: McpStatus): McpControlInfo {
		const isRunning = status.running;
		const isTrusted = status.trusted;
		const isEnabled = status.enabled;
		const disabled = !isTrusted;
		const icon: "mcp-play" | "mcp-stop" = isRunning ? "mcp-stop" : "mcp-play";

		let tooltip = isRunning ? "Stop MCP server." : "Start MCP server.";
		if (!isTrusted) {
			tooltip = "Workspace not trusted. Trust this workspace to use MCP.";
		} else if (!isEnabled && !isRunning) {
			tooltip = "Enable MCP and start the server.";
		} else if (isRunning && status.port) {
			tooltip = `Stop MCP server (port ${status.port}).`;
		}

		const ariaLabel = isRunning ? "Stop MCP server" : "Start MCP server";

		return {
			status,
			icon,
			tooltip,
			ariaLabel,
			disabled,
		};
	}
}
