/**
 * GistGateway — the {@link DataGateway} for the standalone PWA.
 *
 * Instead of talking to a VS Code extension host, it drives `@vsc-todo/core`'s
 * {@link GistSyncEngine} directly from the browser and keeps an in-memory copy of the
 * `user`/`workspace` slices that mirrors what the extension would push. Commands mutate that
 * local state with the **shared** {@link todoMutations} (the same logic the extension's Redux
 * reducers use — ported into core so the two can't drift), echo the change to the UI via a
 * `syncTodoData` message, and schedule a debounced reconcile to the gist.
 *
 * Inbound `messages` reproduces the extension→webview protocol the UI already understands:
 * `reloadWebview` (full initial state), `syncTodoData` (per-scope updates),
 * `updateGitHubStatus`/`updateGitHubSyncInfo`/`updateSyncStatus` (connection + sync state).
 *
 * SCOPE: user, workspace and per-file (`currentFile`) todos are all wired end-to-end
 * (mutate → echo → reconcile → pull-on-focus). Per-file lists live inside the workspace gist
 * file's `filesData`, so a `currentFile` edit is written back there and pushed on the workspace
 * timer; `filesData` is always round-tripped even when nothing is selected, because the merge
 * would otherwise read a missing entry as a deletion. With no editor to follow, the selected
 * file changes only via the file list, which lists every path carrying todos in the gist.
 *
 * Import/export are wired: the pure logic is shared (`@vsc-todo/core`'s `importExport`) and the
 * host halves VS Code would supply are replaced by a file input and a download — see
 * `../pwa/file-transfer`. Markdown carries no scope, so the extension's "Import to" quick pick
 * becomes the `awaiting-scope` phase of {@link ImportExportState}, rendered by the PWA shell.
 *
 * MCP and the remaining VS Code-only commands (sync-mode pickers, file pinning, gist-id
 * settings) are no-ops or open GitHub directly, since there is no extension host.
 */

import { BehaviorSubject, Observable, Subject } from "rxjs";
import {
	GistClient,
	GistSyncEngine,
	DeviceFlowClient,
	DeviceFlowError,
	IndexedDbCacheStore,
	IndexedDbTokenStore,
	SYNC_GIST_DESCRIPTION,
	DefaultFileNames,
	GIST_ID_REGEX,
	isEqual,
	SyncErrorType,
	type SyncError,
	type GistFileInfo,
	type GistSummary,
	type GlobalGistData,
	type WorkspaceGistData,
	type ReducerConfig,
	type TodoSliceState,
	type TodoFilesData,
	type TodoFilesDataPaths,
	todoMutations,
	generateUniqueId,
	recountTodos,
	type ConflictSet,
	type FileConflictSet,
	resolveFileConflict,
	buildExportFileName,
	buildExportObject,
	hasImportChanges,
	mergeImport,
	parseImport,
	serializeExport,
	type ImportObject,
} from "@vsc-todo/core";
import { canShareFile, downloadTextFile, pickTextFile, shareTextFile } from "../pwa/file-transfer";
import {
	CurrentFileSlice,
	ExportFormats,
	ImportFormats,
	MarkdownImportScopes,
	StoreState,
	Todo,
	TodoScope,
	TodoSlice,
} from "../../../../src/todo/todoTypes";
import {
	MessageActionsToWebview,
	messagesFromWebview,
	GitHubSyncInfo,
	SyncScopeStatus,
	SyncStatusInfo,
	SyncStatusValue,
} from "../../../../src/panels/message";
import { Config } from "../../../../src/utilities/config";
import type { DataGateway, InboundMessage } from "./data-gateway";
import { isValueStale } from "../pwa/conflicts/conflict-diff";
import {
	MAX_PENDING_CONFLICTS,
	PendingConflictStore,
} from "../pwa/conflicts/pending-conflicts.store";
import {
	fileConflictKey,
	todoConflictKey,
	type ConflictScope,
	type PendingConflict,
	type PendingConflictView,
	type ConflictApplyResult,
} from "../pwa/conflicts/conflict-types";
import { ViewPreferencesStore } from "../pwa/view-preferences.store";

/** Runtime configuration for the PWA's GitHub access (supplied by the PWA environment). */
export interface GistGatewayConfig {
	/** Public GitHub OAuth App client id (Device Flow enabled). */
	clientId: string;
	/** Base URL of the CORS proxy Worker that forwards the device-flow POSTs to github.com. */
	deviceFlowProxyUrl: string;
	/** Optional UI defaults; falls back to the same defaults the extension ships. */
	config?: Partial<Config>;
	/** Debounce window for pushing local edits to the gist (ms). Defaults to 3000. */
	pushDebounceMs?: number;
}

/**
 * The connection flow as a state machine, driven by {@link GistGateway.connectGitHub} /
 * {@link GistGateway.submitGistId} / {@link GistGateway.chooseFiles} and observed by the PWA's
 * connect screen. Phases advance: disconnected → requesting-code → awaiting-authorization
 * (user enters the code on GitHub) → change-gist (the user always picks the gist) →
 * needs-files → connected.
 */
export type GistConnectionState =
	| { phase: "disconnected" }
	| { phase: "requesting-code" }
	| {
			phase: "awaiting-authorization";
			userCode: string;
			verificationUri: string;
			expiresIn: number;
	  }
	| { phase: "needs-gist" }
	| {
			/**
			 * The gist chooser. Reached right after login (the user always picks — nothing is
			 * auto-adopted), from the file picker, and from the connected state so a persisted
			 * gist can be changed later.
			 */
			phase: "change-gist";
			currentGistId: string;
			current?: GistSummary;
			gists: GistSummary[];
			busy?: boolean;
			message?: string;
	  }
	| { phase: "needs-files"; userFiles: GistFileInfo[]; workspaceFiles: GistFileInfo[] }
	| { phase: "connected"; userFile: string; workspaceFile?: string }
	| { phase: "error"; message: string };

/**
 * A sync that has stopped working, for the PWA to say so.
 *
 * Edits keep landing in IndexedDB whatever the network does, which is the right behaviour — but
 * it means a dead sync is invisible unless something says otherwise. Without this the app
 * accepted edits forever while every push failed, and the sync menu still read "Connected".
 *
 * `kind` drives the recovery offered, because they are not the same:
 *   - `auth`    — the token was revoked, expired, or lost its gist scope. Reconnect.
 *   - `missing` — the gist (or its file) is gone. Pick another gist.
 *   - `data`    — the gist file is there but cannot be read. Only a person can fix it, from the
 *                 file's revision history on github.com.
 *   - `other`   — rate limit, offline, or a server fault. Retrying is the only move.
 */
export type SyncFailureKind = "auth" | "missing" | "data" | "other";

export type SyncFailureState =
	| { phase: "ok" }
	| {
			phase: "failing";
			kind: SyncFailureKind;
			message: string;
			/**
			 * Whether retrying could plausibly help. False for a rejected payload or a missing
			 * gist selection, where offering "Try again" would only fail again.
			 */
			canRetry: boolean;
	  };

/**
 * Import/export progress, for the PWA to render. Separate from {@link GistConnectionState}
 * because it happens *while* connected, so it cannot share the connect screen's overlay.
 *
 * `awaiting-scope` is the browser's stand-in for the extension's "Import to" quick pick: a
 * markdown file says nothing about which list it belongs in, so the user is asked.
 */
export type ImportExportState =
	| { phase: "idle" }
	| { phase: "busy"; message: string }
	| {
			phase: "awaiting-scope";
			fileName: string;
			/** Absent when no file is open, which rules out the File scope. */
			currentFilePath?: string;
	  }
	| { phase: "done"; message: string }
	| { phase: "error"; message: string };

/**
 * Message for a failure that is not one of the handled outcomes — a storage write that threw,
 * say. Named so the notice says which operation broke rather than just "something went wrong".
 */
function describeUnexpected(operation: "import" | "export", error: unknown): string {
	const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
	return `The ${operation} failed${detail}.`;
}

