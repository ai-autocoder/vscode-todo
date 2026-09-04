import { ChangeDetectorRef, Component, Inject, OnDestroy, OnInit } from "@angular/core";
import { Subscription } from "rxjs";
import {
	DefaultFileNames,
	FILE_NAME_REGEX,
	GistDirectories,
	type GistFileInfo,
} from "@vsc-todo/core";
import { MarkdownImportScopes } from "../../../../src/todo/todoTypes";
import { DATA_GATEWAY, DataGateway } from "../data/data-gateway";
import {
	GistConnectionState,
	GistGateway,
	ImportExportState,
	SyncFailureState,
} from "../data/gist-gateway";
import { dispatchMessageToGateway } from "../data/message-dispatcher";
import { vscode } from "../utilities/vscode";
import type { PendingConflictView } from "./conflicts/conflict-types";

/** Suffix every gist list file carries; `GistClient.listFiles` filters on it. */
const FILE_NAME_SUFFIX = ".json";

/**
 * The editable middle of a gist file name: what is left once the `user-`/`workspace-` prefix
 * and the `.json` suffix are taken off. Tolerates a value that already carries either affix,
 * so pasting a whole file name works as well as typing a bare one.
 */
function fileNameStem(value: string, prefix: string): string {
	let stem = value.trim();
	if (stem.toLowerCase().startsWith(prefix)) {
		stem = stem.slice(prefix.length);
	}
	if (stem.toLowerCase().endsWith(FILE_NAME_SUFFIX)) {
		stem = stem.slice(0, -FILE_NAME_SUFFIX.length);
	}
	return stem.trim();
}

/**
 * Root component of the standalone PWA. Renders the GitHub connection flow (device-flow code
 * screen → gist discovery / paste-id → file picker) and, once connected, hosts the regular
 * app (`<app-root>`).
 *
 * It is also the bridge that makes the untouched extension UI work against the gist:
 * - outbound: installs a `vscode.postMessage` delegate that routes every message the app
 *   sends into {@link GistGateway} commands (see message-dispatcher.ts);
 * - inbound: re-posts the gateway's messages on `window`, where `TodoService`'s existing
 *   listener picks them up exactly as if the extension host had sent them.
 */
@Component({
	selector: "app-pwa-shell",
	templateUrl: "./pwa-shell.component.html",
	styleUrls: ["./pwa-shell.component.css"],
	standalone: false,
})
export class PwaShellComponent implements OnInit, OnDestroy {
	state: GistConnectionState = { phase: "disconnected" };
	/** Kept true once connected so a background error can't unmount the running app. */
	showApp = false;

	// needs-files form state
	userFileChoice = "";
	workspaceFileChoice = "";
	gistIdInput = "";
	/** change-gist form state: the gist chosen in the list, or "" while none is picked. */
	gistChoice = "";

	readonly newUserFileValue = "__new__";
	readonly newWorkspaceFileValue = "__new_workspace__";

	/**
	 * A gist file is only found again if its name carries the `user-`/`workspace-` prefix and the
	 * `.json` suffix — that is exactly what `GistClient.listFiles` filters on. So a new list is
	 * named by its middle part only, typed between two fixed affixes, and the picker cannot be
	 * used to create a file it would then fail to list.
	 */
	readonly userFilePrefix = GistDirectories.user;
	readonly workspaceFilePrefix = GistDirectories.workspace;
	readonly fileNameSuffix = FILE_NAME_SUFFIX;

	/** Name typed for a new list, prefilled with the default the picker used to impose. */
	newUserFileName = "";
	newWorkspaceFileName = "";
	readonly defaultUserFileStem = fileNameStem(DefaultFileNames.user, GistDirectories.user);
	/**
	 * The PWA has no workspace on disk to name the file after, so a newly created workspace list
	 * starts from a fixed name. The extension picks its own name from the open workspace; both
	 * sides just need to agree on the file that is actually selected in the gist.
	 */
	readonly defaultWorkspaceFileStem = fileNameStem(
		DefaultFileNames.workspace("default"),
		GistDirectories.workspace
	);
	/** Why the last Ok was refused, shown under the two selects. */
	fileError = "";

