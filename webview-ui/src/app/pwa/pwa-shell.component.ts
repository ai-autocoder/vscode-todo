import { ChangeDetectorRef, Component, Inject, OnDestroy, OnInit } from "@angular/core";
import { Subscription } from "rxjs";
import { DefaultFileNames } from "@vsc-todo/core";
import { DATA_GATEWAY, DataGateway } from "../data/data-gateway";
import { GistConnectionState, GistGateway } from "../data/gist-gateway";
import { dispatchMessageToGateway } from "../data/message-dispatcher";
import { vscode } from "../utilities/vscode";
import type { PendingConflictView } from "./conflicts/conflict-types";

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
	readonly defaultUserFileName = DefaultFileNames.user;
	readonly newWorkspaceFileValue = "__new_workspace__";
	/**
	 * The PWA has no workspace on disk to name the file after, so a newly created workspace list
	 * uses a fixed name. The extension picks its own name from the open workspace; both sides
	 * just need to agree on the file that is actually selected in the gist.
	 */
	readonly defaultWorkspaceFileName = DefaultFileNames.workspace("default");

	/**
	 * Conflicts the sync resolved on its own and the user has not reviewed. Drives the banner
	 * over the app and the full-screen review it opens.
	 */
	conflictViews: PendingConflictView[] = [];
	/** Whether the review overlay is open. */
	showConflictReview = false;
	protected gateway: GistGateway | undefined;
	private onFocus: (() => void) | undefined;
	private connectionSub: Subscription | undefined;
	private messagesSub: Subscription | undefined;
	private conflictsSub: Subscription | undefined;

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

		this.connectionSub = gateway.connection.subscribe((state) => {
			this.state = state;
			if (state.phase === "connected") {
				this.showApp = true;
			} else if (state.phase === "disconnected") {
				this.showApp = false;
			}
			if (state.phase === "needs-files") {
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
		const userFile =
			this.userFileChoice === this.newUserFileValue ? this.defaultUserFileName : this.userFileChoice;
		// Both lists are mandatory: the PWA has no local storage, so a scope without a gist file
		// behind it would accept edits and silently drop them on the next reconcile.
		const workspaceFile =
			this.workspaceFileChoice === this.newWorkspaceFileValue
				? this.defaultWorkspaceFileName
				: this.workspaceFileChoice;
		void this.gateway?.chooseFiles(userFile, workspaceFile);
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
	 * Reserves the strip the fixed banner occupies.
	 *
	 * The banner cannot be a normal-flow sibling of `<app-root>`: `app.component.scss` sizes
	 * `main` at `100dvh`, which ignores its container, so anything above it would push the
	 * layout off the bottom instead of shrinking it. The class lets the PWA-only stylesheet
	 * shorten `main` by exactly the banner's height without touching the shared component
	 * styles the extension webview also uses.
	 */
	private syncBannerClass(): void {
		document.body.classList.toggle("has-conflict-banner", this.showConflictBanner);
	}

	ngOnDestroy(): void {
		this.connectionSub?.unsubscribe();
		this.messagesSub?.unsubscribe();
		this.conflictsSub?.unsubscribe();
		// The class lives on <body>, outside this component's view, so it survives teardown.
		document.body.classList.remove("has-conflict-banner");
		if (this.onFocus) {
			window.removeEventListener("focus", this.onFocus);
			document.removeEventListener("visibilitychange", this.onFocus);
		}
	}
}