/** Renders which scopes an import touched, for the confirmation notice. */
function describeImportChanges(changed: {
	user: boolean;
	workspace: boolean;
	filesData: boolean;
	filesDataPaths: boolean;
}): string {
	const parts: string[] = [];
	if (changed.user) {
		parts.push("user todos");
	}
	if (changed.workspace) {
		parts.push("workspace todos");
	}
	if (changed.filesData || changed.filesDataPaths) {
		parts.push("file todos");
	}
	if (parts.length <= 1) {
		return parts[0] ?? "no changes";
	}
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const DEFAULT_CONFIG: Config = {
	taskSortingOptions: "sortType1",
	createMarkdownByDefault: false,
	createPosition: "top",
	enableLineNumbers: false,
	enableMarkdownDiagrams: true,
	enableMarkdownKatex: true,
	enableWideView: false,
	showTags: false,
	autoDeleteCompletedAfterDays: 0,
	collapsedPreviewLines: 1,
	webviewFontFamily: "",
	webviewFontSize: 0,
};

const newUserSlice = (): TodoSlice => ({
	todos: [],
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
	scope: TodoScope.user,
});

const newWorkspaceSlice = (): TodoSlice => ({
	todos: [],
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
	scope: TodoScope.workspace,
});

const newCurrentFileSlice = (): CurrentFileSlice => ({
	filePath: "",
	isPinned: false,
	todos: [],
	lastActionType: "",
	numberOfTodos: 0,
	numberOfNotes: 0,
	scope: TodoScope.currentFile,
});

export class GistGateway implements DataGateway {
	private readonly _messages = new Subject<InboundMessage>();
	readonly messages: Observable<InboundMessage> = this._messages.asObservable();

	private readonly config: Config;
	private readonly reducerConfig: ReducerConfig;
	private readonly pushDebounceMs: number;

	private readonly tokenStore = new IndexedDbTokenStore();
	private readonly cacheStore = new IndexedDbCacheStore();
	private readonly conflictStore = new PendingConflictStore();
	private readonly viewPreferencesStore = new ViewPreferencesStore();
	private readonly client: GistClient;
	private readonly deviceFlow: DeviceFlowClient;
	private engine: GistSyncEngine | undefined;

	private token: string | undefined;
	private gistId: string | undefined;
	private userFile: string | undefined;
	private workspaceFile: string | undefined;

	private readonly _connection = new BehaviorSubject<GistConnectionState>({
		phase: "disconnected",
	});
	/** Connection flow state for the PWA's connect screen. */
	readonly connection: Observable<GistConnectionState> = this._connection.asObservable();

	/**
	 * Conflicts the engine already resolved (prefer-local) and pushed, kept so the user can see
	 * and reverse those decisions. Newest first; persisted, because sync usually runs on the
	 * focus event just before a phone backgrounds the app.
	 */
	private pendingConflicts: PendingConflict[] = [];
	private readonly _conflicts = new BehaviorSubject<PendingConflictView[]>([]);
	/** Pending conflicts, each paired with whether local state has moved on since the sync. */
	readonly conflicts: Observable<PendingConflictView[]> = this._conflicts.asObservable();
	private readonly _syncFailure = new BehaviorSubject<SyncFailureState>({ phase: "ok" });
	/** Whether sync has stopped working, so the PWA can say so instead of looking healthy. */
	readonly syncFailure: Observable<SyncFailureState> = this._syncFailure.asObservable();
	/** The *sync* failure recorded per scope; the banner shows the most actionable of them. */
	private readonly syncFailures = new Map<
		TodoScope.user | TodoScope.workspace,
		{ kind: SyncFailureKind; message: string; canRetry: boolean }
	>();
	/**
	 * The *local write* failure recorded per scope. Deliberately a second map: both are keyed by
	 * scope, so sharing one would let a failed IndexedDB write evict the `auth` entry for the same
	 * scope and silently remove the "Reconnect" button that was the user's way out.
	 */
	private readonly persistFailures = new Map<
		TodoScope.user | TodoScope.workspace,
		{ kind: SyncFailureKind; message: string; canRetry: boolean }
	>();
	/**
	 * Consecutive failures per scope, reset only by a success — unlike `userRetries`, which
	 * `mutate` and `refresh` refill. See {@link recordSyncFailure}.
	 */
	private readonly consecutiveSyncFailures = new Map<TodoScope.user | TodoScope.workspace, number>();
	/** Guards {@link retrySync} against repeat presses queueing parallel reconciles. */
	private retryInFlight = false;
	private readonly _importExport = new BehaviorSubject<ImportExportState>({ phase: "idle" });
	/** Import/export progress, for the PWA's scope prompt and its result notice. */
	readonly importExport: Observable<ImportExportState> = this._importExport.asObservable();
	/** Settles the `awaiting-scope` prompt. Only one import runs at a time. */
	private pendingScopeResolver?: (scope: MarkdownImportScopes | undefined) => void;
	/** The gist currently in use, for screens that need to show which one is selected. */
	get currentGistId(): string | undefined {
		return this.gistId;
	}
	/** The files in use, so the picker can preselect them rather than defaulting to the first. */
	get currentUserFile(): string | undefined {
		return this.userFile;
	}
	get currentWorkspaceFile(): string | undefined {
		return this.workspaceFile;
	}
	private connectAbort: AbortController | undefined;

	private user = newUserSlice();
	private workspace = newWorkspaceSlice();

	/**
	 * Per-file todos from the workspace gist file, keyed by the path the extension recorded.
	 * These MUST be round-tripped even when the PWA shows none of them: `reconcileWorkspace`
	 * treats the local value as authoritative under the default prefer-local policy, so pushing
	 * `{}` would delete every per-file list the extension has stored.
	 */
	private filesData: TodoFilesData = {};
	private filesDataPaths: TodoFilesDataPaths = {};

	/**
	 * The file the UI is currently showing. There is no editor in the PWA, so unlike the
	 * extension (where it follows the active editor) it only changes when the user picks a file
	 * from the file list.
	 */
	private currentFile = newCurrentFileSlice();

	private userPushTimer: ReturnType<typeof setTimeout> | undefined;
	private workspacePushTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Bumped by {@link mutate} on every local edit, per gist file (the workspace counter covers
	 * `workspaceTodos` *and* `filesData`, since both live in the workspace file).
	 *
	 * A reconcile captures the counter alongside the local snapshot it sends, then compares on
	 * resolve. This is what makes a mid-flight edit detectable: the reconcile `await`s two HTTP
	 * round-trips, the UI keeps dispatching during that window, and the merged result it comes
	 * back with was computed from state that is already stale. Adopting it blindly overwrote the
	 * edit in memory, and because the engine had recorded the merged data as the new baseline,
	 * the next reconcile saw local == base and pushed nothing — the edit was gone for good.
	 */
	private userGeneration = 0;
	private workspaceGeneration = 0;

	constructor(private readonly opts: GistGatewayConfig) {
		this.config = { ...DEFAULT_CONFIG, ...opts.config };
		this.reducerConfig = {
			createPosition: this.config.createPosition,
			createMarkdownByDefault: this.config.createMarkdownByDefault,
			taskSortingOptions: this.config.taskSortingOptions,
		};
		this.pushDebounceMs = opts.pushDebounceMs ?? 3000;

		this.client = new GistClient({ getToken: () => this.token });
		this.deviceFlow = new DeviceFlowClient({
			clientId: opts.clientId,
			proxyBaseUrl: opts.deviceFlowProxyUrl,
		});
	}

	// --- lifecycle ---

	/**
	 * Restores a persisted session (token + gist + file selections) and reports the resulting
	 * connection phase. The PWA shell calls this once at startup to decide whether to show the
	 * connect screen or the app.
	 */
	async restoreSession(): Promise<GistConnectionState> {
		// Before anything is emitted: `ready()` sends the config to the UI in its first
		// `reloadWebview`, and `TodoService.handleReloadWebview` seeds the Wide View and Show Tags
		// observables straight from it. Loading these later would leave the app rendering one
		// frame of the defaults and then jumping.
		Object.assign(this.config, await this.viewPreferencesStore.load());
		this.token = await this.tokenStore.getToken();
		this.gistId = await this.tokenStore.getGistId();
		this.userFile = await this.tokenStore.getUserFile();
		const storedWorkspaceFile = await this.tokenStore.getWorkspaceFile();
		this.workspaceFile = storedWorkspaceFile || undefined;
		if (this.gistId) {
			this.engine = this.createEngine(this.gistId);
			await this.rehydrateFromCache();
			// Conflicts belong to the gist that produced them and are cleared when it changes, so
			// they load alongside the cache rather than on their own.
			this.pendingConflicts = await this.conflictStore.load();
			this.publishConflicts();
		}

		let state: GistConnectionState;
		if (!this.token) {
			state = { phase: "disconnected" };
		} else if (!this.gistId) {
			state = { phase: "needs-gist" };
		} else if (!this.userFile) {
			state = await this.enterFileSelection();
		} else {
			state = { phase: "connected", userFile: this.userFile, workspaceFile: this.workspaceFile };
		}
		this._connection.next(state);
		this.emitGitHubStatus();
		this.emitSyncInfo();
		return state;
	}

	async ready(): Promise<void> {
		this.emitReload();
		this.emitGitHubStatus();
		this.emitSyncInfo();
		if (this.token && this.gistId && this.userFile) {
			void this.pullAll();
		}
	}

	/** Re-pull on regaining focus (the extension polls; the PWA pulls on focus to stay cheap). */
	async refresh(): Promise<void> {
		// Same guard as ready(): without a chosen file there is nothing to reconcile, and the
		// file names may still belong to a gist the user is in the middle of switching away from.
		if (this.token && this.gistId && this.userFile) {
			// Coming back to the app is the natural moment to give up on a stale failure streak:
			// a device that failed while offline and then idled would otherwise never retry.
			this.userRetries = 0;
			this.workspaceRetries = 0;
			await this.pullAll();
		}
	}

	// --- inbound message emitters ---

	/**
	 * The file list the UI's `<file-list>` renders, derived from `filesData`. The extension
	 * builds this from the files it has seen in the workspace; the PWA has no workspace on disk,
	 * so every file that carries todos in the gist is listed. Counts match the extension's
	 * (open, non-note todos). Sorted by path so the list is stable across pulls.
	 */
	private filesWithRecords(): Array<{ filePath: string; todoNumber: number }> {
		return Object.entries(this.filesData)
			.map(([filePath, todos]) => ({
				filePath,
				todoNumber: (todos ?? []).filter((t) => !t.completed && !t.isNote).length,
			}))
			.sort((a, b) => a.filePath.localeCompare(b.filePath));
	}

	private emitReload(): void {
		const editorFocusAndRecords: StoreState["editorFocusAndRecords"] = {
			editorFocusedFilePath: this.currentFile.filePath,
			workspaceFilesWithRecords: this.filesWithRecords(),
			filesDataPaths: this.filesDataPaths,
			lastActionType: "",
		};
		const payload: StoreState = {
			user: this.user,
			workspace: this.workspace,
			currentFile: this.currentFile,
			editorFocusAndRecords,
			actionTracker: { lastSliceName: "" as StoreState["actionTracker"]["lastSliceName"] },
		};
		this._messages.next({
			type: MessageActionsToWebview.reloadWebview,
			payload,
			config: this.config,
		});
	}

	/**
	 * Emits a slice to the webview, applying the `"<scope>/<name>"` prefix to `lastActionType`.
	 *
	 * `todoMutations` deliberately stores the bare reducer name to stay scope-agnostic, and
	 * documents that the prefix "is applied by the caller" — mirroring how Redux adds the slice
	 * name in the extension. This gateway is that caller, and used to ship the bare name.
	 *
	 * The consumer (`todo-list.component.ts`, `handleAnimations`) reads
	 * `actionType.split("/")[1]`, so an unprefixed value arrived as `undefined`: never a member
	 * of `enterAnimationEnabledActions`, and enough to make `shouldRunReorderAnimation()` return
	 * false every time. Enter and reorder animations could not play at all.
	 *
	 * Prefixed on a copy rather than in place: the mutations write the bare name into the stored
	 * slice, and re-prefixing an already-prefixed value on a second emit would produce
	 * `"user/user/addTodo"`.
	 */
	private emitScope(scope: TodoScope): void {
		const slice =
			scope === TodoScope.user
				? this.user
				: scope === TodoScope.workspace
					? this.workspace
					: this.currentFile;
		this._messages.next({
			type: MessageActionsToWebview.syncTodoData,
			payload: {
				...slice,
				// `TodoScope`'s values are exactly the extension's slice names, so this matches
				// what the webview sees from Redux there.
				lastActionType: slice.lastActionType ? `${scope}/${slice.lastActionType}` : "",
			},
		});
	}

	private emitGitHubStatus(): void {
		this._messages.next({
			type: MessageActionsToWebview.updateGitHubStatus,
			// Reports whether a token is held, deliberately *not* whether GitHub still accepts it.
			// Folding a rejected token in here looked tempting — it would stop the sync menu
			// reading "Connected" — but the flag drives a shared menu: a false value swaps
			// "Disconnect GitHub" for "Connect to GitHub" and disables the gist-*file* picker
			// (`header.component.html`). Reconnecting would still be reachable, so this is a
			// trade rather than a necessity; the failure is surfaced by {@link syncFailure}
			// instead, as a banner carrying the action that fits the cause. The residue is that
			// the menu still reads "Connected" over a dead token, which is worth revisiting if
			// the menu ever gains a PWA-only variant.
			payload: { isConnected: !!this.token, hasGistId: !!this.gistId },
		});
	}

	/**
	 * GitHub's wording for a secondary rate limit, which arrives as a 403 and so reaches us as an
	 * `AuthError`. Matched against the response body, which core preserves in `error.message`.
	 */
	private static readonly RATE_LIMITED_TEXT = /rate limit|abuse detection|too many requests/i;

	/**
	 * Maps a {@link SyncError} onto the recovery the user actually has.
	 *
	 * `AuthError` arrives for 401 and 403 alike — core folds them together in
	 * `gistClient.handleErrorResponse`. A revoked token and a token that lost its `gist` scope
	 * both need re-authorizing, and those two are genuinely indistinguishable.
	 *
	 * A 403 is *not* always either: GitHub also returns it for a secondary rate limit, which is
	 * transient and which re-running the device flow cannot fix — telling someone their token was
	 * revoked because they synced too fast sends them to reconnect an account that is fine. The
	 * status code does not separate the two, but GitHub's response body does.
	 */
	private classifySyncFailure(error?: SyncError): SyncFailureKind {
		switch (error?.type) {
			case SyncErrorType.AuthError:
				return GistGateway.RATE_LIMITED_TEXT.test(error.message ?? "") ? "other" : "auth";
			case SyncErrorType.NotFoundError:
			case SyncErrorType.InvalidGistIdError:
			case SyncErrorType.FileNotFoundError:
				return "missing";
			case SyncErrorType.CorruptDataError:
				// The gist file itself cannot be parsed, so core refused to sync rather than read
				// the damage as "everything was deleted". Nothing here can repair it, so the banner
				// sends the user to the revision history instead of offering a retry that would
				// only re-read the same bytes. (A `ValidationError` is the other direction —
				// GitHub rejecting what we sent — and stays "other".)
				return "data";
			default:
				return "other";
		}
	}

	/**
	 * Records a scope's sync failure and decides whether to tell the user yet.
	 *
	 * Reporting is deliberately *not* tied to the retry budget. `mutate` refills it on every
	 * local edit and `refresh` on every focus, so a phone user editing against a revoked token
	 * can loop 401 → retry → edit → 401 indefinitely without the counter ever reaching
	 * {@link MAX_SYNC_RETRIES} — which would leave the dead sync silent, the exact bug this
	 * exists to prevent. So:
	 *
	 *   - `auth` and `missing` are reported on the first failure. Neither fixes itself, and a
	 *     backoff the user may never sit still for is no reason to withhold the news.
	 *   - `other` (offline, rate limit, server fault) is genuinely often transient, so it waits
	 *     for {@link MAX_SYNC_RETRIES} consecutive failures — counted here, where only a success
	 *     resets it.
	 */
	private recordSyncFailure(
		scope: TodoScope.user | TodoScope.workspace,
		error: SyncError | undefined,
		options: { retryable: boolean; message?: string; kind?: SyncFailureKind } = {
			retryable: false,
		}
	): void {
		// `kind` is taken from the caller where it knows something the error does not. Inferring
		// it from the presence of `message` — as this first did — silently forced every
		// custom-message failure to "other", which is how the "no gist selected" case ended up
		// rendering a banner with no recovery button on it at all.
		const kind = options.kind ?? this.classifySyncFailure(error);
		const consecutive = (this.consecutiveSyncFailures.get(scope) ?? 0) + 1;
		this.consecutiveSyncFailures.set(scope, consecutive);

		const transient = kind === "other" && options.retryable && !options.message;
		if (transient && consecutive < GistGateway.MAX_SYNC_RETRIES) {
			return;
		}

		this.syncFailures.set(scope, {
			kind,
			// Retryability is not core's transport-level `retryable` flag. Core marks 401/403
			// retryable (`gistClient.authError`), but re-sending a token GitHub has already
			// rejected only fails again — and the dead "Try again" then sits beside the
			// "Reconnect" that does work, inviting the wrong tap. Only an `other` failure can be
			// retried into success.
			canRetry: options.retryable && kind === "other",
			message: options.message ?? this.syncFailureMessage(kind, error),
		});
		this.publishSyncFailure();
		// Turn the indicator red on the same threshold as the banner: a failure suppressed above
		// as transient must not show an error the banner is not showing either. Set here rather
		// than only in settleSyncStatus because retrySync can record a failure with no reconcile
		// running to settle.
		this.setSyncStatus(scope, "error");
	}

	/**
	 * Message for a sync that failed in a way no {@link SyncResult} described — a thrown error
	 * rather than a returned failure.
	 *
	 * The reassurance is conditional: it is true when only the network broke, and false when this
	 * device has also failed to write, which is a state {@link notePersistFailure} already knows
	 * about. Promising "still on this device" while local storage is rejecting would be exactly
	 * the kind of false comfort this whole change exists to remove.
	 */
	private unexpectedSyncMessage(
		scope: TodoScope.user | TodoScope.workspace,
		error: unknown
	): string {
		const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
		const reassurance = this.persistFailures.has(scope)
			? "This device has also failed to save a recent change."
			: "Your todos are still on this device.";
		return `Syncing stopped unexpectedly${detail}. ${reassurance}`;
	}

	/**
	 * Reports a failed *local* write, which is a different problem from a failed sync: the edit
	 * is only in memory, so the usual "still on this device" reassurance would be false.
	 *
	 * Reaches here from IndexedDB rejecting — a blocked upgrade with the app open in another tab,
	 * private-mode eviction, or quota.
	 *
	 * Kept in {@link persistFailures} rather than {@link syncFailures}: the two are keyed by scope
	 * and would otherwise overwrite each other, so a failed local write on a scope whose token had
	 * been revoked would replace the `auth` entry and take the "Reconnect" button away with it.
	 */
	private notePersistFailure(scope: TodoScope.user | TodoScope.workspace, error: unknown): void {
		const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
		this.persistFailures.set(scope, {
			kind: "other",
			// Retrying is worth offering: a blocked upgrade or a transient quota rejection can
			// clear on its own, and the retry re-runs the write.
			canRetry: true,
			message: `This device could not save your latest change${detail}. Keep the app open until syncing recovers.`,
		});
		this.publishSyncFailure();
		// A local write that failed is worse than an unpushed change, so it outranks "dirty".
		this.setSyncStatus(scope, "error");
	}

	/** Clears a scope's *sync* failure. Says nothing about local writes; see below. */
	private clearSyncFailure(scope: TodoScope.user | TodoScope.workspace): void {
		this.consecutiveSyncFailures.delete(scope);
		if (this.syncFailures.delete(scope)) {
			this.publishSyncFailure();
		}
	}

	/**
	 * Clears a scope's *persist* failure, on a local write that got through. Separate from
	 * {@link clearSyncFailure} because a successful round trip to GitHub is no evidence that this
	 * device's own storage recovered.
	 */
	private clearPersistFailure(scope: TodoScope.user | TodoScope.workspace): void {
		if (this.persistFailures.delete(scope)) {
			this.publishSyncFailure();
			// The indicator was showing this failure; hand it back to whatever sync is doing —
			// usually "dirty", since the write that just succeeded is still owed to the gist.
			//
			// Unless a reconcile is on the network: this runs from a fire-and-forget promise, and
			// that reconcile has already cleared its pending-push flag, so settling here would
			// announce "up to date" mid-flight and let its own `finally` correct it a moment
			// later. The reconcile settles the scope itself when it ends.
			if (this.statusOf(scope) !== "syncing") {
				this.settleSyncStatus(scope);
			}
		}
	}

	/** Drops every recorded failure, for a disconnect or a fresh connection. */
	private resetSyncFailures(): void {
		this.consecutiveSyncFailures.clear();
		const had = this.syncFailures.size > 0 || this.persistFailures.size > 0;
		this.syncFailures.clear();
		this.persistFailures.clear();
		if (had) {
			this.publishSyncFailure();
		}
		// Deliberately does NOT reset the statuses to "offline". This is also the Reconnect path
		// (`connectGitHub` clears the banner before running the device flow), and a reconnect
		// happens mid-session with a real edit possibly still owed — calling that "not synced
		// yet" would be the app-looks-healthy-while-sync-is-dead state this whole feature exists
		// to remove. Re-settle instead, so the scope reports what it actually is; the two places
		// where the session really ends set "offline" themselves.
		//
		// A reconcile on the network settles itself when it lands, and overriding it here would
		// stop the spinner and show a result for a round trip still in progress — the same guard
		// `clearPersistFailure` needs, for the same reason.
		for (const scope of [TodoScope.user, TodoScope.workspace] as const) {
			if (this.statusOf(scope) !== "syncing") {
				this.settleSyncStatus(scope);
			}
		}
	}

	/**
	 * Emits the most actionable failure across scopes.
	 *
	 * User and workspace fail independently, and a scope can be failing to sync *and* failing to
	 * write locally at once, but the banner has room for one message. A dead token outranks a
	 * rate limit: reporting the 429 that happened to land second would hide the 401 and leave the
	 * "Reconnect" button unrendered.
	 */
	private publishSyncFailure(): void {
		const failures = [...this.syncFailures.values(), ...this.persistFailures.values()];
		if (failures.length === 0) {
			if (this._syncFailure.value.phase !== "ok") {
				this._syncFailure.next({ phase: "ok" });
			}
			return;
		}

		const severity: Record<SyncFailureKind, number> = { auth: 0, data: 1, missing: 2, other: 3 };
		const worst = failures.reduce((a, b) => (severity[a.kind] <= severity[b.kind] ? a : b));
		// Retrying is offered if *any* failure could benefit, since one button covers them all.
		const canRetry = failures.some((f) => f.canRetry);

		this._syncFailure.next({
			phase: "failing",
			kind: worst.kind,
			message: worst.message,
			canRetry,
		});
	}

	private syncFailureMessage(kind: SyncFailureKind, error?: SyncError): string {
		switch (kind) {
			case "auth":
				return "GitHub rejected the sync — the token has expired, been revoked, or lost access. Your todos are still on this device, but they are not syncing.";
			case "missing":
				return "The gist this app syncs with could not be found. Your todos are still on this device, but they are not syncing.";
			case "data":
				// Core's message names the file and what is wrong with it, which is exactly what
				// someone about to open the revision history needs.
				return `${
					error?.message ?? "The gist file could not be read."
				} Syncing is paused until it is readable again.`;
			default:
				// Covers both directions on purpose: a failed pull means edits from VS Code or
				// another device are not arriving either, and the failure can happen before any
				// push is attempted.
				return `Not syncing with GitHub${
					error?.message ? ` (${error.message})` : ""
				}. Changes may not be reaching the gist, and changes from your other devices may not be arriving.`;
		}
	}

	/**
	 * Retries after a failure, from the notice's action.
	 *
	 * Resets the retry budgets, which are spent by the time a transient failure is reported, so
	 * the reconciles will re-arm. Guarded against repeat presses: each one would otherwise queue
	 * another four-to-eight request round trip, which against a rate limit makes things worse.
	 */
	retrySync(): void {
		// From the banner, so a failure is already reported and on screen: forgetting the streak
		// is safe, and starting the next round from zero is what the user asked for.
		this.startManualSync({ forgetSuppressedFailures: true });
	}

	/**
	 * "Sync all now", from the header's menu or its indicator.
	 *
	 * Same guarded path as the banner's retry — repeat presses are the obvious response to a sync
	 * that looks stuck, and each one is another four-to-eight gist requests — but it keeps the
	 * suppression streak. This press may be the user reacting to an *unreported* failure (the
	 * amber "changes not yet on GitHub" a suppressed transient failure leaves behind), and
	 * clearing the counter each time would hold `recordSyncFailure` below its threshold forever:
	 * the banner would never appear and the user would never be told sync was broken.
	 */
	syncNow(): void {
		this.startManualSync({ forgetSuppressedFailures: false });
	}

	private startManualSync(options: { forgetSuppressedFailures: boolean }): void {
		if (this.retryInFlight) {
			return;
		}
		this.retryInFlight = true;
		this.userRetries = 0;
		this.workspaceRetries = 0;
		if (options.forgetSuppressedFailures) {
			this.consecutiveSyncFailures.clear();
		}

		if (!this.token || !this.gistId || !this.userFile) {
			// `refresh()` would return silently here, leaving the button looking broken.
			this.retryInFlight = false;
			this.recordSyncFailure(TodoScope.user, undefined, {
				retryable: false,
				// Explicitly `missing`, so the banner offers the gist chooser. Left to inference
				// this became "other", and the message told the user to choose a gist while the
				// button that does so went unrendered.
				kind: "missing",
				message: "There is no gist selected to sync with. Choose a gist to resume syncing.",
			});
			// The condition is global, but `recordSyncFailure` is per scope — and the banner only
			// needs one entry to render. Mark the other scope too, or the header's indicator keeps
			// reporting the workspace as fine while the banner says nothing is syncing.
			this.setSyncStatus(TodoScope.workspace, "error");
			return;
		}

		void this.refresh().finally(() => {
			this.retryInFlight = false;
		});
	}

	private emitSyncInfo(): void {
		const configured = !!this.token && !!this.gistId && !!this.userFile;
		const info: GitHubSyncInfo = {
			isGitHubSyncEnabled: configured,
			userSyncEnabled: configured,
			workspaceSyncEnabled: configured && !!this.workspaceFile,
			userSyncMode: "github",
			workspaceSyncMode: "github",
			userFile: this.userFile ?? DefaultFileNames.user,
			workspaceFile: this.workspaceFile ?? "",
			isWorkspaceOpen: true,
		};
		this._messages.next({ type: MessageActionsToWebview.updateGitHubSyncInfo, payload: info });
	}

	/**
	 * Live sync state per scope, for the header's indicator. The PWA has no local-only mode, so
	 * these start at "offline" and stay there only until the first reconcile.
	 *
	 * Tracked here rather than derived on demand because the interesting state is "dirty": an
	 * edit that is in local state and IndexedDB but not yet on the gist, which is exactly the
	 * window `scheduleUserPush`/`scheduleWorkspacePush` open and no single value elsewhere
	 * records.
	 */
	private userStatus: SyncStatusValue = "offline";
	private workspaceStatus: SyncStatusValue = "offline";
	/** Whether a scope owes the gist a push — see markDirty below. */
	private pendingUserPush = false;
	private pendingWorkspacePush = false;
	/**
	 * Whether a scope has ever completed a round trip this session. Without it "no failure and
	 * nothing owed" reads as "synced", which is wrong before the first reconcile — and reachable,
	 * because clearing a failure re-settles the scope: tapping Reconnect on a dead token turned
	 * the indicator green over a gist this device had never reached.
	 */
	private userEverSynced = false;
	private workspaceEverSynced = false;

	/** One scope's current status. */
	private statusOf(scope: TodoScope.user | TodoScope.workspace): SyncStatusValue {
		return scope === TodoScope.user ? this.userStatus : this.workspaceStatus;
	}

	private setSyncStatus(
		scope: TodoScope.user | TodoScope.workspace,
		status: SyncStatusValue
	): void {
		if (scope === TodoScope.user) {
			this.userStatus = status;
		} else {
			this.workspaceStatus = status;
		}
		// Always re-evaluate: `emitSyncStatus` dedupes on the whole payload, which the status
		// alone does not determine — `canRetry` comes from the failure maps, and those change
		// under an unchanged status (a `missing` failure replacing an `auth` one, say).
		this.emitSyncStatus();
	}

	/**
	 * Records that a scope holds an edit the gist does not have yet — the window the debounced
	 * push opens, and the one a still-owed retry keeps open.
	 *
	 * A reconcile already on the network keeps showing "syncing": the round trip is the more
	 * informative state, and the flag outlives it, so {@link settleSyncStatus} falls back to
	 * "dirty" when that reconcile ends.
	 */
	private markDirty(scope: TodoScope.user | TodoScope.workspace): void {
		if (scope === TodoScope.user) {
			this.pendingUserPush = true;
		} else {
			this.pendingWorkspacePush = true;
		}
		const status = this.statusOf(scope);
		// "syncing" and "error" both outrank this. Syncing is the more informative of the two
		// live states and settles into "dirty" on its own; a reported failure has to stay on
		// screen, or every edit made while sync is broken would swap the red glyph — and its
		// "try again" — for an amber one that says nothing is wrong.
		if (status !== "syncing" && status !== "error") {
			this.setSyncStatus(scope, "dirty");
		}
	}

	/**
	 * Ends a reconcile on the state the scope is actually in, rather than on a bare "not
	 * syncing": a reported failure, an edit still owed to the gist, or settled.
	 *
	 * Reads the failure maps rather than taking a parameter so every exit path — success,
	 * either failure branch, a throw — settles the same way, and so a failure `recordSyncFailure`
	 * deliberately suppressed as transient stays "dirty" instead of flashing an error the banner
	 * is not showing either.
	 */
	private settleSyncStatus(scope: TodoScope.user | TodoScope.workspace): void {
		if (this.syncFailures.has(scope) || this.persistFailures.has(scope)) {
			this.setSyncStatus(scope, "error");
			return;
		}
		const pending = scope === TodoScope.user ? this.pendingUserPush : this.pendingWorkspacePush;
		if (pending) {
			this.setSyncStatus(scope, "dirty");
			return;
		}
		// Nothing owed and nothing failing is only "synced" if a round trip has actually
		// happened; before that it is still the pre-first-sync state.
		const everSynced =
			scope === TodoScope.user ? this.userEverSynced : this.workspaceEverSynced;
		this.setSyncStatus(scope, everSynced ? "synced" : "offline");
	}

	/** Records that a scope has reached the gist, so it can legitimately report "synced". */
	private noteSynced(scope: TodoScope.user | TodoScope.workspace): void {
		if (scope === TodoScope.user) {
			this.userEverSynced = true;
		} else {
			this.workspaceEverSynced = true;
		}
	}

	/** The payload last sent, so an unchanged one is not re-posted. */
	private lastEmittedStatus: SyncStatusInfo | undefined;

	private emitSyncStatus(): void {
		const payload: SyncStatusInfo = {
			// Either scope on the network keeps the scope-agnostic "Sync all now" spinner going.
			isSyncing: this.userStatus === "syncing" || this.workspaceStatus === "syncing",
			user: this.scopeStatus(TodoScope.user, this.userStatus),
			workspace: this.scopeStatus(TodoScope.workspace, this.workspaceStatus),
		};
		const previous = this.lastEmittedStatus;
		if (
			previous &&
			previous.isSyncing === payload.isSyncing &&
			previous.user.status === payload.user.status &&
			previous.user.canRetry === payload.user.canRetry &&
			previous.workspace.status === payload.workspace.status &&
			previous.workspace.canRetry === payload.workspace.canRetry
		) {
			return;
		}
		this.lastEmittedStatus = payload;
		this._messages.next({
			type: MessageActionsToWebview.updateSyncStatus,
			payload,
		});
	}

	/**
	 * Pairs a status with whether a manual sync is worth offering for it.
	 *
	 * The retryability comes from the recorded failure, not from the status: `recordSyncFailure`
	 * withholds `canRetry` from a revoked token or a deleted gist precisely because re-sending
	 * fails again, and the banner offers Reconnect or the gist chooser instead. An indicator that
	 * offered "try again" for those would sit beside a banner that pointedly does not, and each
	 * press would spend another round trip on a request that cannot succeed.
	 *
	 * A status of "error" with nothing in either map — `retrySync`'s no-gist branch does this to
	 * the scope it is not reporting against — is deliberately not retryable: the fix is choosing
	 * a gist, which only the banner offers.
	 */
	private scopeStatus(
		scope: TodoScope.user | TodoScope.workspace,
		status: SyncStatusValue
	): SyncScopeStatus {
		if (status === "dirty") {
			return { status, canRetry: true };
		}
		if (status !== "error") {
			return { status, canRetry: false };
		}
		// OR across both maps, exactly as the banner does (`publishSyncFailure` picks the most
		// actionable entry). Taking only the sync failure meant a revoked token beside a blocked
		// IndexedDB write showed a banner *with* a working "Try again" and an indicator that
		// refused the click — the divergence this pairing exists to prevent.
		const canRetry =
			(this.syncFailures.get(scope)?.canRetry ?? false) ||
			(this.persistFailures.get(scope)?.canRetry ?? false);
		return { status, canRetry };
	}

	// --- sync ---

	private asSliceState(slice: TodoSlice): TodoSliceState {
		return slice; // structural: TodoSlice already has todos/lastActionType/counts
	}

	private scheduleUserPush(): void {
		this.markDirty(TodoScope.user);
		if (this.userPushTimer) {
			clearTimeout(this.userPushTimer);
		}
		// Persist the edit now rather than only when the push lands. The debounce means the change
		// would otherwise exist solely in memory for `pushDebounceMs`, and on a phone that window
		// routinely ends in the app being backgrounded and torn down. Fire-and-forget: this is a
		// durability backstop, and nothing downstream waits on it — but a *failed* one must still
		// be reported, or the edit exists only in memory while the app says nothing.
		void this.persistUserLocal().then(
			() => this.clearPersistFailure(TodoScope.user),
			(error: unknown) => this.notePersistFailure(TodoScope.user, error)
		);
		this.userPushTimer = setTimeout(
			() => void this.enqueue(() => this.reconcileUser()),
			this.pushDebounceMs
		);
	}

	private scheduleWorkspacePush(): void {
		this.markDirty(TodoScope.workspace);
		if (this.workspacePushTimer) {
			clearTimeout(this.workspacePushTimer);
		}
		void this.persistWorkspaceLocal().then(
			() => this.clearPersistFailure(TodoScope.workspace),
			(error: unknown) => this.notePersistFailure(TodoScope.workspace, error)
		);
		this.workspacePushTimer = setTimeout(
			() => void this.enqueue(() => this.reconcileWorkspace()),
			this.pushDebounceMs
		);
	}

	/**
	 * Backoff retries for *retryable* reconcile failures (a remote that would not settle, a
	 * transient network error). Bounded so a persistently failing file cannot retry forever.
	 *
	 * The attempt counters reset on a successful reconcile and on any local edit: a run of
	 * failures while the phone was offline must not leave the budget exhausted, or a device that
	 * fails mid-flight and then sits idle would never retry at all.
	 *
	 * These keep their **own** timers rather than borrowing the debounce ones. Sharing meant a
	 * retry cancelled a pending edit's push and replaced it with a backoff delay the user's fresh
	 * edit had not earned (up to 24s at the default 3s debounce).
	 */
	private userRetries = 0;
	private workspaceRetries = 0;
	private userRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private workspaceRetryTimer: ReturnType<typeof setTimeout> | undefined;

	private static readonly MAX_SYNC_RETRIES = 3;

	private scheduleUserRetry(): void {
		// Giving up quietly here is safe now: the caller has already handed the failure to
		// `recordSyncFailure`, which reports it independently of this budget.
		if (this.userRetries >= GistGateway.MAX_SYNC_RETRIES) {
			return;
		}
		const attempt = ++this.userRetries;
		if (this.userRetryTimer) {
			clearTimeout(this.userRetryTimer);
		}
		this.userRetryTimer = setTimeout(() => {
			this.userRetryTimer = undefined;
			void this.enqueue(() => this.reconcileUser());
		}, this.pushDebounceMs * 2 ** attempt);
	}

	private scheduleWorkspaceRetry(): void {
		// See scheduleUserRetry.
		if (this.workspaceRetries >= GistGateway.MAX_SYNC_RETRIES) {
			return;
		}
		const attempt = ++this.workspaceRetries;
		if (this.workspaceRetryTimer) {
			clearTimeout(this.workspaceRetryTimer);
		}
		this.workspaceRetryTimer = setTimeout(() => {
			this.workspaceRetryTimer = undefined;
			void this.enqueue(() => this.reconcileWorkspace());
		}, this.pushDebounceMs * 2 ** attempt);
	}

	private async persistUserLocal(): Promise<void> {
		const fileName = this.userFile;
		if (!this.engine || !fileName) {
			return;
		}
		await this.engine.persistLocalUser(fileName, { userTodos: this.user.todos });
	}

	private async persistWorkspaceLocal(): Promise<void> {
		const fileName = this.workspaceFile;
		if (!this.engine || !fileName) {
			return;
		}
		await this.engine.persistLocalWorkspace(fileName, {
			workspaceTodos: this.workspace.todos,
			filesData: this.filesData,
			filesDataPaths: this.filesDataPaths,
		});
	}

	private async reconcileUser(): Promise<void> {
		const engine = this.engine;
		const fileName = this.userFile;
		if (!engine || !fileName) {
			return;
		}
		this.setSyncStatus(TodoScope.user, "syncing");
		// This run is the push the flag was standing in for; anything that re-arms one below
		// (a mid-flight edit, keep-both, a retry) sets it again.
		this.pendingUserPush = false;
		try {
			const local: GlobalGistData = { userTodos: this.user.todos };
			const generation = this.userGeneration;
			const res = await engine.reconcileUser(fileName, local);
			if (res.success && res.data) {
				this.userRetries = 0;
				this.noteSynced(TodoScope.user);
				// A round trip got through, so any standing failure notice is stale.
				this.clearSyncFailure(TodoScope.user);
				// An edit landed while we were on the network, so `res.data.data` was merged from
				// a snapshot that no longer reflects local state. Neither side can just win here:
				// adopting the result drops the edit, and keeping local drops whatever the remote
				// contributed — and since the engine has already moved its baseline to the
				// reconciled data, a dropped remote change reads as a local deletion next pass and
				// gets pushed away. Merge the two against the snapshot instead, then push again.
				// Kept as the whole result, not just the data: the re-merge resolves conflicts of
				// its own — a todo the user edited mid-flight that the reconcile was also changing
				// — and dropping those would leave exactly the silent overwrite this records.
				const remerge =
					this.userGeneration === generation
						? null
						: engine.reconcileWithLocalEdits(local, res.data.data, {
								userTodos: this.user.todos,
							});
				const reconciled = remerge?.data ?? res.data.data;
				const changed = !isEqual({ todos: this.user.todos }, { todos: reconciled.userTodos });
				this.user.todos = reconciled.userTodos;
				// Surface what the engine settled on its own. Runs before anything is emitted or
				// persisted below, because keep-both adds a todo to the slice.
				const keptBoth = this.captureTodoConflicts("user", [
					...res.data.conflicts,
					...(remerge?.conflicts ?? []),
				]);
				if (this.userGeneration !== generation || keptBoth) {
					// Re-persist *after* adopting. The reconcile's own `saveCache` has just replaced
					// the cache entry wholesale, discarding the `persistLocal` that ran when the
					// mid-flight edit arrived — so without this the edit is durable only in memory
					// and a background-kill before the re-armed push loses it. Awaited, unlike the
					// fire-and-forget call in `scheduleUserPush`, to order it after `saveCache`.
					// Keep-both takes the same path: the copy it adds exists only in memory until
					// a push carries it to the gist.
					await this.persistUserLocal();
					this.scheduleUserPush();
				}
				if (changed || keptBoth) {
					this.user.lastActionType = "loadData";
					this.recount(this.user);
					this.emitScope(TodoScope.user);
					// The header's counts ride on the full state payload, so a pull that changed
					// the list has to refresh it too or the badge keeps the pre-pull number.
					this.emitReload();
				}
			} else if (res.error?.retryable) {
				// A retryable failure (a remote that would not settle, a transient network error)
				// leaves the edit unpushed. Nothing else re-arms the push — the stale branch above
				// is inside the success path — so without this the change waits for an unrelated
				// trigger. The edit is still in local state and the cache, so a retry is safe.
				this.scheduleUserRetry();
				// The change is still only local, and a retry is armed — so this is the dirty state,
				// not an error one. `recordSyncFailure` promotes it to "error" if the failures keep
				// coming, which is the same threshold the banner uses.
				this.markDirty(TodoScope.user);
				this.recordSyncFailure(TodoScope.user, res.error, { retryable: true });
			} else {
				// Non-retryable: a deleted gist, a rejected payload. No retry will help, and
				// falling through silently here is what let the app accept edits forever without
				// ever saying they were going nowhere.
				//
				// Still marked as owing a push: this run cleared the flag on the way in, and only
				// a confirmed round trip may leave it clear. Otherwise a later failure-clear — the
				// banner's Reconnect does exactly that — settles the scope to "synced" over an
				// edit that never left the device.
				this.markDirty(TodoScope.user);
				this.recordSyncFailure(TodoScope.user, res.error, { retryable: false });
			}
		} catch (error: unknown) {
			// A throw never reaches the SyncResult branches above, and every caller invokes this
			// through `void this.enqueue(...)`, which discards the rejection. Report it here or it
			// reaches no one — the spinner would simply stop as if the sync had worked.
			this.markDirty(TodoScope.user);
			this.recordSyncFailure(TodoScope.user, undefined, {
				retryable: true,
				message: this.unexpectedSyncMessage(TodoScope.user, error),
			});
		} finally {
			this.settleSyncStatus(TodoScope.user);
		}
	}

	private async reconcileWorkspace(): Promise<void> {
		const engine = this.engine;
		const fileName = this.workspaceFile;
		if (!engine || !fileName) {
			return;
		}
		this.setSyncStatus(TodoScope.workspace, "syncing");
		// See reconcileUser.
		this.pendingWorkspacePush = false;
		try {
			// Round-trip the per-file todos we last saw: the PWA never edits them, but sending
			// `{}` would make the merge treat them as locally deleted and wipe them from the gist.
			const local: WorkspaceGistData = {
				workspaceTodos: this.workspace.todos,
				filesData: this.filesData,
				filesDataPaths: this.filesDataPaths,
			};
			const generation = this.workspaceGeneration;
			const res = await engine.reconcileWorkspace(fileName, local);
			if (res.success && res.data) {
				this.workspaceRetries = 0;
				this.noteSynced(TodoScope.workspace);
				// See reconcileUser.
				this.clearSyncFailure(TodoScope.workspace);
				// See reconcileUser. The workspace counter also covers `filesData`, so this keeps
				// per-file lists as well as `workspaceTodos`.
				const stale = this.workspaceGeneration !== generation;
				// See reconcileUser: the whole result is kept so the re-merge's own conflicts can
				// be recorded rather than silently resolved.
				const remerge = stale
					? engine.reconcileWorkspaceWithLocalEdits(local, res.data.data, {
							workspaceTodos: this.workspace.todos,
							filesData: this.filesData,
							filesDataPaths: this.filesDataPaths,
						})
					: null;
				const merged = remerge?.data ?? res.data.data;
				const workspaceChanged = !isEqual(
					{ todos: this.workspace.todos },
					{ todos: merged.workspaceTodos }
				);
				const filesChanged = !isEqual(this.filesData, merged.filesData);

				this.filesData = merged.filesData;
				this.filesDataPaths = merged.filesDataPaths ?? {};
				this.workspace.todos = merged.workspaceTodos;

				// See reconcileUser. File-level conflicts are recorded too: the PWA never renders
				// those per-file lists, but it is the side that just overwrote one.
				const keptBoth = this.captureTodoConflicts("workspace", [
					...res.data.conflicts,
					...(remerge?.conflicts ?? []),
				]);
				this.captureFileConflicts([...res.data.fileConflicts, ...(remerge?.fileConflicts ?? [])]);

				if (stale || keptBoth) {
					// See reconcileUser: re-persist after adopting, because the reconcile's own
					// `saveCache` has already discarded the mid-flight `persistLocal`.
					await this.persistWorkspaceLocal();
					this.scheduleWorkspacePush();
				}

				if (workspaceChanged || keptBoth) {
					this.workspace.lastActionType = "loadData";
					this.recount(this.workspace);
					this.emitScope(TodoScope.workspace);
				}
				// Per-file todos live in `filesData` and change independently of `workspaceTodos`,
				// so the open file is re-projected off its own comparison.
				if (filesChanged && this.currentFile.filePath) {
					this.currentFile = {
						...this.currentFile,
						todos: [...(this.filesData[this.currentFile.filePath] ?? [])],
						lastActionType: "loadData",
					};
					this.recount(this.currentFile);
					this.emitScope(TodoScope.currentFile);
				}
				if (workspaceChanged || filesChanged || keptBoth) {
					// File list / counts may have changed too.
					this.emitReload();
				}
			} else if (res.error?.retryable) {
				// See reconcileUser.
				this.scheduleWorkspaceRetry();
				// See reconcileUser.
				this.markDirty(TodoScope.workspace);
				this.recordSyncFailure(TodoScope.workspace, res.error, { retryable: true });
			} else {
				// See reconcileUser.
				this.markDirty(TodoScope.workspace);
				this.recordSyncFailure(TodoScope.workspace, res.error, { retryable: false });
			}
		} catch (error: unknown) {
			// See reconcileUser.
			this.markDirty(TodoScope.workspace);
			this.recordSyncFailure(TodoScope.workspace, undefined, {
				retryable: true,
				message: this.unexpectedSyncMessage(TodoScope.workspace, error),
			});
		} finally {
			this.settleSyncStatus(TodoScope.workspace);
		}
	}

	/**
	 * Restores the todos from the persisted sync cache before anything can reconcile.
	 *
	 * Not optional. The cache holds both the last known good data and the merge baseline, but
	 * only the connection settings were being restored on reload — so local state came up empty
	 * against a populated baseline, the reconcile read that as the user having deleted
	 * everything, and it pushed the empty state over the gist. Rehydrating keeps the two halves
	 * in step. Reconciles still run afterwards, so anything stale here is corrected by the pull.
	 */
	private async rehydrateFromCache(): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		if (this.userFile) {
			const cached = await engine.loadCachedUser(this.userFile);
			if (cached) {
				this.user.todos = cached.userTodos;
				this.recount(this.user);
			}
		}
		if (this.workspaceFile) {
			const cached = await engine.loadCachedWorkspace(this.workspaceFile);
			if (cached) {
				this.workspace.todos = cached.workspaceTodos;
				this.filesData = cached.filesData ?? {};
				this.filesDataPaths = cached.filesDataPaths ?? {};
				this.recount(this.workspace);
			}
		}
	}

	/**
	 * Builds the sync engine for a gist. Always goes through here so the IndexedDB-backed
	 * {@link cacheStore} is attached: without it the engine silently falls back to an in-memory
	 * store, every session starts with no merge baseline, and remote changes can never be told
	 * apart from local ones.
	 */
	private createEngine(gistId: string): GistSyncEngine {
		return new GistSyncEngine({ client: this.client, gistId, cacheStore: this.cacheStore });
	}

	/**
	 * Serializes every reconcile. The engine reads a file's cache, diffs, then writes it back;
	 * two overlapping runs would both read the same baseline and the later write would push
	 * against stale state. `ready()`, the focus handler and the debounced pushes can all fire at
	 * once, so the queue is not optional.
	 */
	private syncQueue: Promise<void> = Promise.resolve();

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.syncQueue = this.syncQueue.then(work, work);
		return this.syncQueue;
	}

	private async pullAll(): Promise<void> {
		await this.enqueue(async () => {
			await this.reconcileUser();
			await this.reconcileWorkspace();
		});
	}

	private recount(slice: TodoSlice): void {
		slice.numberOfTodos = slice.todos.filter((t) => !t.completed && !t.isNote).length;
		slice.numberOfNotes = slice.todos.filter((t) => t.isNote).length;
	}

	/**
	 * Apply a mutation to the right scope's slice, echo to the UI, and schedule a push.
	 *
	 * Bumps the scope's generation counter *before* anything can await, so a reconcile that is
	 * currently on the network sees the change and declines to overwrite it. See
	 * {@link userGeneration}.
	 */
	private mutate(scope: TodoScope, fn: (state: TodoSliceState) => void): void {
		if (scope === TodoScope.user) {
			this.userGeneration++;
			// Fresh user activity earns a fresh retry budget. Reset here rather than in
			// `scheduleUserPush`, which the stale re-arm path also calls — refilling on a retry
			// would defeat the bound.
			this.userRetries = 0;
			fn(this.asSliceState(this.user));
			this.emitScope(TodoScope.user);
			this.scheduleUserPush();
		} else if (scope === TodoScope.workspace) {
			this.workspaceGeneration++;
			this.workspaceRetries = 0;
			fn(this.asSliceState(this.workspace));
			this.emitScope(TodoScope.workspace);
			this.scheduleWorkspacePush();
		} else if (scope === TodoScope.currentFile && this.currentFile.filePath) {
			// Per-file todos are written into `filesData`, which lives in the workspace gist file,
			// so this counts as a workspace-scope edit for staleness purposes.
			this.workspaceGeneration++;
			this.workspaceRetries = 0;
			fn(this.asSliceState(this.currentFile));
			// Per-file todos live inside the workspace gist file, so a currentFile edit is
			// written back into filesData and pushed on the workspace timer.
			this.filesData = { ...this.filesData, [this.currentFile.filePath]: this.currentFile.todos };
			this.recount(this.currentFile);
			this.emitScope(TodoScope.currentFile);
			this.scheduleWorkspacePush();
		}
		if (this.pendingConflicts.length > 0) {
			// A pending conflict is stale once the user edits the item it refers to, so the flag
			// the review screen shows has to be recomputed on every edit, not only on sync.
			this.publishConflicts();
		}
	}

	// --- item commands ---

	addTodo(scope: TodoScope, payload: { text: string; position?: "top" | "bottom" }): void {
		this.mutate(scope, (s) => todoMutations.addTodo(s, payload, this.reducerConfig));
	}
	deleteTodo(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.deleteTodo(s, payload));
	}
	undoDelete(scope: TodoScope, payload: Parameters<typeof todoMutations.undoDelete>[1]): void {
		this.mutate(scope, (s) => todoMutations.undoDelete(s, payload));
	}
	toggleTodo(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleTodo(s, payload, this.reducerConfig));
	}
	editTodo(scope: TodoScope, payload: { id: number; newText: string }): void {
		this.mutate(scope, (s) => todoMutations.editTodo(s, payload));
	}
	setTags(scope: TodoScope, payload: { id: number; tags: string[] }): void {
		this.mutate(scope, (s) => todoMutations.setTags(s, payload));
	}
	reorderTodos(scope: TodoScope, payload: { reorderedTodos: Todo[] }): void {
		this.mutate(scope, (s) => todoMutations.reorderTodo(s, payload, this.reducerConfig));
	}
	toggleMarkdown(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleMarkdown(s, payload));
	}
	toggleTodoNote(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleTodoNote(s, payload, this.reducerConfig));
	}
	toggleCollapsed(scope: TodoScope, payload: { id: number }): void {
		this.mutate(scope, (s) => todoMutations.toggleCollapsed(s, payload));
	}
	setAllCollapsed(scope: TodoScope, payload: { collapsed: boolean }): void {
		this.mutate(scope, (s) => todoMutations.setAllCollapsed(s, payload));
	}

	// --- file / view commands ---

	pinFile(): void {
		// Pinning exists to stop the list following the active editor. The PWA has no editor, so
		// the selection is already sticky and there is nothing to pin.
	}
	setCurrentFile(filePath: string): void {
		this.currentFile = {
			...newCurrentFileSlice(),
			filePath,
			todos: filePath ? [...(this.filesData[filePath] ?? [])] : [],
			lastActionType: "loadData",
		};
		this.recount(this.currentFile);
		this.emitScope(TodoScope.currentFile);
		this.emitReload();
	}
	/**
	 * Reads a file the user picks and merges it in.
	 *
	 * Markdown carries no scope of its own, so the extension asks with a `showQuickPick`
	 * ("Import to"). The PWA has no quick pick: it parks in the `awaiting-scope` phase and
	 * {@link pwa-shell} renders the choice, the same way the connect screen renders the gist
	 * chooser. JSON names its own scopes and skips straight through.
	 */
	import(format: ImportFormats): void {
		// An unhandled rejection here would leave the prompt parked with no way out, which is the
		// silent-failure shape this app already had too much of.
		void this.runImport(format).catch((error: unknown) => {
			this.pendingScopeResolver = undefined;
			this._importExport.next({ phase: "error", message: describeUnexpected("import", error) });
		});
	}

	/**
	 * Exports every scope — user, workspace and all per-file lists.
	 *
	 * The extension offers a multi-select of scopes first; here the menu item is the whole
	 * gesture, and a full backup is what "Export" is nearly always wanted for. A JSON export is
	 * lossless and re-imports cleanly; markdown is text only, exactly as in the extension.
	 */
	export(format: ExportFormats): void {
		void this.runExport(format).catch((error: unknown) => {
			this._importExport.next({ phase: "error", message: describeUnexpected("export", error) });
		});
	}

	private async runExport(format: ExportFormats): Promise<void> {
		// Matches the extension's "No data to export, export aborted" rather than handing the
		// user a file with nothing in it.
		const hasAnything =
			this.user.todos.length > 0 ||
			this.workspace.todos.length > 0 ||
			Object.values(this.filesData).some((todos) => todos.length > 0);
		if (!hasAnything) {
			this._importExport.next({ phase: "error", message: "There is nothing to export yet." });
			return;
		}

		this._importExport.next({ phase: "busy", message: "Preparing export…" });

		const data = buildExportObject(
			{ user: true, workspace: true, files: true },
			{
				userTodos: this.user.todos,
				workspaceTodos: this.workspace.todos,
				filesData: this.filesData,
				filesDataPaths: this.filesDataPaths,
			}
		);
		const text = serializeExport(data, format);
		const fileName = buildExportFileName(format);
		const mimeType = format === ExportFormats.JSON ? "application/json" : "text/markdown";

		if (await downloadTextFile(fileName, text, mimeType)) {
			this._importExport.next({ phase: "done", message: `Exported ${fileName}.` });
			return;
		}

		// A standalone-display PWA on iOS can silently drop a download. Offer the share sheet
		// rather than reporting a success that never reached the filesystem.
		if (canShareFile() && (await shareTextFile(fileName, text, mimeType))) {
			this._importExport.next({ phase: "done", message: `Shared ${fileName}.` });
			return;
		}

		this._importExport.next({
			phase: "error",
			message: "Could not save the export. Your browser may be blocking downloads.",
		});
	}

	private async runImport(format: ImportFormats): Promise<void> {
		const accept = format === ImportFormats.JSON ? ".json,application/json" : ".md,text/markdown";
		const picked = await pickTextFile(accept);
		if (!picked.ok) {
			// Cancelling is not an error; say nothing rather than scolding the user.
			this._importExport.next(
				picked.reason === "cancelled"
					? { phase: "idle" }
					: { phase: "error", message: picked.message }
			);
			return;
		}

		let scope: MarkdownImportScopes | undefined;
		if (format === ImportFormats.MARKDOWN) {
			scope = await this.askImportScope(picked.name);
			if (!scope) {
				this._importExport.next({ phase: "idle" });
				return;
			}
		}

		const parsed = parseImport({
			text: picked.text,
			format,
			scope,
			currentFilePath: this.currentFile.filePath,
		});

		if (!parsed.ok) {
			this._importExport.next({ phase: "error", message: parsed.message });
			return;
		}

		await this.applyImport(parsed.data, picked.name);
	}

	/**
	 * Parks in `awaiting-scope` until the shell resolves the choice. Only one import runs at a
	 * time, so a single pending resolver is enough.
	 */
	private askImportScope(fileName: string): Promise<MarkdownImportScopes | undefined> {
		return new Promise((resolve) => {
			this.pendingScopeResolver = resolve;
			this._importExport.next({
				phase: "awaiting-scope",
				fileName,
				currentFilePath: this.currentFile.filePath || undefined,
			});
		});
	}

	/** Called by the shell when the user picks a scope, or dismisses the prompt with `undefined`. */
	resolveImportScope(scope: MarkdownImportScopes | undefined): void {
		const resolver = this.pendingScopeResolver;
		this.pendingScopeResolver = undefined;
		resolver?.(scope);
	}

	/** Dismisses a done/error notice. */
	clearImportExportStatus(): void {
		this._importExport.next({ phase: "idle" });
	}

	/**
	 * Merges a parsed import into local state, persists, and pushes.
	 *
	 * Mirrors what {@link mutate} does for a single edit, but per scope: bump the generation
	 * before anything awaits so an in-flight reconcile sees the change and declines to
	 * overwrite it, reset the retry budget, then persist locally and schedule the push.
	 */
	private async applyImport(data: ImportObject, fileName: string): Promise<void> {
		const result = mergeImport(data, {
			userTodos: this.user.todos,
			workspaceTodos: this.workspace.todos,
			filesData: this.filesData,
			filesDataPaths: this.filesDataPaths,
		});

		if (!hasImportChanges(result)) {
			this._importExport.next({
				phase: "done",
				message: `${fileName} matched what you already have — nothing changed.`,
			});
			return;
		}

		if (result.changed.user) {
			this.userGeneration++;
			this.userRetries = 0;
			this.user.todos = result.userTodos;
			this.user.lastActionType = "loadData";
			this.recount(this.user);
			this.emitScope(TodoScope.user);
			await this.persistUserLocal();
			this.scheduleUserPush();
		}

		// Per-file todos live inside the workspace gist file, so any of these three counts as a
		// workspace-scope edit.
		const workspaceTouched =
			result.changed.workspace || result.changed.filesData || result.changed.filesDataPaths;

		if (workspaceTouched) {
			this.workspaceGeneration++;
			this.workspaceRetries = 0;

			if (result.changed.workspace) {
				this.workspace.todos = result.workspaceTodos;
				this.workspace.lastActionType = "loadData";
				this.recount(this.workspace);
				this.emitScope(TodoScope.workspace);
			}

			this.filesData = result.filesData;
			this.filesDataPaths = result.filesDataPaths;

			// Re-project the open file off its own comparison — `filesData` changes independently
			// of `workspaceTodos`.
			if (result.changed.filesData && this.currentFile.filePath) {
				this.currentFile = {
					...this.currentFile,
					todos: [...(this.filesData[this.currentFile.filePath] ?? [])],
					lastActionType: "loadData",
				};
				this.recount(this.currentFile);
				this.emitScope(TodoScope.currentFile);
			}

			await this.persistWorkspaceLocal();
			this.scheduleWorkspacePush();
		}

		// The file list and counts may both have moved.
		this.emitReload();
		this._importExport.next({
			phase: "done",
			message: `Imported ${describeImportChanges(result.changed)} from ${fileName}.`,
		});
	}
	setWideViewEnabled(isEnabled: boolean): void {
		this.config.enableWideView = isEnabled;
		this.persistViewPreferences();
	}
	setShowTagsEnabled(isEnabled: boolean): void {
		this.config.showTags = isEnabled;
		this.persistViewPreferences();
	}

	/**
	 * Fire-and-forget: the UI has already applied the toggle optimistically (`TodoService`
	 * pushes its own observable before posting the message), so nothing is waiting on the write,
	 * and the store swallows its own failures.
	 */
	private persistViewPreferences(): void {
		void this.viewPreferencesStore.save({
			enableWideView: this.config.enableWideView,
			showTags: this.config.showTags,
		});
	}

	// --- sync / GitHub commands ---

	selectUserSyncMode(): void {
		/* PWA is always GitHub-backed; no mode picker. */
	}
	selectWorkspaceSyncMode(): void {
		/* see above */
	}
	setUserSyncMode(): void {
		/* see above */
	}
	setWorkspaceSyncMode(): void {
		/* see above */
	}

	/**
	 * Runs the GitHub Device Flow, advancing {@link connection} through the phases the connect
	 * screen renders: requesting-code → awaiting-authorization (shows `user_code` +
	 * verification URL) → change-gist, where the user picks or creates the sync gist. Errors
	 * land in the "error" phase instead of throwing, so the UI can offer a retry.
	 */
	async connectGitHub(): Promise<void> {
		// Re-authorizing is the fix for an auth failure; clear the notice so the banner's own
		// action does not appear to do nothing while the new token is being fetched.
		this.resetSyncFailures();
		this.connectAbort?.abort();
		this.connectAbort = new AbortController();
		try {
			this._connection.next({ phase: "requesting-code" });
			const code = await this.deviceFlow.requestDeviceCode();
			this._connection.next({
				phase: "awaiting-authorization",
				userCode: code.user_code,
				verificationUri: code.verification_uri,
				expiresIn: code.expires_in,
			});
			const token = await this.deviceFlow.pollForToken(code.device_code, code.interval, {
				signal: this.connectAbort.signal,
			});

			this.token = token;
			await this.tokenStore.setToken(token);
			this.emitGitHubStatus();

			// The user always picks the gist; the PWA never discovers or infers one.
			await this.changeGist();
		} catch (error) {
			if (error instanceof DeviceFlowError && error.code === "cancelled") {
				this._connection.next({ phase: "disconnected" });
				return;
			}
			const message = error instanceof Error ? error.message : "Connection failed.";
			this._connection.next({ phase: "error", message });
		}
	}

	/** Aborts an in-progress device-flow authorization and returns to the disconnected phase. */
	cancelConnect(): void {
		this.connectAbort?.abort();
	}

	/** Manual gist selection (paste the 32-hex id) for when auto-discovery finds nothing. */
	async submitGistId(gistId: string): Promise<void> {
		const trimmed = gistId.trim();
		if (!GIST_ID_REGEX.test(trimmed)) {
			this._connection.next({ phase: "error", message: "Invalid gist id — expected 32 hex characters." });
			return;
		}
		const gist = await this.client.fetchGist(trimmed);
		if (!gist.success) {
			this._connection.next({
				phase: "error",
				message: gist.error?.message ?? "Could not open that gist.",
			});
			return;
		}
		await this.useGist(trimmed);
	}

	/** Persists the gist id, then moves to file selection (or straight to connected). */
	private async useGist(gistId: string): Promise<void> {
		if (this.gistId && this.gistId !== gistId) {
			await this.resetForNewGist();
		}
		this.gistId = gistId;
		await this.tokenStore.setGistId(gistId);
		this.engine = this.createEngine(gistId);
		this.emitGitHubStatus();
		this._connection.next(await this.enterFileSelection());
		this.emitSyncInfo();
	}

	/**
	 * Drops everything tied to the previous gist before switching. Clearing `cacheStore` is not
	 * optional: its per-file `lastCleanRemoteData` entries are the three-way-merge baselines, so
	 * keeping them would compare one gist's baseline against another gist's content and corrupt
	 * the merge. The file selections go too — they name files in the old gist.
	 */
	private async resetForNewGist(): Promise<void> {
		this.cancelPendingPushes();
		// Wait for any in-flight reconcile before clearing. Cache keys carry only the file name,
		// so a late write from the old gist would otherwise land in the cleared store and be read
		// back as the new gist's baseline — the exact corruption this reset exists to prevent.
		await this.enqueue(async () => {
			await this.cacheStore.clear();
			// Same queue, same reason: a reconcile still on the network would otherwise record the
			// old gist's conflicts into the store we just cleared.
			await this.clearConflicts();
		});
		this.userFile = undefined;
		this.workspaceFile = undefined;
		await this.tokenStore.clearFileSelections();
		// The failures and statuses described the gist we just left — a banner about a gist the
		// user has abandoned, and "synced" against one this device has never contacted, over the
		// list being emptied below. Reset after the queue drains, for the same reason as the
		// clear above; the statuses go last because `resetSyncFailures` re-settles them.
		this.resetSyncFailures();
		// The new gist has not been reached yet, whatever the old one managed.
		this.userEverSynced = false;
		this.workspaceEverSynced = false;
		this.setSyncStatus(TodoScope.user, "offline");
		this.setSyncStatus(TodoScope.workspace, "offline");
		this.user = newUserSlice();
		this.workspace = newWorkspaceSlice();
		this.filesData = {};
		this.filesDataPaths = {};
		this.currentFile = newCurrentFileSlice();
		this.emitReload();
	}

	private cancelPendingPushes(): void {
		// Whatever was owed is being abandoned along with the session or the gist, so the scopes
		// are no longer dirty — leaving the flags set would make the next reconcile settle on
		// "dirty" for a push that will never run.
		this.pendingUserPush = false;
		this.pendingWorkspacePush = false;
		if (this.userPushTimer) {
			clearTimeout(this.userPushTimer);
			this.userPushTimer = undefined;
		}
		if (this.workspacePushTimer) {
			clearTimeout(this.workspacePushTimer);
			this.workspacePushTimer = undefined;
		}
		// Retries keep their own timers, so they need cancelling too — a backoff surviving a
		// disconnect or gist switch would reconcile against file names that no longer apply.
		if (this.userRetryTimer) {
			clearTimeout(this.userRetryTimer);
			this.userRetryTimer = undefined;
		}
		if (this.workspaceRetryTimer) {
			clearTimeout(this.workspaceRetryTimer);
			this.workspaceRetryTimer = undefined;
		}
		this.userRetries = 0;
		this.workspaceRetries = 0;
	}

	/**
	 * Enters the gist picker, listing the account's gists so the user can choose or create one.
	 * Every gist is offered regardless of its description — the PWA never infers which gist to
	 * use. Listing failures are non-fatal: pasting an id still works.
	 */
	async changeGist(): Promise<void> {
		const currentGistId = this.gistId ?? "";
		this._connection.next({
			phase: "change-gist",
			currentGistId,
			gists: [],
			busy: true,
		});
		const listed = await this.client.listGists();
		const gists = listed.success ? (listed.data ?? []) : [];
		const current = gists.find((g) => g.id === currentGistId);
		this._connection.next({
			phase: "change-gist",
			currentGistId,
			current,
			gists,
			message: listed.success ? undefined : listed.error?.message,
		});
	}

	/** Leaves the picker without changing anything. */
	async cancelChangeGist(): Promise<void> {
		this._connection.next(
			this.gistId && this.userFile
				? { phase: "connected", userFile: this.userFile, workspaceFile: this.workspaceFile }
				: await this.enterFileSelection()
		);
	}

	/**
	 * Dismisses the file picker, keeping the current selection. Only meaningful once a session
	 * exists — during first-time setup there is nothing to go back to, so the picker stays.
	 */
	cancelFileSelection(): void {
		if (this.gistId && this.userFile) {
			this._connection.next({
				phase: "connected",
				userFile: this.userFile,
				workspaceFile: this.workspaceFile,
			});
		}
	}

	/** True once a session exists, so the picker can offer Cancel rather than trapping the user. */
	get canCancelFileSelection(): boolean {
		return !!this.gistId && !!this.userFile;
	}

	/** Switches to an existing gist (from the list or a pasted id). */
	async selectGist(gistId: string): Promise<void> {
		const trimmed = gistId.trim();
		if (!GIST_ID_REGEX.test(trimmed)) {
			this.updateChangeGist({ message: "Invalid gist id — expected 32 hex characters." });
			return;
		}
		if (trimmed === this.gistId) {
			await this.cancelChangeGist();
			return;
		}
		this.updateChangeGist({ busy: true, message: undefined });
		const gist = await this.client.fetchGist(trimmed);
		if (!gist.success) {
			this.updateChangeGist({
				busy: false,
				message: gist.error?.message ?? "Could not open that gist.",
			});
			return;
		}
		await this.useGist(trimmed);
	}

	/**
	 * Creates a fresh secret sync gist and switches to it.
	 *
	 * The new gist is stamped with {@link SYNC_GIST_DESCRIPTION} purely for interop: the VS Code
	 * extension still finds its gist by description, so a differently-described one could never
	 * be picked up on that side. The PWA itself never reads the description — it only ever uses
	 * the gist the user selected.
	 */
	async createSyncGist(): Promise<void> {
		this.updateChangeGist({ busy: true, message: undefined });
		const seed: GlobalGistData = { userTodos: [] };
		const created = await this.client.createGist(
			SYNC_GIST_DESCRIPTION,
			{ [DefaultFileNames.user]: JSON.stringify(seed, null, 2) },
			false
		);
		if (!created.success || !created.data) {
			this.updateChangeGist({
				busy: false,
				message: created.error?.message ?? "Could not create the gist.",
			});
			return;
		}
		await this.useGist(created.data.id);
	}

	/** Patches the current change-gist state; ignored if the user has already moved on. */
	private updateChangeGist(patch: Partial<Extract<GistConnectionState, { phase: "change-gist" }>>): void {
		const state = this._connection.value;
		if (state.phase !== "change-gist") {
			return;
		}
		this._connection.next({ ...state, ...patch });
	}

	/**
	 * Lists the gist's `user-*`/`workspace-*` files. If a previously chosen user file is still
	 * present the session resumes as connected; otherwise the picker phase is returned.
	 */
	private async enterFileSelection(): Promise<GistConnectionState> {
		const gistId = this.gistId;
		if (!gistId) {
			return { phase: "needs-gist" };
		}
		const [userFiles, workspaceFiles] = await Promise.all([
			this.client.listFiles(gistId, "user"),
			this.client.listFiles(gistId, "workspace"),
		]);
		if (!userFiles.success || !workspaceFiles.success) {
			return {
				phase: "error",
				message: userFiles.error?.message ?? workspaceFiles.error?.message ?? "Failed to list gist files.",
			};
		}
		const users = userFiles.data ?? [];
		const workspaces = workspaceFiles.data ?? [];
		// Resume only when the stored selection still matches the gist. Both files are mandatory,
		// so a missing or stale one goes back to the picker rather than resuming a session whose
		// scope has nowhere to store its todos.
		const userFileValid = !!this.userFile && users.some((f) => f.fullPath === this.userFile);
		// A file that is not in the gist yet is still valid: the sync engine seeds it on the first
		// reconcile, which is what "New file" in the picker relies on.
		const workspaceFileValid = !!this.workspaceFile;
		if (userFileValid && workspaceFileValid) {
			return { phase: "connected", userFile: this.userFile!, workspaceFile: this.workspaceFile };
		}
		return { phase: "needs-files", userFiles: users, workspaceFiles: workspaces };
	}

	/**
	 * Persists the chosen files and completes the connection. A file that doesn't exist yet is
	 * fine — the sync engine seeds missing files on first reconcile. Both files are required:
	 * the PWA has no local storage, so a scope with no gist file behind it would accept edits
	 * and silently drop them.
	 */
	async chooseFiles(userFile: string, workspaceFile: string): Promise<void> {
		this.userFile = userFile || DefaultFileNames.user;
		await this.tokenStore.setUserFile(this.userFile);
		this.workspaceFile = workspaceFile || DefaultFileNames.workspace("default");
		await this.tokenStore.setWorkspaceFile(this.workspaceFile);
		// A newly chosen workspace file has no cached baseline or todos on this device yet, so
		// load whatever a previous session stored for it before the first reconcile runs.
		await this.rehydrateFromCache();
		this._connection.next({
			phase: "connected",
			userFile: this.userFile,
			workspaceFile: this.workspaceFile,
		});
		this.emitGitHubStatus();
		this.emitSyncInfo();
		await this.pullAll();
	}

	async disconnectGitHub(): Promise<void> {
		// A banner about the old session must not survive it.
		this.resetSyncFailures();
		this.connectAbort?.abort();
		this.cancelPendingPushes();
		this.token = undefined;
		this.gistId = undefined;
		this.userFile = undefined;
		this.workspaceFile = undefined;
		this.engine = undefined;
		await this.tokenStore.clear();
		// Same ordering hazard as resetForNewGist: let any in-flight reconcile finish first.
		await this.enqueue(async () => {
			await this.cacheStore.clear();
			// Same queue, same reason: a reconcile still on the network would otherwise record the
			// old gist's conflicts into the store we just cleared.
			await this.clearConflicts();
		});
		// Again, now that the queue has drained. The reconcile that just finished settled its
		// scope and may have recorded a failure — both of which describe the session we have
		// already torn down, and the first reset above ran before it could.
		this.resetSyncFailures();
		// This is a session that really has ended, so here the pre-first-sync state is the truth.
		// Last, because `resetSyncFailures` re-settles the statuses.
		this.userEverSynced = false;
		this.workspaceEverSynced = false;
		this.setSyncStatus(TodoScope.user, "offline");
		this.setSyncStatus(TodoScope.workspace, "offline");
		this.user = newUserSlice();
		this.workspace = newWorkspaceSlice();
		this.filesData = {};
		this.filesDataPaths = {};
		this.currentFile = newCurrentFileSlice();
		this._connection.next({ phase: "disconnected" });
		this.emitReload();
		this.emitGitHubStatus();
		this.emitSyncInfo();
	}

	/**
	 * The header's "Change GitHub Gist list..." action, for both scopes.
	 *
	 * The extension opens a VS Code quick-pick per scope; the PWA has no host dialogs, so both
	 * route to the file picker that the connection flow already uses, which chooses the user and
	 * workspace files together. These were no-ops, so the menu item looked broken.
	 */
	setUserFile(): void {
		void this.enterFileSelectionFromApp();
	}
	setWorkspaceFile(): void {
		void this.enterFileSelectionFromApp();
	}

	/** Reopens the file picker from the connected app, surfacing any listing failure. */
	private async enterFileSelectionFromApp(): Promise<void> {
		const gistId = this.gistId;
		if (!gistId) {
			// No gist yet — the gist chooser is the right screen, and it leads to the file picker.
			await this.changeGist();
			return;
		}
		const [userFiles, workspaceFiles] = await Promise.all([
			this.client.listFiles(gistId, "user"),
			this.client.listFiles(gistId, "workspace"),
		]);
		if (!userFiles.success || !workspaceFiles.success) {
			this._connection.next({
				phase: "error",
				message:
					userFiles.error?.message ?? workspaceFiles.error?.message ?? "Failed to list gist files.",
			});
			return;
		}
		this._connection.next({
			phase: "needs-files",
			userFiles: userFiles.data ?? [],
			workspaceFiles: workspaceFiles.data ?? [],
		});
	}
	openGistIdSettings(): void {
		// No VS Code settings in the PWA — the header's "Gist: Set ID" action opens the picker,
		// which is the only way to change a gist once one has been persisted.
		void this.changeGist();
	}
	viewGistOnGitHub(): void {
		if (this.gistId) {
			window.open(this.client.getGistUrl(this.gistId), "_blank", "noopener");
		}
	}

	// --- MCP (no host) ---
	startMcpServer(): void {
		/* not applicable in the PWA */
	}
	stopMcpServer(): void {
		/* not applicable in the PWA */
	}

	// --- conflicts ---

	/**
	 * Records the conflicts a reconcile just resolved, and settles id collisions by keeping both.
	 *
	 * By the time we get here the engine has already picked the local side of every conflict and
	 * pushed the result, so nothing is pending in the sync sense — these records exist purely so
	 * the user can see what was decided and reverse it. The exception is `id-collision`: the two
	 * todos were created independently and merely drew the same random id, so they are not
	 * versions of each other and picking a side would destroy a real item. Those are settled here
	 * by re-adding the other device's todo under a fresh id.
	 *
	 * Returns true when keep-both added a todo, so the caller re-emits and schedules a push.
	 */
	private captureTodoConflicts(scope: ConflictScope, conflicts: ConflictSet[]): boolean {
		if (conflicts.length === 0) {
			return false;
		}
		// One reconcile can report the same todo twice: once from the initial merge and again
		// from the re-merge against an edit that landed mid-flight. Keep the later report — its
		// baseline is the one that matches what actually ended up in the list.
		const latest = new Map<number, ConflictSet>();
		for (const conflict of conflicts) {
			latest.set(conflict.todoId, conflict);
		}

		const slice = this.sliceFor(scope);
		const syncedAt = new Date().toISOString();
		const records: PendingConflict[] = [];
		let added = false;

		for (const conflict of latest.values()) {
			if (conflict.conflictType === "id-collision") {
				if (!conflict.local || !conflict.remote) {
					// Both sides are populated by definition for a collision; guard anyway rather
					// than write a half-formed record.
					continue;
				}
				const newId = generateUniqueId(slice.todos);
				slice.todos = [...slice.todos, { ...conflict.remote, id: newId }];
				added = true;
				records.push({
					kind: "kept-both",
					key: todoConflictKey(scope, conflict.todoId),
					scope,
					todoId: conflict.todoId,
					local: conflict.local,
					remote: conflict.remote,
					newId,
					syncedAt,
				});
				continue;
			}
			records.push({
				kind: "todo",
				key: todoConflictKey(scope, conflict.todoId),
				scope,
				todoId: conflict.todoId,
				conflictType: conflict.conflictType,
				base: conflict.base,
				local: conflict.local,
				remote: conflict.remote,
				// The engine's policy is prefer-local, so the local side is what it applied and
				// pushed. A null here means the item is simply absent from the list.
				resolvedValue: conflict.local,
				syncedAt,
			});
		}

		if (added) {
			this.recount(slice);
		}
		this.upsertConflicts(records);
		return added;
	}

	/**
	 * Records conflicts on the per-file todo lists inside the workspace gist file.
	 *
	 * Both sides are stored as **resolutions**, not as the raw arrays the merge reports. Only the
	 * todos both devices changed are really in dispute; `resolveFileConflict` settles just those
	 * and keeps every addition either device made to the file. The raw `local` array is not what
	 * the engine applied, and the raw `remote` array is not what the user would get by choosing
	 * the other device — storing them would mis-state both sides of the choice, mark every record
	 * permanently stale, and applying one would delete the other device’s additions outright.
	 */
	private captureFileConflicts(fileConflicts: FileConflictSet[]): void {
		if (fileConflicts.length === 0) {
			return;
		}
		// Deduped like the todo conflicts: the same path can be reported by both merge passes.
		const latest = new Map<string, FileConflictSet>();
		for (const conflict of fileConflicts) {
			latest.set(conflict.filePath, conflict);
		}
		const syncedAt = new Date().toISOString();
		this.upsertConflicts(
			[...latest.values()].map((conflict) => {
				// prefer-local is the engine’s policy, so this is what it applied and pushed.
				const applied = resolveFileConflict(conflict, "local");
				return {
					kind: "file" as const,
					key: fileConflictKey(conflict.filePath),
					filePath: conflict.filePath,
					conflictType: conflict.conflictType,
					base: conflict.base,
					local: applied,
					remote: resolveFileConflict(conflict, "remote"),
					resolvedValue: applied,
					syncedAt,
				};
			})
		);
	}

	/**
	 * Adds records, replacing any unreviewed record for the same todo or file: a second conflict
	 * on one item supersedes the first, and showing both would offer the user a choice against a
	 * baseline that no longer exists.
	 */
	private upsertConflicts(records: PendingConflict[]): void {
		if (records.length === 0) {
			return;
		}
		const superseded = new Set(records.map((record) => record.key));
		this.pendingConflicts = [
			...records,
			...this.pendingConflicts.filter((conflict) => !superseded.has(conflict.key)),
		].slice(0, MAX_PENDING_CONFLICTS);
		void this.conflictStore.save(this.pendingConflicts);
		this.publishConflicts();
	}

	/** Republishes the list, recomputing each record's staleness against current local state. */
	private publishConflicts(): void {
		this._conflicts.next(
			this.pendingConflicts.map((conflict) => ({ conflict, stale: this.isStale(conflict) }))
		);
	}

	/**
	 * Whether local state has moved on since the sync resolved this conflict. Applying the other
	 * device's version would then discard whatever the user did afterwards, so the review screen
	 * warns and `applyConflictChoice` refuses until told to go ahead.
	 */
	private isStale(conflict: PendingConflict): boolean {
		if (conflict.kind === "kept-both") {
			// Nothing here can be overwritten — the only action is removing the added copy, which
			// is moot once the user has deleted it themselves.
			return !this.sliceFor(conflict.scope).todos.some((todo) => todo.id === conflict.newId);
		}
		if (conflict.kind === "file") {
			return isValueStale(conflict.resolvedValue, this.filesData[conflict.filePath] ?? null);
		}
		return isValueStale(
			conflict.resolvedValue,
			this.sliceFor(conflict.scope).todos.find((todo) => todo.id === conflict.todoId) ?? null
		);
	}

	private sliceFor(scope: ConflictScope): TodoSlice {
		return scope === "user" ? this.user : this.workspace;
	}

	/**
	 * Applies the other device's version of a conflict — or `merged`, when the user assigned
	 * individual fields to each side — and clears the record.
	 *
	 * Returns `"stale"` without changing anything when local state has moved on since the sync;
	 * the caller confirms and calls again with `force`. Returns `"missing"` when the record has
	 * already gone.
	 */
	async applyConflictChoice(
		key: string,
		merged?: Todo,
		force = false
	): Promise<ConflictApplyResult> {
		const conflict = this.pendingConflicts.find((candidate) => candidate.key === key);
		if (!conflict || conflict.kind === "kept-both") {
			return "missing";
		}
		if (!force && this.isStale(conflict)) {
			return "stale";
		}
		if (conflict.kind === "file") {
			this.applyFileValue(conflict.filePath, conflict.remote);
		} else {
			this.applyTodoValue(conflict.scope, conflict.todoId, merged ?? conflict.remote);
		}
		this.forgetConflict(key);
		return "applied";
	}

	/** Removes the copy an id collision added, undoing the automatic keep-both. */
	async undoKeptBoth(key: string): Promise<ConflictApplyResult> {
		const conflict = this.pendingConflicts.find((candidate) => candidate.key === key);
		if (!conflict || conflict.kind !== "kept-both") {
			return "missing";
		}
		this.applyTodoValue(conflict.scope, conflict.newId, null);
		this.forgetConflict(key);
		return "applied";
	}

	/** "Keep this device" — already what happened, so this only clears the record. */
	dismissConflict(key: string): void {
		this.forgetConflict(key);
	}

	dismissAllConflicts(): void {
		this.pendingConflicts = [];
		void this.conflictStore.save([]);
		this.publishConflicts();
	}

	/**
	 * Bulk "keep everything from the other device".
	 *
	 * Records whose item has been edited since the sync are left in the list rather than
	 * force-applied: a blanket choice should not quietly discard an edit made afterwards, which
	 * is exactly what the per-item flow stops to confirm. The counts let the UI say so.
	 */
	async keepAllFromOtherDevice(): Promise<{ applied: number; skipped: number }> {
		let applied = 0;
		let skipped = 0;
		for (const conflict of [...this.pendingConflicts]) {
			if (conflict.kind === "kept-both") {
				// Both versions are already in the list; there is no other side to switch to.
				this.forgetConflict(conflict.key);
				applied++;
			} else if (this.isStale(conflict)) {
				skipped++;
			} else {
				await this.applyConflictChoice(conflict.key);
				applied++;
			}
		}
		return { applied, skipped };
	}

	private applyTodoValue(scope: ConflictScope, todoId: number, value: Todo | null): void {
		this.mutate(scope === "user" ? TodoScope.user : TodoScope.workspace, (state) => {
			const index = state.todos.findIndex((todo) => todo.id === todoId);
			if (value === null) {
				if (index >= 0) {
					state.todos.splice(index, 1);
				}
			} else if (index >= 0) {
				// Replace in place. The merge preserves positional intent from both sides, and a
				// remove-then-append would move a todo the user only meant to change the text of.
				state.todos[index] = value;
			} else {
				// Absent because prefer-local dropped it (deleted here, edited there). Choosing the
				// other device's version means putting it back.
				state.todos.push(value);
			}
			recountTodos(state);
		});
	}

	/**
	 * Writes a per-file list. These live inside the workspace gist file, so this counts as a
	 * workspace-scope edit for staleness and push purposes — the same bookkeeping {@link mutate}
	 * does for `currentFile`, which cannot be reused here because the path being resolved is
	 * usually not the one on screen.
	 */
	private applyFileValue(filePath: string, value: Todo[] | null): void {
		this.workspaceGeneration++;
		this.workspaceRetries = 0;
		const filesData = { ...this.filesData };
		const filesDataPaths = { ...this.filesDataPaths };
		if (value === null) {
			delete filesData[filePath];
			// The path entry only describes a list that exists; leaving it behind would round-trip
			// a record for a file that now has no todos.
			delete filesDataPaths[filePath];
		} else {
			filesData[filePath] = value;
		}
		this.filesData = filesData;
		this.filesDataPaths = filesDataPaths;

		if (this.currentFile.filePath === filePath) {
			this.currentFile = {
				...this.currentFile,
				todos: [...(value ?? [])],
				lastActionType: "loadData",
			};
			this.recount(this.currentFile);
			this.emitScope(TodoScope.currentFile);
		}
		// The file list and its per-file counts are derived from `filesData`.
		this.emitReload();
		this.scheduleWorkspacePush();
	}

	private forgetConflict(key: string): void {
		this.pendingConflicts = this.pendingConflicts.filter((conflict) => conflict.key !== key);
		void this.conflictStore.save(this.pendingConflicts);
		this.publishConflicts();
	}

	/** Drops every pending record — used when switching gists or disconnecting. */
	private async clearConflicts(): Promise<void> {
		this.pendingConflicts = [];
		await this.conflictStore.clear();
		this.publishConflicts();
	}
}
