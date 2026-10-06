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
	SyncError,
	SyncErrorType,
	SyncConstants,
	StorageKeys,
} from "./syncTypes";
import { isEqual } from "../todo/todoUtils";
import { GistSyncEngine } from "../core";
import { MementoCacheStore } from "./MementoCacheStore";
import { ConflictResolutionUI } from "./ConflictResolutionUI";
import { getGistId } from "../utilities/syncConfig";

/**
 * How many times a sync will fold in edits that arrived while its own conflict dialog was up.
 *
 * Bounded so that someone typing faster than they answer cannot hold a sync open indefinitely;
 * whatever is left over is carried by the debounced re-sync the fold already triggers.
 */
const MAX_REMERGE_FOLDS = 3;

/**
 * What each *after-write* dialog of one sync came back with, one entry per dialog.
 *
 * The engine reports every conflict its re-merge saw, decided or not, because only the caller
 * knows which ones the dialog answered. Without that distinction the warning at the end of a
 * sync tells someone who has just chosen "Keep All Remote" that their conflicts were settled
 * automatically by keeping this device's version — the opposite of what they picked.
 *
 * One entry per dialog rather than one set per sync, because a fold can re-raise an id an
 * earlier fold settled: the user answers it, edits it again while the write is in flight, and
 * the next fold asks once more. Matching each conflict list against its own dialog keeps a
 * second dialog the user *dismissed* from being filtered out by the first one's answer.
 *
 * Created per sync and closed over by that sync's resolver, not held on the manager: the two
 * scopes have separate in-progress guards and nothing serialises them against each other, so
 * `startPolling("user")` and `startPolling("workspace")` interleave at the first await and a
 * shared field would have each scope clearing the other's answers mid-dialog.
 */
class AfterWriteAnswers {
	private readonly rounds: Array<{ todos: Set<number>; files: Set<string> }> = [];

	/** A marker to pass to {@link since}, taken before a merge that may put a dialog up. */
	mark(): number {
		return this.rounds.length;
	}

	record(todos: Iterable<number>, files: Iterable<string>): void {
		this.rounds.push({ todos: new Set(todos), files: new Set(files) });
	}

	/** Everything answered since `mark`, unioned across the dialogs in that span. */
	since(mark: number): { todos: Set<number>; files: Set<string> } {
		const todos = new Set<number>();
		const files = new Set<string>();
		for (const round of this.rounds.slice(mark)) {
			for (const id of round.todos) {
				todos.add(id);
			}
			for (const path of round.files) {
				files.add(path);
			}
		}
		return { todos, files };
	}
}

/**
 * The store a person edits, as a sync sees it: the lists it shows, and the queue that writes
 * each edit to the gist cache behind the ones before it. `StorageSyncManager` implements it.
 *
 * A sync used to write its result into the gist cache and then have the store reload from
 * there, and an edit made in between was lost one way or the other. An edit's persist carries
 * the whole list the store showed when it was made, which until the reload is the list from
 * before the sync. Stored before the write-back, it was overwritten and the reload took it off
 * the screen. Stored after, it removed what the sync had pulled, while the baseline said the gist
 * had it, so the next sync pushed the pulled items away as deletions.
 *
 * Only the store holds every edit the moment it is made, so the result is folded into what the
 * store shows, and shown, in one turn: nothing can be edited between the read and the load. The
 * write that follows is queued at that moment, behind the persist of every edit made before it,
 * so whatever those persists store, the folded list is stored last.
 */
export interface SyncedStore {
	/**
	 * Runs `read` once no write to the scope's storage is queued or running, in the same turn as
	 * it checks, and resolves with its result. Both of the scope's lists read in `read` are then
	 * up to date with every edit made in this window.
	 */
	whenIdle<T>(scope: "user" | "workspace", read: () => T): Promise<T>;
	/**
	 * The user list the store shows, or undefined if it is not showing the gist file
	 * `fileName`: the scope has left GitHub mode, or moved to another file.
	 */
	shownUser(fileName: string): GlobalGistData | undefined;
	/** Workspace counterpart of {@link shownUser}: the workspace slice and the per-file lists. */
	shownWorkspace(fileName: string): WorkspaceGistData | undefined;
	/**
	 * Hands `fold` the user list the store shows and shows what it returns: in the store at once,
	 * and in the gist cache behind every write already queued. `fold` must not defer anything; it
	 * runs between the read and the load. Resolves with what was shown, once it is stored, or
	 * with undefined if the store is not showing `fileName` or `fold` returned undefined.
	 */
	showUser(
		fileName: string,
		fold: (shown: GlobalGistData) => GlobalGistData | undefined
	): Promise<GlobalGistData | undefined>;
	/** Workspace counterpart of {@link showUser}. */
	showWorkspace(
		fileName: string,
		fold: (shown: WorkspaceGistData) => WorkspaceGistData | undefined
	): Promise<WorkspaceGistData | undefined>;
}