	/**
	 * Conflicts the sync resolved on its own and the user has not reviewed. Drives the banner
	 * over the app and the full-screen review it opens.
	 */
	conflictViews: PendingConflictView[] = [];
	/** Whether the review overlay is open. */
	showConflictReview = false;

	/** A sync that has stopped working; see {@link SyncFailureState}. */
	syncFailureState: SyncFailureState = { phase: "ok" };

	/** Import/export prompt and result notice; see {@link ImportExportState}. */
	importExportState: ImportExportState = { phase: "idle" };
	/** Bound to the scope radio group while `awaiting-scope`. */
	importScopeChoice: MarkdownImportScopes = MarkdownImportScopes.user;
	/** Exposed for the template's radio values. */
	readonly markdownImportScopes = MarkdownImportScopes;

	/** `protected`, not `private`: the template passes it to <app-conflict-review>. */
	protected gateway: GistGateway | undefined;
	private onFocus: (() => void) | undefined;
	private connectionSub: Subscription | undefined;
	private messagesSub: Subscription | undefined;
	private conflictsSub: Subscription | undefined;
	private importExportSub: Subscription | undefined;
	private syncFailureSub: Subscription | undefined;

	constructor(
		@Inject(DATA_GATEWAY) private readonly injectedGateway: DataGateway,
		private readonly cdRef: ChangeDetectorRef
	) {}

	async ngOnInit(): Promise<void> {
		const gateway = this.injectedGateway;
		if (!(gateway instanceof GistGateway)) {
			// Defensive: the PWA build always provides a GistGateway (data.providers.pwa.ts).
			console.error("[PWA] Expected a GistGateway; connection UI disabled.");
			return;
		}
		this.gateway = gateway;

		// Bridge — must be in place before <app-root> (and thus TodoService) exists.
		vscode.setPostMessageDelegate((message) => dispatchMessageToGateway(gateway, message));
		this.messagesSub = gateway.messages.subscribe((message) => {
			window.postMessage(message, window.location.origin);
		});

		this.syncFailureSub = gateway.syncFailure.subscribe((state) => {
			this.syncFailureState = state;
			// `main` is sized to the full viewport by the shared stylesheet, so a banner above it
			// would push the composer off the bottom. This class hands pwa/vscode-theme.css the cue
			// to lay the shell out as a flex column instead, giving the app whatever height is left.
			document.body.classList.toggle("has-sync-banner", state.phase === "failing");
			this.cdRef.detectChanges();
		});

		this.importExportSub = gateway.importExport.subscribe((state) => {
			this.importExportState = state;
			if (state.phase === "awaiting-scope") {
				// Default to the list the user is most likely to mean; File is only offered when
				// one is actually open.
				this.importScopeChoice = MarkdownImportScopes.user;
			}
			this.cdRef.detectChanges();
		});

		this.connectionSub = gateway.connection.subscribe((state) => {
			this.state = state;
			if (state.phase === "connected") {
				this.showApp = true;
			} else if (state.phase === "disconnected") {
				this.showApp = false;
			}
			if (state.phase === "needs-files") {
				// A fresh visit to the picker: drop the previous attempt's complaint and start the
				// new-file names from the defaults.
				this.fileError = "";
				this.newUserFileName = this.defaultUserFileStem;
				this.newWorkspaceFileName = this.defaultWorkspaceFileStem;
				// Preselect what is actually in use; the first entry is only a fallback for a
				// first-time setup, where there is no current selection to show.
				const currentUser = gateway.currentUserFile;
				this.userFileChoice =
					currentUser && state.userFiles.some((f) => f.fullPath === currentUser)
						? currentUser
						: (state.userFiles[0]?.fullPath ?? this.newUserFileValue);
				const currentWorkspace = gateway.currentWorkspaceFile;
				// Mirrors the user list: fall back to the first existing file, then to creating one,
				// so the mandatory select is never left blank.
				this.workspaceFileChoice =
					currentWorkspace && state.workspaceFiles.some((f) => f.fullPath === currentWorkspace)
						? currentWorkspace
						: (state.workspaceFiles[0]?.fullPath ?? this.newWorkspaceFileValue);
			}
			if (state.phase === "change-gist") {
				this.gistChoice = state.currentGistId;
				this.gistIdInput = "";
			}
			// Connecting, disconnecting and the gist picker all change whether the app is on
			// screen at all, which is half of what decides the banner.
			this.syncBannerClass();
			this.cdRef.detectChanges();
		});

		this.conflictsSub = gateway.conflicts.subscribe((views) => {
			this.conflictViews = views;
			// Nothing left to review means nothing left to show; close the overlay rather than
			// leaving the user on an empty screen after they resolve the last card.
			if (views.length === 0) {
				this.showConflictReview = false;
			}
			this.syncBannerClass();
			this.cdRef.detectChanges();
		});

		// The extension polls; the PWA pulls when it regains focus, which is when a phone user
		// comes back to the app. Without this nothing re-syncs after the initial load.
		// `focus` and `visibilitychange` both fire on a single tab return, so the refresh is
		// coalesced into one pull per return rather than two full reconciles.
		let refreshQueued = false;
		this.onFocus = () => {
			if (document.visibilityState !== "visible" || refreshQueued) {
				return;
			}
			refreshQueued = true;
			queueMicrotask(() => {
				refreshQueued = false;
				void gateway.refresh();
			});
		};
		window.addEventListener("focus", this.onFocus);
		document.addEventListener("visibilitychange", this.onFocus);

		await gateway.restoreSession();
	}

