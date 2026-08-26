import { ChangeDetectorRef, Component, Inject, OnDestroy, OnInit } from "@angular/core";
import { Subscription } from "rxjs";
import { DefaultFileNames } from "@vsc-todo/core";
import { DATA_GATEWAY, DataGateway } from "../data/data-gateway";
import { GistConnectionState, GistGateway } from "../data/gist-gateway";
import { dispatchMessageToGateway } from "../data/message-dispatcher";
import { vscode } from "../utilities/vscode";

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

	private gateway: GistGateway | undefined;
	private connectionSub: Subscription | undefined;
	private messagesSub: Subscription | undefined;

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
				this.userFileChoice = state.userFiles[0]?.fullPath ?? this.newUserFileValue;
				this.workspaceFileChoice = state.workspaceFiles[0]?.fullPath ?? "";
			}
			if (state.phase === "change-gist") {
				this.gistChoice = state.currentGistId;
				this.gistIdInput = "";
			}
			this.cdRef.detectChanges();
		});

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
		void this.gateway?.chooseFiles(userFile, this.workspaceFileChoice || undefined);
	}

	ngOnDestroy(): void {
		this.connectionSub?.unsubscribe();
		this.messagesSub?.unsubscribe();
	}
}
