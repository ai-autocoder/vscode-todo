import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA, signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { MatSnackBar } from "@angular/material/snack-bar";
import { BehaviorSubject, Subject } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { SelectionCommand, TodoService } from "../todo.service";
import { TodoList } from "./todo-list.component";

/**
 * Phase 4c coverage: the list filter's tag awareness — a plain query matches the body
 * text OR any tag, while a leading `tag:` token matches tags only (mirroring the MCP
 * `tag` filter). Driven through the public pullTodos() entry point with a stub service.
 */
describe("TodoList tag filtering", () => {
	let fixture: ComponentFixture<TodoList>;
	let component: TodoList;
	let searchQuery: ReturnType<typeof signal<string>>;
	let lastAction$: BehaviorSubject<string>;

	const makeTodo = (id: number, text: string, tags?: string[]): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
		...(tags ? { tags } : {}),
	});

	const todos: Todo[] = [
		makeTodo(1, "write the parser", ["plan", "bug"]),
		makeTodo(2, "review the parser", ["plan"]),
		makeTodo(3, "ship release", ["release"]),
		makeTodo(4, "untagged item"),
	];

	beforeEach(async () => {
		searchQuery = signal("");
		lastAction$ = new BehaviorSubject<string>("");

		const normalized = () => searchQuery().trim().toLowerCase();
		const serviceStub: Partial<TodoService> = {
			userTodos: todos,
			workspaceTodos: [],
			currentFileTodos: [],
			userLastAction: lastAction$,
			normalizedSearchQuery: normalized as TodoService["normalizedSearchQuery"],
			searchQuery: (() => searchQuery()) as TodoService["searchQuery"],
			isSearchActive: (() => normalized().length > 0) as TodoService["isSearchActive"],
			selectionCommand: () => new Subject<SelectionCommand>().asObservable(),
			setSelectionState: () => undefined,
			getSelectionState: () =>
				new BehaviorSubject({ hasSelection: false, selectedCount: 0, totalCount: 0 }).asObservable(),
		};

		await TestBed.configureTestingModule({
			declarations: [TodoList],
			imports: [NoopAnimationsModule],
			providers: [
				{ provide: TodoService, useValue: serviceStub },
				{ provide: MatSnackBar, useValue: { open: () => ({ onAction: () => new Subject() }) } },
			],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(TodoList);
		component = fixture.componentInstance;
		component.scope = TodoScope.user;
		fixture.detectChanges();
	});

	function filteredIds(query: string): number[] {
		searchQuery.set(query);
		component.pullTodos();
		return component.todos.map((t) => t.id);
	}

	it("no query returns all items", () => {
		expect(filteredIds("")).toEqual([1, 2, 3, 4]);
	});

	it("a plain query matches body text", () => {
		expect(filteredIds("parser")).toEqual([1, 2]);
	});

	it("a plain query also matches tags", () => {
		// "release" appears only as a tag on item 3, not in its body text.
		expect(filteredIds("release")).toEqual([3]);
	});

	it("a tag: query matches tags only, not body text", () => {
		// "parser" is body text only -> tag:parser matches nothing.
		expect(filteredIds("tag:parser")).toEqual([]);
		// tag:plan pulls up the whole plan group.
		expect(filteredIds("tag:plan")).toEqual([1, 2]);
	});

	it("tag: matching is case-insensitive", () => {
		expect(filteredIds("tag:PLAN")).toEqual([1, 2]);
	});

	it("a bare tag: with no value falls back to showing all items", () => {
		// "tag:" is still an active filter (length > 0) but extracts an empty tag,
		// so it must not hide everything — it returns the full list.
		expect(filteredIds("tag:")).toEqual([1, 2, 3, 4]);
	});
});

/**
 * A new item lands wherever `createPosition` says — the bottom in the extension, the top in
 * the PWA — and in a list that already fills the panel that is off-screen, so its enter
 * animation played where nobody could see it and adding looked like nothing had happened.
 * The list scrolls the item that just appeared into view; these cover both ends.
 */
