import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { MatMenuModule, MatMenuTrigger } from "@angular/material/menu";
import { By } from "@angular/platform-browser";
import { BehaviorSubject } from "rxjs";
import { TodoScope } from "../../../../src/todo/todoTypes";
import { McpStatus } from "../../../../src/panels/message";
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