	connect(): void {
		void this.gateway?.connectGitHub();
	}

	cancel(): void {
		this.gateway?.cancelConnect();
	}

	retry(): void {
		void this.gateway?.restoreSession();
	}

	disconnect(): void {
		void this.gateway?.disconnectGitHub();
	}

	submitGistId(): void {
		void this.gateway?.submitGistId(this.gistIdInput);
	}

	/**
	 * The picker is entered from the connected app, so it overlays the running UI rather than
	 * replacing it — the app stays mounted and simply comes back when the picker is dismissed.
	 * Switching to a different gist lands in `needs-files`, which must overlay too: the app is
	 * still mounted but its data belongs to the gist we just left.
	 */
	get showConnectScreen(): boolean {
		return !this.showApp || this.state.phase !== "connected";
	}

	/** The gist in use, shown on the file picker so it is clear which one the files came from. */
	get currentGistId(): string | undefined {
		return this.gateway?.currentGistId;
	}

	/**
	 * Whether the picker can be dismissed. During first-time setup it cannot: there is no
	 * session to return to, so the only ways out are choosing files or disconnecting.
	 */
	get canCancelFileSelection(): boolean {
		return this.gateway?.canCancelFileSelection ?? false;
	}

	cancelFileSelection(): void {
		this.gateway?.cancelFileSelection();
	}

	changeGist(): void {
		void this.gateway?.changeGist();
	}

	cancelChangeGist(): void {
		void this.gateway?.cancelChangeGist();
	}

	/** Uses the pasted id when one is typed, otherwise the gist selected in the list. */
	confirmGistChoice(): void {
		const gistId = this.gistIdInput.trim() || this.gistChoice;
		void this.gateway?.selectGist(gistId);
	}

	createSyncGist(): void {
		void this.gateway?.createSyncGist();
	}

	confirmFiles(): void {
		this.fileError = "";
		const state = this.state;
		const userFile = this.resolveFileChoice(
			this.userFileChoice,
			this.newUserFileValue,
			this.newUserFileName,
			this.userFilePrefix,
			"user list",
			state.phase === "needs-files" ? state.userFiles : []
		);
		// Both lists are mandatory: the PWA has no local storage, so a scope without a gist file
		// behind it would accept edits and silently drop them on the next reconcile.
		const workspaceFile = this.resolveFileChoice(
			this.workspaceFileChoice,
			this.newWorkspaceFileValue,
			this.newWorkspaceFileName,
			this.workspaceFilePrefix,
			"workspace list",
			state.phase === "needs-files" ? state.workspaceFiles : []
		);
		if (!userFile || !workspaceFile) {
			return;
		}
		void this.gateway?.chooseFiles(userFile, workspaceFile);
	}

