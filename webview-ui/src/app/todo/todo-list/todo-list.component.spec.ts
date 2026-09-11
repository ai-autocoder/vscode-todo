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
			consumeLocalAdd: () => false,
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
	/** Stands in for the composer having just posted an add; see TodoService.consumeLocalAdd. */
	let localAddPending: boolean;

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
		localAddPending = false;

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
			consumeLocalAdd: () => {
				const pending = localAddPending;
				localAddPending = false;
				return pending;
			},
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

	/**
	 * Applies `todos` to the list the way a slice arriving from the host does. `origin` is where
	 * the add came from: the composer in this webview, or anywhere else (the MCP server, another
	 * window) — which reaches the webview as the very same action.
	 */
	const addAndSettle = async (
		todo: Todo,
		position: "top" | "bottom",
		{ origin = "composer", action = "user/addTodo" } = {}
	) => {
		position === "top" ? todos.unshift(todo) : todos.push(todo);
		localAddPending = origin === "composer";
		const scrollBy = spyOn(container(), "scrollBy");
		lastAction$.next(action);
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

	it("shows the start of an item too tall to fit", async () => {
		const style = document.createElement("style");
		style.textContent = `[data-id="6"] { height: ${VIEWPORT_HEIGHT * 2}px; }`;
		fixture.nativeElement.appendChild(style);

		const scrollBy = await addAndSettle(makeTodo(6, "a very long note"), "bottom");

		// Aligned to its top (content above it is 5 rows tall, less the margin), not to its
		// bottom — which would be a longer scroll and would leave the first line off-screen.
		const top = (scrollBy.calls.mostRecent().args[0] as ScrollToOptions).top!;
		expect(top).toBeCloseTo(ROW_HEIGHT * 5 - 8, 0);
	});

	it("leaves the list alone when the new item is already in view", async () => {
		todos = [makeTodo(1, "only item")];
		lastAction$.next("user/loadData");
		fixture.detectChanges();

		const scrollBy = await addAndSettle(makeTodo(2, "second"), "bottom");

		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does not scroll when nothing was added", async () => {
		const scrollBy = spyOn(container(), "scrollBy");
		localAddPending = true;
		lastAction$.next("user/toggleTodo");
		await nextFrame();

		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does not scroll when an item appears below the fold on a non-add action", async () => {
		// The item is new to the list and lands off-screen, so only the action gate can stop the
		// scroll here.
		const scrollBy = await addAndSettle(makeTodo(6, "arrived with a reorder"), "bottom", {
			action: "user/reorderTodo",
		});

		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does not scroll for an add made outside this webview", async () => {
		// `todo_add_item` over MCP dispatches the same reducer and arrives as the same action, so
		// without the composer's flag this would yank the list away from whoever is reading it.
		const scrollBy = await addAndSettle(makeTodo(6, "added by an agent"), "bottom", {
			origin: "elsewhere",
		});

		expect(scrollBy).not.toHaveBeenCalled();
	});

	/**
	 * The reorder animation measures rows in viewport coordinates before and after a pull, so any
	 * scroll in between reads as movement. A reveal's own smooth scroll has to be discounted —
	 * and a scroll the browser performs itself, clamping the offset when content shrinks, must
	 * not be, because that one really does move the rows on screen.
	 */
	describe("and the reorder animation underneath it", () => {
		/** Spies on every currently rendered row's WAAPI call and returns the spies by id. */
		const spyOnRowAnimations = (): Map<number, jasmine.Spy> => {
			const spies = new Map<number, jasmine.Spy>();
			fixture.nativeElement.querySelectorAll("[data-id]").forEach((el: HTMLElement) => {
				spies.set(Number(el.getAttribute("data-id")), spyOn(el, "animate"));
			});
			return spies;
		};

		/** The vertical component of the transform a row was animated from. */
		const animatedFromY = (spy: jasmine.Spy): number => {
			const keyframes = spy.calls.mostRecent().args[0] as Keyframe[];
			return Number(
				/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(String(keyframes[0]["transform"]))![1]
			);
		};

		it("discounts a reveal scroll that is still running", async () => {
			// First add starts a reveal; scrollBy is spied, so the list does not really move and
			// the test can play the scroll out by hand.
			await addAndSettle(makeTodo(6, "first"), "bottom");

			const spies = spyOnRowAnimations();
			todos.push(makeTodo(7, "second"));
			localAddPending = true;
			// scrollBy is already spied from the first add, and the spy persists on the element.
			lastAction$.next("user/addTodo");
			// The reveal's scroll advances between the snapshot and the frame that measures.
			container().scrollTop = 40;
			await nextFrame();

			// Appending moves no existing row, so once the scroll is discounted there is nothing
			// left to animate.
			expect(spies.get(1)!).not.toHaveBeenCalled();
			expect(spies.get(5)!).not.toHaveBeenCalled();
		});

		it("still animates a collapse that lands while a reveal is running", async () => {
			// The narrow case: a reveal scroll is genuinely in flight, so the window is open, but
			// this offset change is the browser clamping to a content box that just got shorter.
			container().scrollTop = container().scrollHeight;
			await addAndSettle(makeTodo(6, "first"), "bottom");

			const spies = spyOnRowAnimations();
			lastAction$.next("user/setAllCollapsed");
			// Shrinking the rows after the snapshot is what collapsing does: the content box
			// shortens and the browser clamps scrollTop down to the new maximum by itself.
			const collapsed = document.createElement("style");
			collapsed.textContent = `[data-id] { height: ${ROW_HEIGHT / 2}px; }`;
			fixture.nativeElement.appendChild(collapsed);
			await nextFrame();

			// Rows really did move, so the FLIP must show it rather than discount it as ours.
			expect(spies.get(1)!).toHaveBeenCalled();
			expect(animatedFromY(spies.get(1)!)).toBeLessThan(0);
		});

		it("still animates a jump the browser made on its own", async () => {
			// No reveal has run, so the offset change is the browser clamping scrollTop — what
			// collapsing every note does — and the rows really did move.
			const spies = spyOnRowAnimations();
			lastAction$.next("user/setAllCollapsed");
			container().scrollTop = 40;
			await nextFrame();

			expect(spies.get(1)!).toHaveBeenCalled();
			expect(animatedFromY(spies.get(1)!)).toBeCloseTo(40, 0);
		});
	});
});