describe("TodoList revealing a newly added item", () => {
	let fixture: ComponentFixture<TodoList>;
	let component: TodoList;
	let lastAction$: BehaviorSubject<string>;
	let todos: Todo[];

	const ROW_HEIGHT = 40;
	const VIEWPORT_HEIGHT = 100;

	const makeTodo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	const container = (): HTMLElement =>
		fixture.nativeElement.querySelector("[cdkDropList]") as HTMLElement;

	/** Resolves after the frame the component defers its scroll to. */
	const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

	beforeEach(async () => {
		todos = [1, 2, 3, 4, 5].map((id) => makeTodo(id, `item ${id}`));
		lastAction$ = new BehaviorSubject<string>("");

		const serviceStub: Partial<TodoService> = {
			get userTodos() {
				return todos;
			},
			workspaceTodos: [],
			currentFileTodos: [],
			userLastAction: lastAction$,
			normalizedSearchQuery: (() => "") as TodoService["normalizedSearchQuery"],
			searchQuery: (() => "") as TodoService["searchQuery"],
			isSearchActive: (() => false) as TodoService["isSearchActive"],
			selectionCommand: () => new Subject<SelectionCommand>().asObservable(),
			setSelectionState: () => undefined,
			getSelectionState: () =>
				new BehaviorSubject({ hasSelection: false, selectedCount: 0, totalCount: 0 }).asObservable(),
		};

		await TestBed.configureTestingModule({
			declarations: [TodoList],
			imports: [NoopAnimationsModule],
			providers: [
				{ provide: TodoService, useValue: serviceStub },
				{ provide: MatSnackBar, useValue: { open: () => ({ onAction: () => new Subject() }) } },
			],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(TodoList);
		component = fixture.componentInstance;
		component.scope = TodoScope.user;
		fixture.detectChanges();

		// `todo-item` is schema-stubbed here, so the rows have no natural size. Give them one,
		// and the list a viewport smaller than the content, so there is a fold to scroll past.
		const style = document.createElement("style");
		style.textContent = `[data-id] { height: ${ROW_HEIGHT}px; }`;
		fixture.nativeElement.appendChild(style);
		component.pullTodos();
		fixture.detectChanges();
		Object.assign(container().style, { height: `${VIEWPORT_HEIGHT}px`, overflowY: "auto" });
	});

	/** Applies `todos` to the list the way a slice arriving from the host does. */
	const addAndSettle = async (todo: Todo, position: "top" | "bottom") => {
		position === "top" ? todos.unshift(todo) : todos.push(todo);
		const scrollBy = spyOn(container(), "scrollBy");
		lastAction$.next("user/addTodo");
		await nextFrame();
		return scrollBy;
	};

	it("scrolls down to an item appended below the fold", async () => {
		const scrollBy = await addAndSettle(makeTodo(6, "appended"), "bottom");

		expect(scrollBy).toHaveBeenCalledTimes(1);
		expect(scrollBy.calls.mostRecent().args[0]).toEqual(
			jasmine.objectContaining({ top: jasmine.any(Number) })
		);
		// Positive: the item is past the bottom edge, so the list scrolls forward to it.
		expect((scrollBy.calls.mostRecent().args[0] as ScrollToOptions).top!).toBeGreaterThan(0);
	});

	it("scrolls back up to an item prepended above the fold", async () => {
		container().scrollTop = container().scrollHeight;
		const scrollBy = await addAndSettle(makeTodo(6, "prepended"), "top");

		expect(scrollBy).toHaveBeenCalledTimes(1);
		expect((scrollBy.calls.mostRecent().args[0] as ScrollToOptions).top!).toBeLessThan(0);
	});

	it("leaves the list alone when the new item is already in view", async () => {
		todos = [makeTodo(1, "only item")];
		lastAction$.next("user/loadData");
		fixture.detectChanges();

		const scrollBy = await addAndSettle(makeTodo(2, "second"), "bottom");

		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does not scroll for an action that adds nothing", async () => {
		const scrollBy = spyOn(container(), "scrollBy");
		lastAction$.next("user/toggleTodo");
		await nextFrame();

		expect(scrollBy).not.toHaveBeenCalled();
	});
});
