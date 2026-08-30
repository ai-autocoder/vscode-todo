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
