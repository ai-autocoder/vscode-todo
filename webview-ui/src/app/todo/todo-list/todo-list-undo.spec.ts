import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA, signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { MatSnackBar } from "@angular/material/snack-bar";
import { BehaviorSubject, Subject, of } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { SelectionCommand, TodoService } from "../todo.service";
import { TodoList } from "./todo-list.component";

/**
 * Delete + UNDO, from the list's side: what the three delete paths (a row's delete, "delete
 * selected", "clear completed") hand the host to restore.
 *
 * The host rebuilds the item from this payload alone and splices it back in by index, so the
 * payload has to carry everything the item had and an index into the list the reducer will
 * splice — the full list, not the filtered view the user happens to be looking at.
 *
 * `itKnownBug` cases state the correct behaviour and pass only while the code still fails it.
 * When one starts failing, the defect is fixed: turn it into a plain `it`.
 */

/** Throws on mismatch, so a known-bug check can tell "still broken" from "fixed". */
function assertEqual(actual: unknown, expected: unknown, what: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${what}: expected ${e}, got ${a}`);
	}
}

function itKnownBug(name: string, check: () => Promise<void> | void): void {
	it(`KNOWN BUG — ${name}`, async () => {
		let failure: unknown;
		try {
			await check();
		} catch (error) {
			failure = error;
		}
		expect(failure)
			.withContext("This defect appears to be fixed: turn this case into a plain it().")
			.toBeDefined();
	});
}

describe("TodoList delete and undo", () => {
	let fixture: ComponentFixture<TodoList>;
	let component: TodoList;
	let searchQuery: ReturnType<typeof signal<string>>;
	let undo$: Subject<void>;
	let deleteTodo: jasmine.Spy;
	let undoDelete: jasmine.Spy;

	const makeTodo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
		...over,
	});

	let todos: Todo[];

	beforeEach(async () => {
		todos = [
			makeTodo(1, "alpha"),
			makeTodo(2, "bravo", { tags: ["x"] }),
			makeTodo(3, "charlie"),
			makeTodo(4, "delta", {
				tags: ["x", "done"],
				completed: true,
				completionDate: "2026-02-02T00:00:00.000Z",
			}),
		];
		searchQuery = signal("");
		undo$ = new Subject<void>();
		deleteTodo = jasmine.createSpy("deleteTodo");
		undoDelete = jasmine.createSpy("undoDelete");

		const normalized = () => searchQuery().trim().toLowerCase();
		const serviceStub: Partial<TodoService> = {
			get userTodos() {
				return todos;
			},
			workspaceTodos: [],
			currentFileTodos: [],
			userLastAction: new BehaviorSubject<string>(""),
			currentFilePath: of(""),
			normalizedSearchQuery: normalized as TodoService["normalizedSearchQuery"],
			searchQuery: (() => searchQuery()) as TodoService["searchQuery"],
			isSearchActive: (() => normalized().length > 0) as TodoService["isSearchActive"],
			matchesLocalAdd: () => false,
			claimLocalAdd: () => false,
			selectionCommand: () => new Subject<SelectionCommand>().asObservable(),
			setSelectionState: () => undefined,
			getSelectionState: () =>
				new BehaviorSubject({ hasSelection: false, selectedCount: 0, totalCount: 0 }).asObservable(),
			deleteTodo,
			undoDelete,
		};

		await TestBed.configureTestingModule({
			declarations: [TodoList],
			imports: [NoopAnimationsModule],
			providers: [
				{ provide: TodoService, useValue: serviceStub },
				{ provide: MatSnackBar, useValue: { open: () => ({ onAction: () => undo$.asObservable() }) } },
			],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(TodoList);
		component = fixture.componentInstance;
		component.scope = TodoScope.user;
		fixture.detectChanges();
	});

	function show(query: string): void {
		searchQuery.set(query);
		component.pullTodos();
	}

	function select(...ids: number[]): void {
		component.selectedTodoIds = new Set(ids);
	}

	/** The payloads the UNDO sent, in order. Bulk restores are paced by animation frames. */
	async function pressUndo(): Promise<Array<Record<string, unknown>>> {
		undo$.next();
		for (let i = 0; i < 6; i++) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
		return undoDelete.calls.allArgs().map(([, payload]) => payload as Record<string, unknown>);
	}

	describe("a row's own delete", () => {
		it("deletes the item and restores it on UNDO with its text, flags and tags", async () => {
			show("");
			await component.handleDelete(todos[1]);

			expect(deleteTodo).toHaveBeenCalledWith(TodoScope.user, { id: 2 });
			const [payload] = await pressUndo();
			expect(payload).toEqual(
				jasmine.objectContaining({ text: "bravo", tags: ["x"], completed: false, itemPosition: 1 })
			);
		});

		itKnownBug("restores at the full-list position while a filter is showing", async () => {
			show("tag:x"); // shows [bravo, delta]; delta sits at index 3 of the full list
			await component.handleDelete(todos[3]);

			const [payload] = await pressUndo();
			assertEqual(payload["itemPosition"], 3, "itemPosition");
		});
	});

	describe("delete selected", () => {
		it("deletes every selected item and restores them all on UNDO, in list order", async () => {
			show("");
			select(3, 1);
			await component.deleteSelected();

			expect(deleteTodo.calls.allArgs()).toEqual([
				[TodoScope.user, { id: 1 }],
				[TodoScope.user, { id: 3 }],
			]);
			const payloads = await pressUndo();
			expect(payloads.map((p) => [p["text"], p["itemPosition"]])).toEqual([
				["alpha", 0],
				["charlie", 2],
			]);
		});

		itKnownBug("keeps the restored items' tags", async () => {
			show("");
			select(2);
			await component.deleteSelected();

			const [payload] = await pressUndo();
			assertEqual(payload["tags"], ["x"], "tags");
		});

		itKnownBug("keeps a restored completed item's completion date", async () => {
			show("");
			select(4);
			await component.deleteSelected();

			const [payload] = await pressUndo();
			assertEqual(payload["completionDate"], "2026-02-02T00:00:00.000Z", "completionDate");
		});

		itKnownBug("restores at full-list positions while a filter is showing", async () => {
			show("tag:x");
			select(2, 4);
			await component.deleteSelected();

			const payloads = await pressUndo();
			assertEqual(
				payloads.map((p) => p["itemPosition"]),
				[1, 3],
				"itemPosition"
			);
		});
	});

	describe("clear completed", () => {
		it("deletes only completed tasks", async () => {
			show("");
			await component.deleteCompleted();

			expect(deleteTodo.calls.allArgs()).toEqual([[TodoScope.user, { id: 4 }]]);
		});

		itKnownBug("restores the cleared items with their tags and completion date", async () => {
			show("");
			await component.deleteCompleted();

			const [payload] = await pressUndo();
			assertEqual(
				[payload["tags"], payload["completionDate"]],
				[["x", "done"], "2026-02-02T00:00:00.000Z"],
				"tags and completionDate"
			);
		});
	});
});
