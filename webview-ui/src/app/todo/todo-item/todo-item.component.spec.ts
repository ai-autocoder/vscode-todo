import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { FormsModule } from "@angular/forms";
import { MatMenuModule } from "@angular/material/menu";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { BehaviorSubject } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";
import { TodoItemComponent } from "./todo-item.component";

/**
 * Phase 4c coverage: the webview tag surface on a todo item — Show Tags gating of the
 * chips, clicking a chip to filter by `tag:<tag>`, and the inline tag editor's
 * add/remove paths (which round-trip through TodoService.setTags).
 */
describe("TodoItemComponent tags", () => {
	let fixture: ComponentFixture<TodoItemComponent>;
	let component: TodoItemComponent;
	let showTags$: BehaviorSubject<boolean>;
	let setTagsSpy: jasmine.Spy;
	let setSearchQuerySpy: jasmine.Spy;

	const makeTodo = (overrides: Partial<Todo> = {}): Todo => ({
		id: 1,
		text: "a task",
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
		...overrides,
	});

	beforeEach(async () => {
		showTags$ = new BehaviorSubject<boolean>(false);
		setTagsSpy = jasmine.createSpy("setTags");
		setSearchQuerySpy = jasmine.createSpy("setSearchQuery");

		const serviceStub: Partial<TodoService> = {
			showTags: showTags$.asObservable(),
			config: { collapsedPreviewLines: 1 } as TodoService["config"],
			setTags: setTagsSpy,
			setSearchQuery: setSearchQuerySpy,
			activeEditor: () => new BehaviorSubject<number | null>(null).asObservable(),
			clearActiveEditor: () => undefined,
			setActiveEditor: () => undefined,
		};

		await TestBed.configureTestingModule({
			declarations: [TodoItemComponent],
			imports: [FormsModule, MatMenuModule, NoopAnimationsModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(TodoItemComponent);
		component = fixture.componentInstance;
		component.scope = TodoScope.user;
		component.todo = makeTodo({ tags: ["plan", "bug"] });
		fixture.detectChanges();
	});

	function chipTexts(): string[] {
		return Array.from(
			fixture.nativeElement.querySelectorAll(".tag-chips .tag-chip") as NodeListOf<HTMLElement>
		).map((el) => el.textContent!.trim());
	}

	it("hides chips when Show Tags is off and shows them when on", () => {
		expect(chipTexts().length).toBe(0);

		showTags$.next(true);
		fixture.detectChanges();
		expect(chipTexts()).toEqual(["plan", "bug"]);
	});

	it("does not render the chip row for an untagged item even when Show Tags is on", () => {
		component.todo = makeTodo({ tags: undefined });
		showTags$.next(true);
		fixture.detectChanges();
		expect(chipTexts().length).toBe(0);
	});

	it("clicking a chip sets the search to tag:<tag>", () => {
		showTags$.next(true);
		fixture.detectChanges();

		const firstChip = fixture.nativeElement.querySelector(
			".tag-chips .tag-chip"
		) as HTMLButtonElement;
		firstChip.click();

		expect(setSearchQuerySpy).toHaveBeenCalledWith("tag:plan");
	});

	it("addTagFromInput normalizes input and calls setTags with the merged list", () => {
		component.todo = makeTodo({ tags: ["plan"] });
		component.tagInput = "  Bug , plan ";
		component.addTagFromInput();

		// "plan" already present (deduped), "Bug" added; whitespace trimmed.
		expect(setTagsSpy).toHaveBeenCalledWith(TodoScope.user, { id: 1, tags: ["plan", "Bug"] });
		expect(component.tagInput).toBe("");
	});

	it("removeTag drops the tag and calls setTags with the remainder", () => {
		component.todo = makeTodo({ tags: ["plan", "bug"] });
		component.removeTag("plan");
		expect(setTagsSpy).toHaveBeenCalledWith(TodoScope.user, { id: 1, tags: ["bug"] });
	});

	it("Backspace on an empty input removes the last tag", () => {
		component.todo = makeTodo({ tags: ["plan", "bug"] });
		component.tagInput = "";
		const event = new KeyboardEvent("keydown", { key: "Backspace" });
		component.onTagInputKeydown(event);
		expect(setTagsSpy).toHaveBeenCalledWith(TodoScope.user, { id: 1, tags: ["plan"] });
	});
});
