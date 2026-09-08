/**
 * Sync Manager
 *
 * Owns the *scheduling* of GitHub Gist sync — polling, debounce, the in-progress guard, and the
 * status the status bar and webviews render — and delegates the reconcile itself to the shared
 * {@link GistSyncEngine} from `@vsc-todo/core`. The PWA drives the same engine, which is the
 * point: two peers writing one gist have to agree on what changed and how a conflict settles,
 * and while this file kept its own copy of that logic the two drifted apart.
 */

import * as vscode from "vscode";
import { GitHubApiClient } from "./GitHubApiClient";
import { SyncStorageManager } from "./SyncStorageManager";
import {
	GlobalGistData,
	WorkspaceGistData,
	GlobalSyncMode,
	WorkspaceSyncMode,
	SyncStatus,
	SyncResult,
	SyncErrorType,
	SyncConstants,
	StorageKeys,
} from "./syncTypes";
import { isEqual } from "../todo/todoUtils";
import { GistSyncEngine } from "../core";
import { MementoCacheStore } from "./MementoCacheStore";
import { ConflictResolutionUI } from "./ConflictResolutionUI";
import { getGistId } from "../utilities/syncConfig";

export class SyncManager {
	private apiClient: GitHubApiClient;
	private storageManager: SyncStorageManager;
	private context: vscode.ExtensionContext;

	// Polling timers
	private userPollTimer: NodeJS.Timeout | undefined;
	private workspacePollTimer: NodeJS.Timeout | undefined;

	// Debounce timers
	private globalDebounceTimer: NodeJS.Timeout | undefined;
	private workspaceDebounceTimer: NodeJS.Timeout | undefined;

	// Status tracking
	private globalStatus: SyncStatus = SyncStatus.Offline;
	private workspaceStatus: SyncStatus = SyncStatus.Offline;

	// Sync operation guards to prevent concurrent sync operations
	private userSyncInProgress: boolean = false;
	private workspaceSyncInProgress: boolean = false;
	/**
	 * A sync that arrived while one was already running, to be re-run once it finishes. One flag,
	 * not a count: any number of missed triggers are satisfied by a single fresh sync.
	 */
	private userSyncQueued: boolean = false;
	private workspaceSyncQueued: boolean = false;
	/**
	 * An edit that landed while a sync was on the network. The in-flight run reports Synced from
	 * the snapshot it started with, which would bury the edit under a green "up to date" until
	 * the push that edit armed came round — so the status is restored to Dirty when it lands.
	 */
	private userEditedWhileSyncing: boolean = false;
	private workspaceEditedWhileSyncing: boolean = false;

	// Event emitters for status changes
	private onStatusChangeEmitter = new vscode.EventEmitter<{
		scope: "user" | "workspace";
		status: SyncStatus;
	}>();
	public readonly onStatusChange = this.onStatusChangeEmitter.event;

