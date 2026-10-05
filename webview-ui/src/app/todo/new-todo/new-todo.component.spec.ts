import { ChangeDetectorRef, CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { FormsModule } from "@angular/forms";
import { BehaviorSubject, Subject } from "rxjs";
import { TodoScope } from "../../../../../src/todo/todoTypes";
import { AutosizeTextArea } from "../../shared/autosize-textarea.component";
import { ComposerAdd, TodoService } from "../todo.service";
import { NewTodoComponent } from "./new-todo.component";

describe("NewTodoComponent", () => {
	let component: NewTodoComponent;
	let fixture: ComponentFixture<NewTodoComponent>;
	let undeliveredAdds: Subject<ComposerAdd>;
	let lateDeliveredAdds: Subject<ComposerAdd>;
	let addTodo: jasmine.Spy;

	beforeEach(async () => {
		undeliveredAdds = new Subject<ComposerAdd>();
		lateDeliveredAdds = new Subject<ComposerAdd>();
		addTodo = jasmine.createSpy("addTodo");
		const serviceStub: Partial<TodoService> = {
			getSelectionState: () =>
				new BehaviorSubject({ hasSelection: false, selectedCount: 0, totalCount: 0 }).asObservable(),
			setSelectionState: () => undefined,
			undeliveredAdds: undeliveredAdds.asObservable(),
			lateDeliveredAdds: lateDeliveredAdds.asObservable(),
			addTodo,
			isWorkspaceOpen: true,
		};

		await TestBed.configureTestingModule({
			declarations: [NewTodoComponent],
			imports: [FormsModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();
	});

	beforeEach(() => {
		fixture = TestBed.createComponent(NewTodoComponent);
		component = fixture.componentInstance;
		fixture.componentRef.setInput("scope", TodoScope.user);
		fixture.componentRef.setInput("currentFilePath", "/work/notes.md");
		fixture.detectChanges();
	});

	/** Text entered in the box, the way the textarea reports it, marking the view as its event does. */
	function type(text: string): void {
		component.onTextInserted(text);
		fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck();
	}

	function send(): void {
		component.addTodo(new Event("click"));
	}

	function showList(scope: TodoScope, filePath = "/work/notes.md"): void {
		fixture.componentRef.setInput("scope", scope);
		fixture.componentRef.setInput("currentFilePath", filePath);
		fixture.detectChanges();
	}

	function notice(): string | null {
		fixture.detectChanges();
		const element = (fixture.nativeElement as HTMLElement).querySelector(".new-todo-warning");
		return element?.textContent?.trim() ?? null;
	}

	const lost = (text: string, scope = TodoScope.user, filePath?: string): ComposerAdd =>
		filePath === undefined ? { scope, text } : { scope, text, filePath };

	it("should create", () => {
		expect(component).toBeTruthy();
	});

	/**
	 * The box clears as soon as an add is sent, and a webview that has lost its host accepts input
	 * while every message it posts goes nowhere. The service hands back what it never saw come
	 * back; these pin what the composer does with it.
	 */
	describe("an add the host never confirmed", () => {
		it("puts the text back in an empty box and says it was not saved", () => {
			undeliveredAdds.next(lost("buy milk"));

			expect(component.newTodoText).toBe("buy milk");
			expect(notice()).toContain("Not saved");
		});

		it("waits while a draft is in the box rather than merging into it, then comes back", () => {
			// Sent as one item, "a new draft\nbuy milk" would save both as a single todo.
			type("a new draft");
			undeliveredAdds.next(lost("buy milk"));

			expect(component.newTodoText).toBe("a new draft");
			expect(notice()).toContain("comes back here once this box is empty");

			send();

			expect(addTodo).toHaveBeenCalledWith(TodoScope.user, { text: "a new draft" });
			expect(component.newTodoText).toBe("buy milk");
		});

		it("waits even when the draft happens to contain the text", () => {
			type("buy milk and eggs");
			undeliveredAdds.next(lost("buy milk"));
			send();

			expect(component.newTodoText).toBe("buy milk");
		});

		it("shows several one at a time, each after the one before it is sent", () => {
			undeliveredAdds.next(lost("a"));
			undeliveredAdds.next(lost("b"));
			expect(component.newTodoText).toBe("a");

			send();
			expect(component.newTodoText).toBe("b");

			send();
			expect(component.newTodoText).toBe("");
			expect(notice()).toBeNull();
		});

		it("takes the text out again when the host turns out to have stored it", () => {
			const add = lost("buy milk");
			undeliveredAdds.next(add);

			lateDeliveredAdds.next(add);

			expect(component.newTodoText).toBe("");
			expect(notice()).toBeNull();
		});

		it("takes out whichever arrives late, in any order", () => {
			// The first handed back is the first to arrive, and is the one in the box.
			const a = lost("a");
			const b = lost("b");
			undeliveredAdds.next(a);
			undeliveredAdds.next(b);

			lateDeliveredAdds.next(a);
			expect(component.newTodoText).toBe("b");

			lateDeliveredAdds.next(b);
			expect(component.newTodoText).toBe("");
			expect(notice()).toBeNull();
		});

		it("drops a waiting add that arrives late without touching the box", () => {
			const b = lost("b");
			undeliveredAdds.next(lost("a"));
			undeliveredAdds.next(b);

			lateDeliveredAdds.next(b);
			send();

			expect(component.newTodoText).toBe("");
		});

		it("leaves the text alone once it has been edited, since it is then the user's", () => {
			const add = lost("buy milk");
			undeliveredAdds.next(add);
			type("buy milk and eggs");

			lateDeliveredAdds.next(add);

			expect(component.newTodoText).toBe("buy milk and eggs");
			expect(notice()).toBeNull();
		});

		it("ignores a late arrival for an add it never got back", () => {
			type("buy milk");

			lateDeliveredAdds.next(lost("buy milk"));

			expect(component.newTodoText).toBe("buy milk");
		});

		it("drops the notice when the text is deleted from the box", () => {
			undeliveredAdds.next(lost("buy milk"));

			type("");

			expect(notice()).toBeNull();
		});

		it("brings a waiting text back when the draft is deleted rather than sent", () => {
			jasmine.clock().install();
			try {
				type("a new draft");
				undeliveredAdds.next(lost("buy milk"));

				type("");
				jasmine.clock().tick(1);

				expect(component.newTodoText).toBe("buy milk");
			} finally {
				jasmine.clock().uninstall();
			}
		});

		it("keeps an add for another list out of this one and says where it went", () => {
			undeliveredAdds.next(lost("buy milk", TodoScope.workspace));

			expect(component.newTodoText).toBe("");
			expect(notice()).toContain("for the Workspace list");

			showList(TodoScope.workspace);

			expect(component.newTodoText).toBe("buy milk");
		});

		it("takes an untouched text out of the box when another list is shown", () => {
			undeliveredAdds.next(lost("buy milk"));

			showList(TodoScope.workspace);

			expect(component.newTodoText).toBe("");
			expect(notice()).toContain("for the User list");

			showList(TodoScope.user);

			expect(component.newTodoText).toBe("buy milk");
		});

		it("keeps a per-file add for that file's list", () => {
			showList(TodoScope.currentFile, "/work/other.md");
			undeliveredAdds.next(lost("check the heading", TodoScope.currentFile, "/work/notes.md"));

			expect(component.newTodoText).toBe("");
			expect(notice()).toContain("for the list for notes.md");

			showList(TodoScope.currentFile, "/work/notes.md");

			expect(component.newTodoText).toBe("check the heading");
		});
	});
});

/**
 * With the real textarea, for what only shows on screen: a text deleted in the textarea itself
 * leaves this view's binding holding it, so putting the same text straight back changed nothing
 * the binding could see, and the textarea stayed empty while the box held the text.
 */
describe("NewTodoComponent with its textarea", () => {
	let component: NewTodoComponent;
	let fixture: ComponentFixture<NewTodoComponent>;
	let undeliveredAdds: Subject<ComposerAdd>;

	beforeEach(async () => {
		undeliveredAdds = new Subject<ComposerAdd>();
		const serviceStub: Partial<TodoService> = {
			getSelectionState: () =>
				new BehaviorSubject({ hasSelection: false, selectedCount: 0, totalCount: 0 }).asObservable(),
			setSelectionState: () => undefined,
			undeliveredAdds: undeliveredAdds.asObservable(),
			lateDeliveredAdds: new Subject<ComposerAdd>().asObservable(),
			addTodo: () => undefined,
			isWorkspaceOpen: true,
		};

		await TestBed.configureTestingModule({
			declarations: [NewTodoComponent, AutosizeTextArea],
			imports: [FormsModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA],
		}).compileComponents();

		jasmine.clock().install();
		fixture = TestBed.createComponent(NewTodoComponent);
		component = fixture.componentInstance;
		fixture.componentRef.setInput("scope", TodoScope.user);
		fixture.detectChanges();
	});

	afterEach(() => {
		jasmine.clock().uninstall();
	});

	function textarea(): HTMLTextAreaElement {
		return (fixture.nativeElement as HTMLElement).querySelector("textarea")!;
	}

	it("shows the next text even when it reads the same as the one just deleted", () => {
		// Sent twice from a tab that had lost its host, so both come back.
		undeliveredAdds.next({ scope: TodoScope.user, text: "buy milk" });
		undeliveredAdds.next({ scope: TodoScope.user, text: "buy milk" });
		fixture.detectChanges();
		expect(textarea().value).toBe("buy milk");

		textarea().value = "";
		textarea().dispatchEvent(new Event("input"));
		fixture.detectChanges();
		jasmine.clock().tick(1);
		fixture.detectChanges();

		expect(component.newTodoText).toBe("buy milk");
		expect(textarea().value).toBe("buy milk");
	});
});
