import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { MatMenuModule, MatMenuTrigger } from "@angular/material/menu";
import { By } from "@angular/platform-browser";
import { BehaviorSubject } from "rxjs";
import { TodoScope } from "../../../../src/todo/todoTypes";
import {
	GitHubSyncInfo,
	McpStatus,
	SyncScopeStatus,
	SyncStatusInfo,
	SyncStatusValue,
} from "../../../../src/panels/message";

/**
 * The indicator model, which header.component.ts keeps private. Redeclared rather than exported
 * so the component is free to add fields without this file being the reason it cannot.
 */
type SyncIndicatorInfoForTest = {
	status: SyncStatusValue;
	visible: boolean;
	icon: string;
	spinning: boolean;
	actionable: boolean;
	tooltip: string;
	ariaLabel: string;
};
import { TodoService } from "../todo/todo.service";
import { HeaderComponent } from "./header.component";
import { environment } from "../../environments/environment";

/**
 * The MCP server runs in the extension host. The standalone PWA has no host to start one,
 * so the "Start MCP Server" control must not render there — the extension webview keeps it.
 */
describe("HeaderComponent MCP control", () => {
	let fixture: ComponentFixture<HeaderComponent>;
	let component: HeaderComponent;

	const mcpStatus: McpStatus = {
		running: false,
		enabled: true,
		trusted: true,
	} as McpStatus;

	beforeEach(async () => {
		const gitHubSyncInfo = new BehaviorSubject({
			isGitHubSyncEnabled: false,
		} as never);

		const serviceStub: Partial<TodoService> = {
			userTodos: [],
			workspaceTodos: [],
			currentFileTodos: [],
			enableWideView: new BehaviorSubject(false).asObservable(),
			showTags: new BehaviorSubject(false).asObservable(),
			isGitHubConnected: new BehaviorSubject(false).asObservable(),
			hasGistId: new BehaviorSubject(false).asObservable(),
			gitHubSyncInfo: gitHubSyncInfo.asObservable() as TodoService["gitHubSyncInfo"],
			isSyncing: new BehaviorSubject(false).asObservable(),
			syncStatus: new BehaviorSubject({
				isSyncing: false,
				user: { status: "synced", canRetry: false },
				workspace: { status: "synced", canRetry: false },
			} as SyncStatusInfo).asObservable(),
			now: new BehaviorSubject(0).asObservable() as TodoService["now"],
			mcpStatus: new BehaviorSubject(mcpStatus).asObservable(),
			searchQuery: (() => "") as TodoService["searchQuery"],
		};

		await TestBed.configureTestingModule({
			declarations: [HeaderComponent],
			imports: [NoopAnimationsModule, MatMenuModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(HeaderComponent);
		component = fixture.componentInstance;
		component.currentScope = TodoScope.user;
	});

	/**
	 * The control lives inside a lazily-rendered mat-menu, so open every menu trigger and
	 * read the overlay container — reading the fixture element alone would pass vacuously.
	 */
	function renderedText(): string {
		fixture.detectChanges();
		// The settings menu holds the MCP item; open it through its trigger directive.
		const trigger = fixture.debugElement
			.queryAll(By.directive(MatMenuTrigger))
			.find((el) => (el.nativeElement as HTMLElement).getAttribute("aria-label") === "Menu")
			?.injector.get(MatMenuTrigger);
		if (!trigger) {
			throw new Error("settings menu trigger not found");
		}
		trigger.openMenu();
		fixture.detectChanges();
		const overlays = document.querySelectorAll(".cdk-overlay-container");
		return Array.from(overlays)
			.map((o) => o.textContent ?? "")
			.join(" ");
	}

	it("renders the MCP control when a host is available (extension webview)", () => {
		(component as { isMcpSupported: boolean }).isMcpSupported = true;
		expect(renderedText()).toContain("Start MCP Server");
	});

	it("hides the MCP control when there is no host (PWA)", () => {
		(component as { isMcpSupported: boolean }).isMcpSupported = false;
		expect(renderedText()).not.toContain("Start MCP Server");
	});
});

/**
 * "Local" and "Profile Sync" are extension concepts — the latter is VS Code Settings Sync,
 * which has no meaning in a browser — and the PWA is always GitHub-gist-backed, so the mode
 * picker must not render there. The extension webview keeps it.
 */
describe("HeaderComponent sync mode picker", () => {
	let fixture: ComponentFixture<HeaderComponent>;
	let component: HeaderComponent;

	beforeEach(async () => {
		const gitHubSyncInfo = new BehaviorSubject({
			isGitHubSyncEnabled: true,
			userSyncMode: "github",
			workspaceSyncMode: "github",
		} as never);

		const serviceStub: Partial<TodoService> = {
			userTodos: [],
			workspaceTodos: [],
			currentFileTodos: [],
			enableWideView: new BehaviorSubject(false).asObservable(),
			showTags: new BehaviorSubject(false).asObservable(),
			isGitHubConnected: new BehaviorSubject(true).asObservable(),
			hasGistId: new BehaviorSubject(true).asObservable(),
			gitHubSyncInfo: gitHubSyncInfo.asObservable() as TodoService["gitHubSyncInfo"],
			isSyncing: new BehaviorSubject(false).asObservable(),
			syncStatus: new BehaviorSubject({
				isSyncing: false,
				user: { status: "synced", canRetry: false },
				workspace: { status: "synced", canRetry: false },
			} as SyncStatusInfo).asObservable(),
			now: new BehaviorSubject(0).asObservable() as TodoService["now"],
			mcpStatus: new BehaviorSubject({
				running: false,
				enabled: true,
				trusted: true,
			} as McpStatus).asObservable(),
			searchQuery: (() => "") as TodoService["searchQuery"],
		};

		await TestBed.configureTestingModule({
			declarations: [HeaderComponent],
			imports: [NoopAnimationsModule, MatMenuModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(HeaderComponent);
		component = fixture.componentInstance;
		component.currentScope = TodoScope.user;
	});

	/**
	 * The picker lives inside the lazily-rendered sync menu, reached through the sync pill's
	 * trigger (not the settings menu the MCP specs use). Read the overlay container, since the
	 * fixture element alone would pass vacuously.
	 */
	function syncMenuText(): string {
		fixture.detectChanges();
		const trigger = fixture.debugElement
			.queryAll(By.directive(MatMenuTrigger))
			.find((el) => (el.nativeElement as HTMLElement).classList.contains("sync-pill"))
			?.injector.get(MatMenuTrigger);
		if (!trigger) {
			throw new Error("sync menu trigger not found");
		}
		trigger.openMenu();
		fixture.detectChanges();
		const overlays = document.querySelectorAll(".cdk-overlay-container");
		return Array.from(overlays)
			.map((o) => o.textContent ?? "")
			.join(" ");
	}

	/**
	 * The specs below assign the flag directly, so without this one an inverted initializer
	 * (`environment.pwa` instead of `!environment.pwa`) would strip the picker from the
	 * extension webview and show it in the PWA with every spec, build and lint still passing.
	 */
	it("derives the flag from the build target, not the other way round", () => {
		expect(component.isSyncModeSelectable).toBe(!environment.pwa);
	});

	it("renders the mode picker in the extension webview", () => {
		(component as { isSyncModeSelectable: boolean }).isSyncModeSelectable = true;
		expect(syncMenuText()).toContain("Profile Sync");
	});

	it("hides the mode picker in the PWA, keeping the GitHub section reachable", () => {
		(component as { isSyncModeSelectable: boolean }).isSyncModeSelectable = false;
		const text = syncMenuText();
		expect(text).not.toContain("Profile Sync");
		// The gist controls below the picker must survive — hiding the picker must not take the
		// rest of the sync menu with it.
		expect(text).toContain("Gist: Set ID");
	});

	/**
	 * The picker is two sibling branches — user scope offers three modes, workspace scope two.
	 * Gating only the user branch would leave the workspace one live, so drive the other side
	 * explicitly rather than trusting that both conjuncts were edited.
	 */
	it("hides the workspace-scope modes in the PWA too", () => {
		component.currentScope = TodoScope.workspace;
		(component as { isSyncModeSelectable: boolean }).isSyncModeSelectable = false;
		const text = syncMenuText();
		expect(text).not.toContain("Local");
		expect(text).toContain("Gist: Set ID");
	});

	it("renders the workspace-scope modes in the extension webview", () => {
		component.currentScope = TodoScope.workspace;
		(component as { isSyncModeSelectable: boolean }).isSyncModeSelectable = true;
		expect(syncMenuText()).toContain("Local");
	});
});

/**
 * The sync indicator beside the menu button.
 *
 * Two things about it are easy to get wrong and invisible in a screenshot: it must stay hidden
 * for a scope that has no remote to be behind (the extension's local and profile-sync modes,
 * where the glyph could only ever say "offline"), and only the two states a manual sync can
 * move — Dirty and Error — may act on a click.
 */
describe("HeaderComponent sync indicator", () => {
	let fixture: ComponentFixture<HeaderComponent>;
	let component: HeaderComponent;
	let syncStatus: BehaviorSubject<SyncStatusInfo>;
	let gitHubSyncInfo: BehaviorSubject<GitHubSyncInfo>;
	let syncNowCalls: number;

	/** A scope status, defaulting `canRetry` to what a host that can retry would report. */
	function scope(
		status: SyncStatusValue,
		canRetry = status === "dirty" || status === "error"
	): SyncScopeStatus {
		return { status, canRetry };
	}

	/** Publishes a status for the user scope, leaving the workspace settled. */
	function publish(user: SyncScopeStatus, workspace: SyncScopeStatus = scope("synced")): void {
		syncStatus.next({ isSyncing: user.status === "syncing", user, workspace });
	}

	beforeEach(async () => {
		syncStatus = new BehaviorSubject<SyncStatusInfo>({
			isSyncing: false,
			user: scope("synced"),
			workspace: scope("synced"),
		});
		gitHubSyncInfo = new BehaviorSubject({
			isGitHubSyncEnabled: true,
			userSyncEnabled: true,
			workspaceSyncEnabled: true,
			userSyncMode: "github",
			workspaceSyncMode: "github",
			userFile: "user-todos.json",
			workspaceFile: "workspace-default.json",
			isWorkspaceOpen: true,
		} as GitHubSyncInfo);
		syncNowCalls = 0;

		const serviceStub: Partial<TodoService> = {
			userTodos: [],
			workspaceTodos: [],
			currentFileTodos: [],
			enableWideView: new BehaviorSubject(false).asObservable(),
			showTags: new BehaviorSubject(false).asObservable(),
			isGitHubConnected: new BehaviorSubject(true).asObservable(),
			hasGistId: new BehaviorSubject(true).asObservable(),
			gitHubSyncInfo: gitHubSyncInfo.asObservable() as TodoService["gitHubSyncInfo"],
			isSyncing: new BehaviorSubject(false).asObservable(),
			syncStatus: syncStatus.asObservable(),
			now: new BehaviorSubject(0).asObservable() as TodoService["now"],
			mcpStatus: new BehaviorSubject({
				running: false,
				enabled: true,
				trusted: true,
			} as McpStatus).asObservable(),
			searchQuery: (() => "") as TodoService["searchQuery"],
			syncNow: () => {
				syncNowCalls++;
			},
		};

		await TestBed.configureTestingModule({
			declarations: [HeaderComponent],
			imports: [NoopAnimationsModule, MatMenuModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(HeaderComponent);
		component = fixture.componentInstance;
		component.currentScope = TodoScope.user;
		component.ngOnInit();
	});

	/** The rendered indicator, or null when it is hidden. */
	function indicator(): HTMLElement | null {
		fixture.detectChanges();
		return fixture.nativeElement.querySelector(".sync-indicator") as HTMLElement | null;
	}

	/**
	 * The rendered indicator, asserted to exist. Clicking through an optional chain would let a
	 * "does not sync" assertion pass when the button simply is not there.
	 */
	function renderedIndicator(): HTMLElement {
		const el = indicator();
		expect(el).withContext("indicator should be rendered").not.toBeNull();
		return el as HTMLElement;
	}

	/** The model behind it, which carries the states the DOM only hints at. */
	function info(): SyncIndicatorInfoForTest {
		let latest: SyncIndicatorInfoForTest | undefined;
		component.syncIndicator.subscribe((value) => (latest = value as SyncIndicatorInfoForTest));
		if (!latest) {
			throw new Error("syncIndicator emitted nothing");
		}
		return latest;
	}

	it("renders for a gist-backed scope", () => {
		expect(indicator()).not.toBeNull();
	});

	it("hides itself for a scope with no remote to be behind", () => {
		// Local mode in the extension: there is nothing to be out of date with, so an "offline"
		// glyph beside the menu would be permanent and unactionable. The PWA has no such mode.
		gitHubSyncInfo.next({ ...gitHubSyncInfo.value, userSyncMode: "profile-local" });

		expect(info().visible).toBe(environment.pwa);
	});

	it("removes the button from the DOM when it is hidden, rather than dimming it", () => {
		gitHubSyncInfo.next({ ...gitHubSyncInfo.value, userSyncMode: "profile-local" });

		if (environment.pwa) {
			// The PWA has no non-gist mode, so there is nothing to hide there.
			expect(indicator()).not.toBeNull();
			return;
		}
		// The model-level check above only proves `visible`; this proves the template acts on it.
		expect(indicator()).toBeNull();
	});

	it("reads the workspace status for the File tab, which has no sync of its own", () => {
		publish(scope("synced"), scope("dirty"));
		component.currentScope = TodoScope.currentFile;

		const current = info();
		expect(current.status).toBe("dirty");
		// And says so, rather than letting the user think the file list syncs separately.
		expect(current.tooltip).toContain("workspace");
	});

	it("offers a manual sync on the two states one can fix", () => {
		publish(scope("dirty"));
		expect(info().actionable).toBeTrue();

		publish(scope("error"));
		expect(info().actionable).toBeTrue();
	});

	it("does not offer one on the states a click cannot move", () => {
		for (const status of ["synced", "syncing", "offline"] as const) {
			publish(scope(status));
			expect(info().actionable).withContext(status).toBeFalse();
		}
	});

	/**
	 * The gateway withholds `canRetry` from failures re-sending cannot fix — a revoked token, a
	 * deleted gist — and offers Reconnect or the gist chooser on its banner instead. Offering
	 * "try again" here would put a dead button beside that live one, and spend a request per
	 * press proving it dead.
	 */
	it("does not offer a retry the host says cannot help", () => {
		publish(scope("error", false));

		const current = info();
		expect(current.actionable).toBeFalse();
		// Still red — the sync really is broken — but pointing at what does work.
		expect(current.icon).toBe("sync-error");
		expect(current.tooltip).toContain("Retrying will not help");
	});

	it("does not sync when a non-retryable error is clicked", () => {
		publish(scope("error", false));

		renderedIndicator().click();

		expect(syncNowCalls).toBe(0);
	});

	it("does not offer a retry for a dirty scope the host cannot push", () => {
		// Defensive: a host reporting dirty-but-not-retryable must not get a "Click to sync now"
		// that cannot.
		publish(scope("dirty", false));

		expect(info().actionable).toBeFalse();
	});

	it("syncs when the actionable indicator is clicked", () => {
		publish(scope("dirty"));

		renderedIndicator().click();

		expect(syncNowCalls).toBe(1);
	});

	it("ignores a click on an informational one", () => {
		// The button stays enabled so it keeps its tooltip — the only place the detail lives — so
		// the refusal has to happen in the handler.
		publish(scope("synced"));

		renderedIndicator().click();

		expect(syncNowCalls).toBe(0);
	});

	it("spins only while a sync is actually running", () => {
		publish(scope("syncing"));
		expect(info().spinning).toBeTrue();

		publish(scope("dirty"));
		expect(info().spinning).toBeFalse();
	});

	it("distinguishes the states by glyph, not by colour alone", () => {
		const glyphs = new Set<string>();
		for (const status of ["synced", "dirty", "error", "syncing"] as const) {
			publish(scope(status));
			glyphs.add(info().icon);
		}

		// Dirty and Error are the two that are also tinted; a colour-blind user has to be able to
		// tell them apart without it. ("syncing" shares the idle glyph, and spins instead.)
		expect(glyphs.size).toBeGreaterThanOrEqual(3);
	});

	/**
	 * Every glyph the indicator uses must be one of the `currentColor` cases. The icon set
	 * otherwise hardcodes #C5C5C5, which this component cannot re-tint — that svg sits inside
	 * the icon component's own encapsulation — so a state reaching for `sync` or `check` would
	 * silently stop following the state colour and wash out on light themes.
	 */
	it("uses only glyphs it can tint", () => {
		const tintable = ["sync-idle", "sync-ok", "sync-dirty", "sync-error"];
		for (const status of ["synced", "dirty", "error", "syncing", "offline"] as const) {
			publish(scope(status));
			expect(tintable).withContext(status).toContain(info().icon);
		}
	});

	it("does not call an unsynced scope an error", () => {
		// The pre-first-sync state. Nothing has failed, so it must not read as though it had.
		publish(scope("offline"));

		const current = info();
		expect(current.icon).not.toBe("sync-error");
		expect(current.tooltip).toContain("not synced yet");
	});
});