	// Event emitter for data downloads
	private onDataDownloadedEmitter = new vscode.EventEmitter<{
		scope: "user" | "workspace";
	}>();
	public readonly onDataDownloaded = this.onDataDownloadedEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.apiClient = new GitHubApiClient(context);
		this.storageManager = new SyncStorageManager(context);
	}

	/**
	 * Start polling for a scope
	 */
	public startPolling(scope: "user" | "workspace", intervalSeconds: number): void {
		this.stopPolling(scope);

		const interval = Math.max(
			SyncConstants.minPollInterval,
			Math.min(intervalSeconds, SyncConstants.maxPollInterval)
		);

		const pollFn = () => this.sync(scope);

		if (scope === "user") {
			this.userPollTimer = setInterval(pollFn, interval * 1000);
		} else {
			this.workspacePollTimer = setInterval(pollFn, interval * 1000);
		}

		// Initial sync
		void this.sync(scope);
	}

	/**
	 * Stop polling for a scope
	 */
	public stopPolling(scope: "user" | "workspace"): void {
		if (scope === "user" && this.userPollTimer) {
			clearInterval(this.userPollTimer);
			this.userPollTimer = undefined;
		} else if (scope === "workspace" && this.workspacePollTimer) {
			clearInterval(this.workspacePollTimer);
			this.workspacePollTimer = undefined;
		}
	}

	/**
	 * Trigger debounced sync after local changes
	 *
	 * Deliberately does NOT set the Dirty status, even though a scheduled push is exactly that
	 * state: this runs for *loads* too — an editor tab switch dispatches `currentFile/loadData`,
	 * and a remote pull dispatches `user`/`workspace` `loadData` — and neither owes the gist
	 * anything. The caller knows which action it is reacting to, so it calls {@link markDirty}
	 * itself; see handleTodoChange in extension.ts.
	 */
	public triggerDebounceSync(scope: "user" | "workspace"): void {
		if (scope === "user") {
			if (this.globalDebounceTimer) {
				clearTimeout(this.globalDebounceTimer);
			}
			this.globalDebounceTimer = setTimeout(() => {
				void this.sync("user");
			}, SyncConstants.debounceDelay);
		} else {
			if (this.workspaceDebounceTimer) {
				clearTimeout(this.workspaceDebounceTimer);
			}
			this.workspaceDebounceTimer = setTimeout(() => {
				void this.sync("workspace");
			}, SyncConstants.debounceDelay);
		}
	}

	/**
	 * Perform immediate sync for a scope
	 */
	public async sync(scope: "user" | "workspace"): Promise<SyncResult<void>> {
		const gistId = getGistId();

		if (!gistId) {
			// The scope is in GitHub mode with nowhere to sync to — the gist id is a plain user
			// setting and can be cleared at any time. Say so: without this the Dirty the edit set
			// is never moved off, and the change sits behind a permanent "changes not yet on
			// GitHub" that no sync can clear.
			this.updateStatus(scope, SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.InvalidGistIdError,
					message: "Gist ID not configured",
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		if (scope === "user") {
			return await this.syncUser(gistId);
		} else {
			return await this.syncWorkspace(gistId);
		}
	}

	// ---------------------------------------------------------------------------
	// Reconcile. The read → merge → write mechanics live in the shared `@vsc-todo/core`
	// GistSyncEngine — the same code the PWA runs — so the two peers cannot disagree about
	// what changed or how a conflict settles. This class keeps only what is genuinely
	// host-specific: status, polling, debounce, and the dialog.
	//
	// What the engine brings that the hand-rolled version here did not:
	//  - a verified write (re-read, re-merge, retry) instead of a blind PATCH, so a push that
	//    lands from the other device inside our read→write window is merged rather than
	//    overwritten — and, crucially, not recorded as the clean baseline, which is what used
	//    to make such a loss permanent and silent;
	//  - a cold cache that bootstraps from the remote instead of pushing local over it;
	//  - `lastCleanRemoteData` as the single source of staleness, rather than trusting an
	//    `isDirty` flag that no longer matched the data it described.
	// ---------------------------------------------------------------------------

	/**
	 * A reconcile engine bound to this gist.
	 *
	 * Built per sync rather than cached: the gist id is a plain setting the user can change at
	 * any time, and an engine holding a stale id would quietly reconcile against the old gist.
	 * Construction is trivial (it holds no connection), and the caches it reads are the
	 * extension's existing mementos — see {@link MementoCacheStore}.
	 */
	private engineFor(gistId: string, cacheStore: MementoCacheStore): GistSyncEngine {
		return new GistSyncEngine({
			// `GitHubApiClient` already satisfies `GistFileIO` structurally.
			client: this.apiClient,
			gistId,
			cacheStore,
			// Only reached for conflicts the user left undecided ("Skip This Conflict"), where
			// keeping this device's version is the non-destructive answer and the conflict is
			// raised again on the next sync.
			conflictPolicy: "prefer-local",
			conflictResolver: ({ todos, files, knownIds }) =>
				ConflictResolutionUI.resolve(todos, files, knownIds),
			logger: (message) => console.log(message),
		});
	}

	private userFileName(): string {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		return config.get<string>("github.userFile", "user-todos.json");
	}

	private workspaceFileName(): string {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		const workspaceName = vscode.workspace.name || "default";
		return config.get<string>("github.workspaceFile") || `workspace-${workspaceName}.json`;
	}

	/**
	 * The local state to reconcile: the gist cache's `data`, which is what `persistSlice` writes
	 * on every edit (see `SyncStorageManager.setGlobalTodos`).
	 *
	 * Read fresh here, and read again after the round trip, rather than held across it. The old
	 * code loaded the cache once and wrote that same in-memory object back after two network
	 * calls, so an edit landing in between was overwritten by the stale copy — the local change
	 * disappeared from the gist and from storage both. Nothing may span the awaits.
	 */
	private async readLocalUser(fileName: string): Promise<GlobalGistData> {
		return {
			userTodos: await this.storageManager.getGlobalTodos(GlobalSyncMode.GitHub, fileName),
		};
	}

	/** Workspace counterpart of {@link readLocalUser}. */
	private async readLocalWorkspace(fileName: string): Promise<WorkspaceGistData> {
		return {
			workspaceTodos: await this.storageManager.getWorkspaceTodos(
				WorkspaceSyncMode.GitHub,
				fileName
			),
			filesData: await this.storageManager.getFilesData(WorkspaceSyncMode.GitHub, fileName),
			filesDataPaths: await this.storageManager.getFilesDataPaths(
				WorkspaceSyncMode.GitHub,
				fileName
			),
		};
	}

	/**
	 * Sync global scope
	 */
	private async syncUser(gistId: string): Promise<SyncResult<void>> {
		// Guard: prevent concurrent sync operations. Remember the miss rather than dropping it:
		// the in-flight sync is working from a snapshot taken before whatever triggered this one,
		// so returning without rescheduling loses that change until some unrelated edit happens
		// to sync it — and the in-flight run finishes by reporting Synced, so the UI would call
		// it settled. Rescheduling from here instead would drive itself: the new timer hits this
		// same guard and arms another, every debounce interval for as long as the sync lasts —
		// unbounded, since the conflict dialog holds the flag while it waits on the user.
		if (this.userSyncInProgress) {
			console.log(`[SyncManager] User sync already in progress, queueing one re-run`);
			this.userSyncQueued = true;
			return { success: true };
		}

		this.userSyncInProgress = true;
		this.updateStatus("user", SyncStatus.Syncing);

		const fileName = this.userFileName();

		try {
			const cacheStore = new MementoCacheStore(this.context);
			const engine = this.engineFor(gistId, cacheStore);
			const snapshot = await this.readLocalUser(fileName);

			const res = await engine.reconcileUser(fileName, snapshot);
			if (!res.success || !res.data) {
				this.updateStatus("user", this.statusForFailure(res.error?.type));
				return { success: false, error: res.error };
			}

			let reconciled = res.data.data;

			// An edit that landed while we were on the network. The reconcile merged from a
			// snapshot that no longer reflects local state, so neither side can just win: adopting
			// the result drops the edit, and keeping local drops whatever the remote contributed —
			// and since the engine has already moved its baseline to the reconciled data, a dropped
			// remote change reads as a local deletion next pass and gets pushed away. Merge both
			// against the snapshot and push again.
			//
			// Such an edit can land on either side of the reconcile's single cache write, and the
			// two halves are found differently:
			//
			//  - before it — the write displaced the edit, so `displacedData` still holds it (a
			//    plain re-read would only hand back the merge);
			//  - after it — the cache now holds the edit rather than what the engine just wrote,
			//    so re-reading finds it.
			//
			// Checking only the first half left the second as a silent loss: the write-back below
			// would put the merge over an edit nobody had seen. `persistSlice` is fire-and-forget
			// (see handleTodoChange), so which half an edit falls in is pure timing.
			const engineWrote = res.data.data;
			const afterReconcile = await this.readLocalUser(fileName);
			const current = !isEqual(afterReconcile, engineWrote)
				? afterReconcile
				: cacheStore.displacedData<GlobalGistData>(StorageKeys.globalGistCache(fileName)) ??
					snapshot;
			const editedDuringSync = !isEqual(current, snapshot);
			let remergeConflicts = 0;
			if (editedDuringSync) {
				// The whole result, not just the data: this second merge resolves conflicts of its
				// own — a todo the user edited mid-flight that the reconcile was also changing — and
				// it resolves them by policy, with no dialog, because the reconcile has already
				// pushed. Dropping them would leave exactly the silent overwrite this change exists
				// to remove, so they are reported below.
				const remerge = engine.reconcileWithLocalEdits(snapshot, reconciled, current);
				reconciled = remerge.data;
				remergeConflicts = remerge.conflicts.length;
				this.triggerDebounceSync("user");
			}

			// The store has to be reloaded whenever the reconciled list differs from the local
			// state we know about — a pull, a merge, or a conflict the user resolved.
			// `changedRemotely` alone is not the condition: resolving a conflict changes local
			// state on a push too.
			const changed = !isEqual(reconciled, current);
			if (changed) {
				await this.storageManager.setGlobalTodos(
					GlobalSyncMode.GitHub,
					reconciled.userTodos,
					fileName
				);
			}

			// Re-persist through the engine before announcing anything. `setGlobalTodos` marks the
			// cache dirty, and the mid-flight merge above produced data the engine's own write does
			// not know about; this restores the cache to "data = what we hold, baseline = what the
			// engine last saw clean", which is the state the next reconcile has to start from.
			if (editedDuringSync || changed) {
				await engine.persistLocalUser(fileName, reconciled);
			}

			// Fired last: the listener reloads the Redux store straight out of this cache, so every
			// write above has to have landed first.
			if (changed) {
				this.onDataDownloadedEmitter.fire({ scope: "user" });
			}

			this.logConflicts("user", res.data.conflicts.length, res.data.fileConflicts.length);
			this.reportSilentlyResolved(remergeConflicts);
			this.updateStatus("user", editedDuringSync ? SyncStatus.Dirty : SyncStatus.Synced);
			return { success: true };
		} catch (error) {
			this.updateStatus("user", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.UnknownError,
					message: error instanceof Error ? error.message : "Unknown error",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		} finally {
			this.userSyncInProgress = false;
			this.settleEditDuringSync("user");
			// A trigger that arrived while this one held the guard. Re-run it now the flag is
			// clear, debounced so a burst of them still costs one sync.
			if (this.userSyncQueued) {
				this.userSyncQueued = false;
				this.triggerDebounceSync("user");
			}
		}
	}

	/**
	 * Sync workspace scope
	 */
	private async syncWorkspace(gistId: string): Promise<SyncResult<void>> {
		// Guard: see syncUser.
		if (this.workspaceSyncInProgress) {
			console.log(`[SyncManager] Workspace sync already in progress, queueing one re-run`);
			this.workspaceSyncQueued = true;
			return { success: true };
		}

		this.workspaceSyncInProgress = true;
		this.updateStatus("workspace", SyncStatus.Syncing);

		const fileName = this.workspaceFileName();

		try {
			const cacheStore = new MementoCacheStore(this.context);
			const engine = this.engineFor(gistId, cacheStore);
			const snapshot = await this.readLocalWorkspace(fileName);

			const res = await engine.reconcileWorkspace(fileName, snapshot);
			if (!res.success || !res.data) {
				this.updateStatus("workspace", this.statusForFailure(res.error?.type));
				return { success: false, error: res.error };
			}

			let reconciled = res.data.data;

			// See syncUser. This matters more here: per-file lists (`filesData`) live ONLY in the
			// cache, so a mid-flight edit to one has no other copy anywhere.
			const engineWrote = res.data.data;
			const afterReconcile = await this.readLocalWorkspace(fileName);
			const current = !isEqual(afterReconcile, engineWrote)
				? afterReconcile
				: cacheStore.displacedData<WorkspaceGistData>(
						StorageKeys.workspaceGistCache(fileName)
					) ?? snapshot;
			const editedDuringSync = !isEqual(current, snapshot);
			let remergeConflicts = 0;
			if (editedDuringSync) {
				// See syncUser.
				const remerge = engine.reconcileWorkspaceWithLocalEdits(snapshot, reconciled, current);
				reconciled = remerge.data;
				remergeConflicts = remerge.conflicts.length + remerge.fileConflicts.length;
				this.triggerDebounceSync("workspace");
			}

			const changed = !isEqual(reconciled, current);
			if (changed) {
				// Written through the three scope-specific setters rather than as one cache blob:
				// they are what `SyncStorageManager` exposes, and `reloadScopeData` reads the same
				// three back (from the gist cache, in GitHub mode) to rebuild the store and the
				// `TodoFilesData` / `TodoFilesDataPaths` mementos.
				await this.storageManager.setWorkspaceTodos(
					WorkspaceSyncMode.GitHub,
					reconciled.workspaceTodos,
					fileName
				);
				await this.storageManager.setFilesData(
					WorkspaceSyncMode.GitHub,
					reconciled.filesData,
					fileName
				);
				await this.storageManager.setFilesDataPaths(
					WorkspaceSyncMode.GitHub,
					reconciled.filesDataPaths ?? {},
					fileName
				);
			}

			// See syncUser.
			if (editedDuringSync || changed) {
				await engine.persistLocalWorkspace(fileName, reconciled);
			}
			if (changed) {
				this.onDataDownloadedEmitter.fire({ scope: "workspace" });
			}

			this.logConflicts("workspace", res.data.conflicts.length, res.data.fileConflicts.length);
			this.reportSilentlyResolved(remergeConflicts);
			this.updateStatus("workspace", editedDuringSync ? SyncStatus.Dirty : SyncStatus.Synced);
			return { success: true };
		} catch (error) {
			this.updateStatus("workspace", SyncStatus.Error);
			return {
				success: false,
				error: {
					type: SyncErrorType.UnknownError,
					message: error instanceof Error ? error.message : "Unknown error",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		} finally {
			this.workspaceSyncInProgress = false;
			this.settleEditDuringSync("workspace");
			// See syncUser.
			if (this.workspaceSyncQueued) {
				this.workspaceSyncQueued = false;
				this.triggerDebounceSync("workspace");
			}
		}
	}

	/**
	 * The status a failed reconcile should leave behind.
	 *
	 * A `ConflictError` is not a failure: it is the user choosing to decide later, which the
	 * engine honours by writing nothing so the same question comes back next sync. The scope
	 * still owes the gist an edit, so that is Dirty. Reporting Error instead was actively
	 * harmful — `markDirty` and `settleEditDuringSync` both refuse to overwrite an Error, so one
	 * "decide later" froze the indicator and it stopped reflecting pending edits until some
	 * later sync happened to succeed.
	 */
	private statusForFailure(type: SyncErrorType | undefined): SyncStatus {
		return type === SyncErrorType.ConflictError ? SyncStatus.Dirty : SyncStatus.Error;
	}

	/**
	 * Tells the user about conflicts that were settled *without* asking them.
	 *
	 * Only the mid-flight re-merge can produce these: the reconcile has already pushed by the
	 * time an edit made during it is folded back in, so there is nothing left to ask about and
	 * the shared policy (keep this device's version) decides. That is the right default, but it
	 * silently discards the other device's version of the same item, so it has to be said —
	 * otherwise this one window reproduces the silent overwrite the rest of this work removes.
	 *
	 * Rare by construction (it needs an edit inside the round trip), so a message here does not
	 * become background noise the way one per successful merge did.
	 */
	private reportSilentlyResolved(count: number): void {
		if (count === 0) {
			return;
		}
		// "conflict(s)", not "item(s)": for the workspace scope a file conflict is counted once
		// per file path while settling every disputed todo inside it, so an item count would
		// under-report. And "the other version was discarded" rather than "the other device
		// changed it too" — the losing side can be a choice the user made in this same
		// reconcile's dialog, before editing the item again mid-flight.
		void vscode.window.showWarningMessage(
			`Todo sync: ${count} conflict(s) arose from changes you made while the last sync was ` +
				`running, and were settled automatically by keeping this device's version.`
		);
	}

	/**
	 * Records what a reconcile settled, for the log only.
	 *
	 * Deliberately not a notification: conflicts the dialog settled need none, because the user
	 * just answered for each one. (A clean auto-merge used to pop an information message on every
	 * sync, which for two devices editing different items is most of them.) The one case that
	 * DOES warrant telling the user is handled by {@link reportSilentlyResolved}.
	 */
	private logConflicts(
		scope: "user" | "workspace",
		conflicts: number,
		fileConflicts: number
	): void {
		if (conflicts + fileConflicts === 0) {
			return;
		}
		console.log(
			`[SyncManager] ${scope}: reconciled with ${conflicts} todo conflict(s), ` +
				`${fileConflicts} file conflict(s)`
		);
	}

	/**
	 * Get current sync status
	 */
	public getStatus(scope: "user" | "workspace"): SyncStatus {
		return scope === "user" ? this.globalStatus : this.workspaceStatus;
	}

	/**
	 * Records that a scope holds an edit the gist does not have yet.
	 *
	 * Leaves Syncing and Error alone. A reconcile already on the network is the more informative
	 * state and reports its own outcome when it lands; a reported failure has to stay on screen,
	 * or every edit made while sync is broken would replace it with a milder state that says
	 * nothing is wrong. (The PWA's gateway applies the same two exceptions, in `markDirty`.)
	 *
	 * Trusts the caller that an edit happened. A reducer that returns early — `toggleTodo` for an
	 * id a stale webview click refers to — still reaches the caller with the *previous* action's
	 * `lastActionType`, so a dispatch that changed nothing can mark the scope dirty. The push it
	 * schedules then settles the scope, so the cost is a brief wrong glyph, not a wrong sync.
	 */
	public markDirty(scope: "user" | "workspace"): void {
		const current = this.getStatus(scope);
		if (current === SyncStatus.Syncing) {
			// Remembered rather than shown: the round trip in progress is the more useful state,
			// but it will end by reporting Synced from a snapshot that predates this edit.
			if (scope === "user") {
				this.userEditedWhileSyncing = true;
			} else {
				this.workspaceEditedWhileSyncing = true;
			}
			return;
		}
		if (current === SyncStatus.Error) {
			return;
		}
		this.updateStatus(scope, SyncStatus.Dirty);
	}

	/**
	 * Restores Dirty after a sync that finished while an edit was waiting behind it. Runs from
	 * the sync's `finally`, after the status it set.
	 */
	private settleEditDuringSync(scope: "user" | "workspace"): void {
		const edited = scope === "user" ? this.userEditedWhileSyncing : this.workspaceEditedWhileSyncing;
		if (!edited) {
			return;
		}
		if (scope === "user") {
			this.userEditedWhileSyncing = false;
		} else {
			this.workspaceEditedWhileSyncing = false;
		}
		// Not over a failure: that is the more important thing to report, and the edit is still
		// owed either way.
		if (this.getStatus(scope) !== SyncStatus.Error) {
			this.updateStatus(scope, SyncStatus.Dirty);
		}
	}

	/**
	 * Drops a scope's pending sync, for one that has just left GitHub mode.
	 *
	 * Without this the debounce armed by the last edit still fires — `sync()` re-checks the gist
	 * id but not the mode — and reports Syncing, then Synced or Error, for a list that no longer
	 * syncs anywhere: exactly the stale status {@link resetStatus} exists to clear.
	 */
	public cancelPendingSync(scope: "user" | "workspace"): void {
		if (scope === "user") {
			if (this.globalDebounceTimer) {
				clearTimeout(this.globalDebounceTimer);
				this.globalDebounceTimer = undefined;
			}
			this.userSyncQueued = false;
			this.userEditedWhileSyncing = false;
		} else {
			if (this.workspaceDebounceTimer) {
				clearTimeout(this.workspaceDebounceTimer);
				this.workspaceDebounceTimer = undefined;
			}
			this.workspaceSyncQueued = false;
			this.workspaceEditedWhileSyncing = false;
		}
	}

	/**
	 * Whether a scope currently syncs with GitHub. Read from the same internal storage the
	 * sync-mode commands write, which is where the mode lives — it is deliberately not a setting.
	 */
	private isGitHubMode(scope: "user" | "workspace"): boolean {
		return scope === "user"
			? this.context.globalState.get<string>("syncMode", "profile-local") === "github"
			: this.context.workspaceState.get<string>("syncMode", "local") === "github";
	}

	/**
	 * Returns a scope to the pre-sync state, for one that has just left GitHub mode.
	 *
	 * Nothing else does this, and the statuses outlive the mode: a scope switched to Local while
	 * Dirty kept a status bar warning for a list that no longer syncs anywhere — and the warning
	 * stayed visible because `isGitHubEnabled` there is true whenever *either* scope is on GitHub.
	 */
	public resetStatus(scope: "user" | "workspace"): void {
		this.updateStatus(scope, SyncStatus.Offline);
	}

	/**
	 * Update sync status and emit event.
	 *
	 * No-ops when the status is unchanged. Every listener does real work — the status bar
	 * re-renders, and `notifySyncStatus`/`notifyGitHubSyncInfo` re-read configuration, both
	 * memento stores and both gist caches, then post to every open webview — and since
	 * `triggerDebounceSync` began setting Dirty, a run of edits would repeat all of that per
	 * edit with nothing to show for it.
	 */
	private updateStatus(scope: "user" | "workspace", status: SyncStatus): void {
		// A scope that is no longer in GitHub mode has no sync state to report. `cancelPendingSync`
		// stops the scheduled syncs, but one already past the in-progress guard still runs to
		// completion — worst case parked in `showConflictDialog`, which waits on the user — and
		// would land its Synced or Error afterwards. The status bar gates its glyph on *either*
		// scope being on GitHub, so that left a permanent warning about a list that no longer
		// syncs anywhere, with no future sync to clear it. Offline still passes: that is the reset.
		if (status !== SyncStatus.Offline && !this.isGitHubMode(scope)) {
			return;
		}
		const current = scope === "user" ? this.globalStatus : this.workspaceStatus;
		if (current === status) {
			return;
		}
		if (scope === "user") {
			this.globalStatus = status;
		} else {
			this.workspaceStatus = status;
		}
		this.onStatusChangeEmitter.fire({ scope, status });
	}

	/**
	 * Dispose timers and resources
	 */
	public dispose(): void {
		// Nothing left to re-run once the timers are gone.
		this.userSyncQueued = false;
		this.workspaceSyncQueued = false;
		this.userEditedWhileSyncing = false;
		this.workspaceEditedWhileSyncing = false;
		this.stopPolling("user");
		this.stopPolling("workspace");
		if (this.globalDebounceTimer) {
			clearTimeout(this.globalDebounceTimer);
		}
		if (this.workspaceDebounceTimer) {
			clearTimeout(this.workspaceDebounceTimer);
		}
		this.onStatusChangeEmitter.dispose();
		this.onDataDownloadedEmitter.dispose();
	}
}