	/**
	 * Turns one select into the gist file name to use. An existing file is its own answer; the
	 * "New file…" option is instead built from the name typed beside it, which has to survive
	 * both GitHub and a later `listFiles`, so it is validated here rather than sent as-is.
	 */
	private resolveFileChoice(
		choice: string,
		newFileValue: string,
		typedName: string,
		prefix: string,
		label: string,
		existing: GistFileInfo[]
	): string | undefined {
		if (choice !== newFileValue) {
			return choice;
		}
		const stem = fileNameStem(typedName, prefix);
		if (!stem) {
			return this.rejectFiles(`Enter a name for the new ${label}.`);
		}
		const fullPath = `${prefix}${stem}${FILE_NAME_SUFFIX}`;
		if (!FILE_NAME_REGEX.test(fullPath)) {
			return this.rejectFiles(`A list name cannot contain \\ / : * ? " < > |`);
		}
		// Reusing an existing file is a legitimate choice, but it is the *other* control — picking
		// it from the list makes it obvious the todos already in it will be adopted.
		if (existing.some((file) => file.fullPath.toLowerCase() === fullPath.toLowerCase())) {
			return this.rejectFiles(`${fullPath} already exists — pick it from the list instead.`);
		}
		return fullPath;
	}

	/** Records the first refusal only: the later one would otherwise hide the earlier control's. */
	private rejectFiles(message: string): undefined {
		this.fileError ||= message;
		return undefined;
	}

	/**
	 * Whether the "changes were resolved automatically" bar is on screen. Hidden while the
	 * review or the connect flow is up — both already cover the app.
	 */
	get showConflictBanner(): boolean {
		return (
			this.showApp &&
			!this.showConnectScreen &&
			!this.showConflictReview &&
			this.conflictViews.length > 0
		);
	}

	openConflictReview(): void {
		this.showConflictReview = true;
		this.syncBannerClass();
	}

	closeConflictReview(): void {
		this.showConflictReview = false;
		this.syncBannerClass();
	}

	/**
	 * Tells the PWA stylesheet the conflict banner is on screen.
	 *
	 * `app.component.scss` sizes `main` at `100dvh`, which ignores its container, so a banner
	 * above it would push the layout off the bottom instead of shrinking it. This class (like
	 * `has-sync-banner`) makes pwa/vscode-theme.css lay the shell out as a flex column and give
	 * the app whatever height the banner leaves — no reserved strip to keep in step, and the two
	 * banners compose if both are up. The shared component styles the extension webview also
	 * uses stay untouched.
	 */
	private syncBannerClass(): void {
		document.body.classList.toggle("has-conflict-banner", this.showConflictBanner);
	}

	/** Confirms the scope prompt, letting the parked import continue. */
	confirmImportScope(): void {
		this.gateway?.resolveImportScope(this.importScopeChoice);
	}

	/** Dismisses the scope prompt, abandoning the import. */
	cancelImportScope(): void {
		this.gateway?.resolveImportScope(undefined);
	}

	/**
	 * Whether the banner has any button to show. A failure with no recovery — a rejected payload,
	 * say — would otherwise render an empty actions row that still took the container's gap.
	 */
	get hasSyncFailureAction(): boolean {
		const state = this.syncFailureState;
		return (
			state.phase === "failing" &&
			(state.kind === "auth" || state.kind === "missing" || state.canRetry)
		);
	}

	/** Retries a failed sync, from the banner. */
	retrySync(): void {
		this.gateway?.retrySync();
	}

	/** Re-runs the device flow after GitHub rejected the stored token. */
	reconnect(): void {
		void this.gateway?.connectGitHub();
	}

	/** Opens the gist chooser after the synced gist went missing. */
	pickAnotherGist(): void {
		void this.gateway?.changeGist();
	}

	/** Dismisses a result notice. */
	dismissImportExportStatus(): void {
		this.gateway?.clearImportExportStatus();
	}

	ngOnDestroy(): void {
		this.connectionSub?.unsubscribe();
		this.messagesSub?.unsubscribe();
		this.conflictsSub?.unsubscribe();
		// The class lives on <body>, outside this component's view, so it survives teardown.
		document.body.classList.remove("has-conflict-banner");
		this.importExportSub?.unsubscribe();
		this.syncFailureSub?.unsubscribe();
		document.body.classList.remove("has-sync-banner");
		// A parked import would otherwise never settle.
		this.gateway?.resolveImportScope(undefined);
		if (this.onFocus) {
			window.removeEventListener("focus", this.onFocus);
			document.removeEventListener("visibilitychange", this.onFocus);
		}
	}
}