/** Local state as one read found it; see {@link SyncedStore}. */
interface LocalRead<T> {
	/** The gist cache's `data`. */
	stored: T;
	/** What the store showed at the same moment, if there is a store showing this file. */
	shown: T | undefined;
}

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
	/**
	 * Gist files already reported as damaged, as `scope:gistId:fileName`. Cleared the moment that
	 * file parses again, so the message comes once per problem rather than once per poll.
	 *
	 * Keyed by the file rather than by scope alone: pointing a scope at a different gist, or at a
	 * different file in the same gist, is a different problem, and a scope-keyed flag would
	 * silence it — for good, since a damaged file can never produce the clean read that would
	 * clear the flag. See {@link reportCorruptFile}.
	 */
	private readonly reportedCorruptFiles = new Set<string>();

	// Event emitters for status changes
	private onStatusChangeEmitter = new vscode.EventEmitter<{
		scope: "user" | "workspace";
		status: SyncStatus;
	}>();
	public readonly onStatusChange = this.onStatusChangeEmitter.event;

	/**
	 * @param store where a sync's result is shown. Without one nothing is shown, and the result
	 *   only reaches the gist cache: for callers with no store, such as tests of the reconcile.
	 */
	constructor(
		context: vscode.ExtensionContext,
		private readonly store?: SyncedStore
	) {
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
	private engineFor(
		gistId: string,
		cacheStore: MementoCacheStore,
		answers: AfterWriteAnswers
	): GistSyncEngine {
		return new GistSyncEngine({
			// `GitHubApiClient` already satisfies `GistFileIO` structurally.
			client: this.apiClient,
			gistId,
			cacheStore,
			// Only reached for conflicts the user left undecided ("Skip This Conflict"), where
			// keeping this device's version is the non-destructive answer and the conflict is
			// raised again on the next sync.
			conflictPolicy: "prefer-local",
			conflictResolver: async ({ todos, files, knownIds, phase }) => {
				const decisions = await ConflictResolutionUI.resolve(todos, files, knownIds, phase);
				// Only the after-write phase is recorded: the reconcile's own conflicts are already
				// reported separately, and it is only the re-merge that claims to have settled things
				// "automatically". See {@link AfterWriteAnswers}.
				if (phase === "after-write") {
					answers.record(decisions?.todos?.keys() ?? [], decisions?.files?.keys() ?? []);
				}
				return decisions;
			},
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
	 *
	 * The result is a copy (`SyncStorageManager` never hands out the memento's own object), so
	 * the snapshot stays what local state was when it was read. An edit during the sync lands in
	 * storage, not in the snapshot, and the re-read after the round trip finds it.
	 *
	 * With a store, the cache is read once every edit already made has been stored, together with
	 * what the store shows; see {@link SyncedStore.whenIdle}. The cache is read when
	 * `getGlobalTodos` is called, so both halves come from the same turn.
	 */
	private async readLocalUser(fileName: string): Promise<LocalRead<GlobalGistData>> {
		const read = () => ({
			stored: this.storageManager.getGlobalTodos(GlobalSyncMode.GitHub, fileName),
			shown: this.store?.shownUser(fileName),
		});
		const { stored, shown } = this.store ? await this.store.whenIdle("user", read) : read();
		return { stored: { userTodos: await stored }, shown };
	}

	/**
	 * Workspace counterpart of {@link readLocalUser}. One read of the cache, so the three fields
	 * come from the same moment: reading them one at a time let an edit land between the reads.
	 */
	private async readLocalWorkspace(fileName: string): Promise<LocalRead<WorkspaceGistData>> {
		const read = () => ({
			stored: this.storageManager.getWorkspaceGistCache(fileName),
			shown: this.store?.shownWorkspace(fileName),
		});
		const { stored, shown } = this.store ? await this.store.whenIdle("workspace", read) : read();
		const data = (await stored)?.data;
		return {
			stored: {
				workspaceTodos: data?.workspaceTodos || [],
				filesData: data?.filesData || {},
				filesDataPaths: data?.filesDataPaths || {},
			},
			shown,
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
			const answers = new AfterWriteAnswers();
			const engine = this.engineFor(gistId, cacheStore, answers);
			const snapshot = (await this.readLocalUser(fileName)).stored;

			const res = await engine.reconcileUser(fileName, snapshot);
			if (!res.success || !res.data) {
				this.updateStatus("user", this.statusForFailure(res.error?.type));
				this.reportCorruptFile("user", gistId, fileName, res.error);
				return { success: false, error: res.error };
			}
			// The reconcile came back with data, so the file parsed. Cleared here rather than at
			// the end of the sync because this is where the evidence is: a later step throwing
			// does not make the file unreadable again, and leaving the flag set would silence the
			// next genuine corruption of it.
			this.reportedCorruptFiles.delete(corruptKey("user", gistId, fileName));

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
			const firstCurrent = !isEqual(afterReconcile.stored, engineWrote)
				? afterReconcile.stored
				: cacheStore.displacedData<GlobalGistData>(StorageKeys.globalGistCache(fileName)) ??
					snapshot;
			const editedDuringSync = !isEqual(firstCurrent, snapshot);
			let remergeConflicts = 0;
			let current = firstCurrent;
			// What the store showed when `current` was read, and when the local state `reconciled`
			// accounts for was: the base the store's later edits are folded in against. They part
			// only when the loop below stops at its bound with an edit unfolded. See showUserResult.
			let shownWithCurrent = afterReconcile.shown;
			let foldBase = shownWithCurrent;
			if (editedDuringSync) {
				// The whole result, not just the data: this second merge resolves conflicts of its
				// own — a todo the user edited mid-flight that the reconcile was also changing. It
				// puts the same quick picks up that the reconcile's own merge does; what the user
				// leaves undecided still falls to the policy, and is reported below. The one thing
				// they cannot do here is call the write off, because it has already gone out.
				//
				// Looped, because that dialog is an unbounded await — `ignoreFocusOut` keeps the quick
				// pick up while the user clicks back into the Todo view — and anything they type there
				// lands in the same storage this read from. Folding once against the pre-dialog copy
				// would write the merge straight over it, and the queued re-sync would only re-read the
				// clobbered state.
				//
				// The loop test compares storage against storage, never against `current`: `current` may
				// have come from `displacedData` rather than from a read, in which case it differs from
				// what is on disk for a reason that has nothing to do with a new edit. Comparing the two
				// made every displaced-edit sync fold a second time with the pre-edit state as local,
				// which reads as a deletion and dropped the edit outright. Bounded: someone typing
				// faster than they answer must not hold the sync open.
				//
				// If the bound is reached with an edit still unfolded, the write-back below does put the
				// merge over it in the cache. The store still shows the edit, though, and showing the
				// result folds it back in, settled by the policy rather than asked about. Not writing is
				// no alternative: the engine has already moved the baseline, so leaving local behind makes
				// the next reconcile read the remote's contribution as a local deletion and push it away.
				let base = snapshot;
				// What storage held when `current` was worked out. Only a *new* edit moves it from here.
				let seenInStorage = afterReconcile.stored;
				for (let fold = 0; fold < MAX_REMERGE_FOLDS; fold++) {
					// Per fold, not per sync: this fold may re-raise an id an earlier one settled, and
					// filtering against that earlier answer would hide a dialog this one dismissed.
					const asked = answers.mark();
					const remerge = await engine.reconcileWithLocalEdits(base, reconciled, current);
					const decided = answers.since(asked);
					reconciled = remerge.data;
					foldBase = shownWithCurrent;
					remergeConflicts += remerge.conflicts.filter(
						(conflict) => !decided.todos.has(conflict.todoId)
					).length;
					const latest = await this.readLocalUser(fileName);
					if (isEqual(latest.stored, seenInStorage)) {
						break;
					}
					base = current;
					current = latest.stored;
					shownWithCurrent = latest.shown;
					seenInStorage = latest.stored;
				}
				this.triggerDebounceSync("user");
			}

			// The cache and the store have to take the result whenever it differs from the local
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

			// Re-persist through the engine before showing anything. `setGlobalTodos` marks the
			// cache dirty, and the mid-flight merge above produced data the engine's own write does
			// not know about; this restores the cache to "data = what we hold, baseline = what the
			// engine last saw clean", which is the state the next reconcile has to start from.
			if (editedDuringSync || changed) {
				await engine.persistLocalUser(fileName, reconciled);
			}

			const shown = await this.showUserResult(engine, fileName, foldBase, reconciled, changed);
			const editedInStore = shown !== undefined && !isEqual(shown.data, reconciled);
			if (editedInStore) {
				// The store held edits made since the last read, which the gist has not got.
				this.triggerDebounceSync("user");
			}
			remergeConflicts += shown?.conflicts ?? 0;

			this.logConflicts("user", res.data.conflicts.length, res.data.fileConflicts.length);
			this.reportSilentlyResolved(remergeConflicts);
			this.updateStatus(
				"user",
				editedDuringSync || editedInStore ? SyncStatus.Dirty : SyncStatus.Synced
			);
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
			const answers = new AfterWriteAnswers();
			const engine = this.engineFor(gistId, cacheStore, answers);
			const snapshot = (await this.readLocalWorkspace(fileName)).stored;

			const res = await engine.reconcileWorkspace(fileName, snapshot);
			if (!res.success || !res.data) {
				this.updateStatus("workspace", this.statusForFailure(res.error?.type));
				this.reportCorruptFile("workspace", gistId, fileName, res.error);
				return { success: false, error: res.error };
			}
			// See the user scope: cleared on the read that proves the file parses, not at the end.
			this.reportedCorruptFiles.delete(corruptKey("workspace", gistId, fileName));

			let reconciled = res.data.data;

			// See syncUser. This matters more here: per-file lists (`filesData`) live ONLY in the
			// cache, so a mid-flight edit to one has no other copy anywhere.
			const engineWrote = res.data.data;
			const afterReconcile = await this.readLocalWorkspace(fileName);
			const firstCurrent = !isEqual(afterReconcile.stored, engineWrote)
				? afterReconcile.stored
				: cacheStore.displacedData<WorkspaceGistData>(
						StorageKeys.workspaceGistCache(fileName)
					) ?? snapshot;
			const editedDuringSync = !isEqual(firstCurrent, snapshot);
			let remergeConflicts = 0;
			let current = firstCurrent;
			// See syncUser.
			let shownWithCurrent = afterReconcile.shown;
			let foldBase = shownWithCurrent;
			if (editedDuringSync) {
				// See syncUser, including why this folds in a loop.
				let base = snapshot;
				// See syncUser: storage against storage, never against `current`.
				let seenInStorage = afterReconcile.stored;
				for (let fold = 0; fold < MAX_REMERGE_FOLDS; fold++) {
					// See syncUser: per fold, not per sync.
					const asked = answers.mark();
					const remerge = await engine.reconcileWorkspaceWithLocalEdits(base, reconciled, current);
					const decided = answers.since(asked);
					reconciled = remerge.data;
					foldBase = shownWithCurrent;
					remergeConflicts +=
						remerge.conflicts.filter((conflict) => !decided.todos.has(conflict.todoId)).length +
						remerge.fileConflicts.filter((conflict) => !decided.files.has(conflict.filePath)).length;
					const latest = await this.readLocalWorkspace(fileName);
					if (isEqual(latest.stored, seenInStorage)) {
						break;
					}
					base = current;
					current = latest.stored;
					shownWithCurrent = latest.shown;
					seenInStorage = latest.stored;
				}
				this.triggerDebounceSync("workspace");
			}

			const changed = !isEqual(reconciled, current);
			if (changed) {
				// Written through the three scope-specific setters rather than as one cache blob:
				// they are what `SyncStorageManager` exposes.
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

			// See syncUser. The per-file lists matter most here: the open file's slice persists the
			// whole list it shows, and that list is the only copy of an edit made to it.
			const shown = await this.showWorkspaceResult(engine, fileName, foldBase, reconciled, changed);
			const editedInStore = shown !== undefined && !isEqual(shown.data, reconciled);
			if (editedInStore) {
				this.triggerDebounceSync("workspace");
			}
			remergeConflicts += shown?.conflicts ?? 0;

			this.logConflicts("workspace", res.data.conflicts.length, res.data.fileConflicts.length);
			this.reportSilentlyResolved(remergeConflicts);
			this.updateStatus(
				"workspace",
				editedDuringSync || editedInStore ? SyncStatus.Dirty : SyncStatus.Synced
			);
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
	 * Shows a reconcile's result in the store, with every edit made there since the local state the
	 * result accounts for was read folded in. Resolves with what was shown, once it is stored, and
	 * how many conflicts the fold settled; undefined when nothing was shown.
	 *
	 * `base` is what the store showed at that read, so what the store shows now differs from it
	 * only by the edits the result lacks. In this window that is the cache's copy too, since the
	 * read waited for every edit to be stored. Not for another window's edit to the user list,
	 * though: windows share the user gist cache, so the cache can hold an edit this store has not
	 * shown yet, and folding against the cache would read it as a deletion made here. Undefined
	 * when the store was not showing this file then; the result is shown as it is.
	 *
	 * The fold runs between reading the store and loading it, so it settles conflicts by the
	 * policy rather than ask: an edit made while a dialog was up would carry the list from before
	 * the fold. See `GistSyncEngine.foldLocalEdits`.
	 */
	private async showUserResult(
		engine: GistSyncEngine,
		fileName: string,
		base: GlobalGistData | undefined,
		reconciled: GlobalGistData,
		changed: boolean
	): Promise<{ data: GlobalGistData; conflicts: number } | undefined> {
		if (!this.store) {
			return undefined;
		}
		let conflicts = 0;
		const data = await this.store.showUser(fileName, (shown) => {
			let result = reconciled;
			if (base && !isEqual(shown, base)) {
				const fold = engine.foldLocalEdits(base, reconciled, shown);
				result = fold.data;
				conflicts = fold.conflicts.length;
			}
			// A sync that changed nothing, with a store already showing the result, has nothing
			// to show.
			return changed || !isEqual(shown, result) ? result : undefined;
		});
		return data && { data, conflicts };
	}

	/**
	 * Workspace counterpart of {@link showUserResult}. Only the lists decide whether the store has
	 * moved on or already shows the result, not the path aliases: activation completes the
	 * memento's with `ensureFilesDataPaths` where the cache's are as the gist has them, so the two
	 * can differ with no edit made, and the aliases follow the lists anyway.
	 */
	private async showWorkspaceResult(
		engine: GistSyncEngine,
		fileName: string,
		base: WorkspaceGistData | undefined,
		reconciled: WorkspaceGistData,
		changed: boolean
	): Promise<{ data: WorkspaceGistData; conflicts: number } | undefined> {
		if (!this.store) {
			return undefined;
		}
		let conflicts = 0;
		const data = await this.store.showWorkspace(fileName, (shown) => {
			let result = reconciled;
			if (base && !sameLists(shown, base)) {
				const fold = engine.foldLocalWorkspaceEdits(base, reconciled, shown);
				result = fold.data;
				conflicts = fold.conflicts.length + fold.fileConflicts.length;
			}
			return changed || !sameLists(shown, result) ? result : undefined;
		});
		return data && { data, conflicts };
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
	 * Tells the user their gist file is damaged, from a sync they did not ask for.
	 *
	 * Every other failure is either transient or self-announcing, and the red indicator is enough
	 * until they next sync by hand. This one is neither: the engine has stopped syncing that
	 * scope, no retry can change that, and it stays that way until a person restores the file on
	 * github.com. Polling and debounced pushes discard their results — only the manual "Sync Now"
	 * command reports errors — so without this the scope would just go quiet and stay quiet.
	 *
	 * Once per damaged file, not once per poll, so a three-minute poll cannot turn a standing
	 * problem into a standing interruption. A sync the user asked for answers them regardless —
	 * see {@link forgetCorruptReports}, which the command calls first.
	 */
	private reportCorruptFile(
		scope: "user" | "workspace",
		gistId: string,
		fileName: string,
		error: SyncError | undefined
	): void {
		if (error?.type !== SyncErrorType.CorruptDataError) {
			return;
		}
		const key = corruptKey(scope, gistId, fileName);
		if (this.reportedCorruptFiles.has(key)) {
			return;
		}
		this.reportedCorruptFiles.add(key);
		void vscode.window
			.showErrorMessage(`Todo sync stopped: ${error.message}`, "View Gist")
			.then((action) => {
				if (action === "View Gist") {
					// Through the command rather than building the URL here: it is the same button
					// the error dialog and the menu use, and it already handles the gist id having
					// been cleared since this failure.
					void vscode.commands.executeCommand("vsc-todo.viewGistOnGitHub");
				}
			});
	}

	/**
	 * Drops the record of which damaged files have been reported, so the next failure speaks
	 * again.
	 *
	 * For a sync the user asked for. The suppression above exists to keep a three-minute poll
	 * quiet, not to leave a deliberate "Sync Now" with nothing but a red icon — and since this
	 * class now owns the message, the command does not show one of its own.
	 */
	public forgetCorruptReports(): void {
		this.reportedCorruptFiles.clear();
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
	}
}

/** Whether two workspace states hold the same lists, path aliases aside. */
function sameLists(a: WorkspaceGistData, b: WorkspaceGistData): boolean {
	return (
		isEqual(a.workspaceTodos, b.workspaceTodos) && isEqual(a.filesData ?? {}, b.filesData ?? {})
	);
}

/** Key for {@link SyncManager}'s record of damaged files: a scope alone is not specific enough. */
function corruptKey(scope: "user" | "workspace", gistId: string, fileName: string): string {
	return `${scope}:${gistId}:${fileName}`;
}
