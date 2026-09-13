import {
	mergeFilesData,
	type ConflictDecisions,
	type ConflictSet,
	type FileConflictSet,
	type Todo,
} from "@vsc-todo/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { ConflictPromptComponent } from "./conflict-prompt.component";

/**
 * The up-front prompt turns taps into a {@link ConflictDecisions}, and the engine applies that
 * map literally. Two properties matter more than the rest:
 *
 *  - an undecided conflict must be ABSENT from the map, not present as local. Absent means "the
 *    policy decides", which keeps this device's version *and* leaves the record for the review
 *    screen. A `null` value would mean "delete it", and writing local in explicitly would settle
 *    it silently, which is the behaviour this whole feature replaces.
 *  - keep-both must draw an id nothing else uses. Two collisions in one merge would otherwise be
 *    able to pick the same one, and the copy would overwrite its sibling.
 */
describe("ConflictPromptComponent", () => {
	const todo = (id: number, text: string, extra: Partial<Todo> = {}): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
		...extra,
	});

	const conflict = (id: number, type: ConflictSet["conflictType"] = "edit-edit"): ConflictSet => ({
		todoId: id,
		base: type === "id-collision" ? null : todo(id, "base"),
		local: todo(id, `local ${id}`),
		remote: todo(id, `remote ${id}`),
		conflictType: type,
	});

	let component: ConflictPromptComponent;
	let emitted: Array<ConflictDecisions | null>;

	function mount(todos: ConflictSet[], files: FileConflictSet[] = [], knownIds?: number[]): void {
		component = new ConflictPromptComponent();
		component.request = {
			todos,
			files,
			knownIds: knownIds ?? todos.map((c) => c.todoId),
		};
		emitted = [];
		component.decided.subscribe((decisions) => emitted.push(decisions));
	}

	function decisions(): ConflictDecisions {
		component.apply();
		const last = emitted[emitted.length - 1];
		if (last === null) {
			throw new Error("expected decisions, got a cancel");
		}
		return last;
	}

	it("leaves an untouched conflict out of the map entirely", () => {
		mount([conflict(1)]);

		const result = decisions();

		expect(result.todos).toBeUndefined();
		expect(result.files).toBeUndefined();
		expect(result.extraTodos).toBeUndefined();
	});

	it("records this device's version when it is chosen explicitly", () => {
		mount([conflict(1)]);
		component.chooseTodo(1, "local");

		expect(decisions().todos?.get(1)?.text).toBe("local 1");
	});

	it("records the other device's version", () => {
		mount([conflict(1)]);
		component.chooseTodo(1, "remote");

		expect(decisions().todos?.get(1)?.text).toBe("remote 1");
	});

	it("records a deletion as null when the chosen side deleted the item", () => {
		const deleted: ConflictSet = { ...conflict(1, "edit-delete"), remote: null };
		mount([deleted]);
		component.chooseTodo(1, "remote");

		const result = decisions();
		expect(result.todos?.has(1)).toBe(true);
		expect(result.todos?.get(1)).toBeNull();
	});

	it("decides only the conflicts that were answered", () => {
		mount([conflict(1), conflict(2), conflict(3)]);
		component.chooseTodo(2, "remote");

		const result = decisions();
		expect([...(result.todos?.keys() ?? [])]).toEqual([2]);
	});

	it("goes back to undecided when the active choice is tapped again", () => {
		mount([conflict(1)]);
		component.chooseTodo(1, "remote");
		component.chooseTodo(1, "remote");

		expect(decisions().todos).toBeUndefined();
		expect(component.undecidedCount).toBe(1);
	});

	it("counts what is still unanswered", () => {
		mount([conflict(1), conflict(2)]);
		expect(component.undecidedCount).toBe(2);

		component.chooseTodo(1, "local");
		expect(component.undecidedCount).toBe(1);
	});

	it("answers everything at once from the bulk buttons", () => {
		mount([conflict(1), conflict(2)]);
		component.chooseAll("remote");

		const result = decisions();
		expect(result.todos?.get(1)?.text).toBe("remote 1");
		expect(result.todos?.get(2)?.text).toBe("remote 2");
		expect(component.undecidedCount).toBe(0);
	});

	describe("keep both", () => {
		it("is offered only for an id collision with two versions", () => {
			mount([conflict(1, "edit-edit"), conflict(2, "id-collision")]);

			expect(component.canKeepBoth(component.todoConflicts[0])).toBe(false);
			expect(component.canKeepBoth(component.todoConflicts[1])).toBe(true);
		});

		it("keeps this device on the contested id and re-adds the other under a free one", () => {
			mount([conflict(7, "id-collision")], [], [7, 8, 9]);
			component.chooseTodo(7, "keep-both");

			const result = decisions();
			expect(result.todos?.get(7)?.text).toBe("local 7");
			const extras = result.extraTodos?.get(7) ?? [];
			expect(extras.length).toBe(1);
			expect(extras[0].text).toBe("remote 7");
			expect([7, 8, 9]).not.toContain(extras[0].id);
		});

		it("draws a different id for each collision in one merge", () => {
			mount([conflict(1, "id-collision"), conflict(2, "id-collision")], [], [1, 2]);
			component.chooseTodo(1, "keep-both");
			component.chooseTodo(2, "keep-both");

			const result = decisions();
			const first = result.extraTodos?.get(1)?.[0].id;
			const second = result.extraTodos?.get(2)?.[0].id;
			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(first).not.toBe(second);
		});
	});

	describe("per-file lists", () => {
		const filePath = "src/app.ts";
		/**
		 * Built by the real merge, not by hand: a `FileConflictSet` carries an `itemMerge` that
		 * `resolveFileConflict` needs, and a literal without it silently degrades to taking the
		 * chosen side's raw array — which is the very loss this test is here to catch.
		 */
		const fileConflict = (): FileConflictSet => {
			const base = [todo(10, "base")];
			const local = [todo(10, "renamed here"), todo(12, "added here")];
			const remote = [todo(10, "renamed there"), todo(13, "added there")];
			return mergeFilesData({ [filePath]: base }, { [filePath]: local }, { [filePath]: remote })
				.conflicts[0];
		};

		it("is left out when nobody chooses", () => {
			mount([], [fileConflict()]);

			expect(decisions().files).toBeUndefined();
		});

		/**
		 * The stored value is the *resolution*, not the raw array from the chosen device: only
		 * the todos both sides changed are in dispute, so either choice has to keep every item
		 * the other device added to the file.
		 */
		it("stores the resolution, keeping both devices' additions", () => {
			mount([], [fileConflict()]);
			component.chooseFile(filePath, "remote");

			const stored = decisions().files?.get(filePath) ?? [];
			const texts = stored.map((t) => t.text);
			expect(texts).toContain("renamed there");
			expect(texts).not.toContain("renamed here");
			expect(texts).toContain("added here");
			expect(texts).toContain("added there");
		});
	});

	describe("cancelling", () => {
		it("takes a second, deliberate tap", () => {
			mount([conflict(1)]);

			component.requestCancel();
			expect(component.confirmingCancel).toBe(true);
			expect(emitted.length).toBe(0);

			component.confirmCancel();
			expect(emitted).toEqual([null]);
		});

		it("can be backed out of without answering", () => {
			mount([conflict(1)]);
			component.requestCancel();
			component.keepDeciding();

			expect(component.confirmingCancel).toBe(false);
			expect(emitted.length).toBe(0);
		});
	});
});

/**
 * The bulk buttons, which are the one place a destructive answer can be given without looking
 * at the item.
 *
 * An `id-collision` has no common ancestor: the two sides may be independently created items
 * that merely drew the same random id, and picking a side then deletes a real one. Nothing in
 * the data tells that apart from two versions of one item, which is why the card offers Keep
 * Both without recommending it. A bulk tap is not that considered choice, so it must not make
 * it — left undecided the gateway keeps both, which duplicates at worst instead of deleting,
 * and leaves a review record to undo.
 *
 * This matters more than it looks: `bootstrap` merges against an *empty* base, so on a device
 * with local todos syncing a gist for the first time, EVERY todo present on both sides with
 * differing content comes back as `id-collision`.
 */
describe("ConflictPromptComponent bulk choices", () => {
	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	const conflict = (id: number, type: ConflictSet["conflictType"]): ConflictSet => ({
		todoId: id,
		base: type === "id-collision" ? null : todo(id, "base"),
		local: todo(id, `local ${id}`),
		remote: todo(id, `remote ${id}`),
		conflictType: type,
	});

	let component: ConflictPromptComponent;

	function mount(todos: ConflictSet[]): void {
		component = new ConflictPromptComponent();
		component.request = { todos, files: [], knownIds: todos.map((c) => c.todoId) };
	}

	function decisions(): ConflictDecisions {
		let captured: ConflictDecisions | null = null;
		component.decided.subscribe((value) => (captured = value));
		component.apply();
		if (captured === null) {
			throw new Error("expected decisions, got a cancel");
		}
		return captured as unknown as ConflictDecisions;
	}

	it("answers an ordinary conflict", () => {
		mount([conflict(1, "edit-edit")]);
		component.chooseAll("remote");

		expect(decisions().todos?.get(1)?.text).toBe("remote 1");
	});

	it("refuses to answer an id collision, so neither side can be dropped in bulk", () => {
		mount([conflict(1, "id-collision")]);
		component.chooseAll("remote");

		expect(decisions().todos).toBeUndefined();
		expect(component.undecidedCount).toBe(1);
	});

	it("still answers the rest alongside a collision", () => {
		mount([conflict(1, "id-collision"), conflict(2, "edit-edit")]);
		component.chooseAll("local");

		const result = decisions();
		expect([...(result.todos?.keys() ?? [])]).toEqual([2]);
	});

	it("reports how many it left, so the open cards are not a mystery", () => {
		mount([conflict(1, "id-collision"), conflict(2, "id-collision"), conflict(3, "edit-edit")]);
		component.chooseAll("remote");

		expect(component.bulkSkipped).toBe(2);
	});

	it("drops the report once the user answers anything themselves", () => {
		mount([conflict(1, "id-collision"), conflict(2, "edit-edit")]);
		component.chooseAll("remote");
		component.chooseTodo(1, "keep-both");

		expect(component.bulkSkipped).toBe(0);
	});
});

/**
 * The rendered dialog.
 *
 * The specs above drive the class directly, which says nothing about whether a tap reaches it or
 * whether the card shows the right outcome. Both have already been wrong here: the undecided
 * line claimed "this device's version is kept" on a collision card that actually keeps both, and
 * the cancel confirmation sat in normal flow below a list several screens tall, so on a long
 * list Cancel greyed itself out and the panel explaining why was off-screen.
 */
describe("ConflictPromptComponent rendering", () => {
	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	const conflict = (id: number, type: ConflictSet["conflictType"]): ConflictSet => ({
		todoId: id,
		base: type === "id-collision" ? null : todo(id, "base"),
		local: todo(id, `local ${id}`),
		remote: todo(id, `remote ${id}`),
		conflictType: type,
	});

	let fixture: ComponentFixture<ConflictPromptComponent>;
	let component: ConflictPromptComponent;

	function render(todos: ConflictSet[]): void {
		fixture = TestBed.createComponent(ConflictPromptComponent);
		component = fixture.componentInstance;
		component.request = { todos, files: [], knownIds: todos.map((c) => c.todoId) };
		fixture.detectChanges();
	}

	function host(): HTMLElement {
		return fixture.nativeElement as HTMLElement;
	}

	function cards(): HTMLElement[] {
		return Array.from(host().querySelectorAll<HTMLElement>(".card"));
	}

	function sidesOf(card: HTMLElement): HTMLButtonElement[] {
		return Array.from(card.querySelectorAll<HTMLButtonElement>("button.side"));
	}

	function cancelButton(): HTMLButtonElement {
		return host().querySelectorAll<HTMLButtonElement>(".action-row button")[1];
	}

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			declarations: [ConflictPromptComponent],
		}).compileComponents();
	});

	it("renders one card per conflict", () => {
		render([conflict(1, "edit-edit"), conflict(2, "edit-edit")]);

		expect(cards().length).toBe(2);
	});

	it("records the choice when a side is tapped, and marks it on screen", () => {
		render([conflict(1, "edit-edit")]);
		const [, other] = sidesOf(cards()[0]);

		other.click();
		fixture.detectChanges();

		expect(component.todoChoice(1)).toBe("remote");
		expect(sidesOf(cards()[0])[1].classList).toContain("chosen");
		expect(sidesOf(cards()[0])[1].getAttribute("aria-pressed")).toBe("true");
	});

	it("offers Keep Both only where the merge found no shared history", () => {
		render([conflict(1, "edit-edit"), conflict(2, "id-collision")]);

		expect(cards()[0].querySelector("button.keep-both")).toBeNull();
		expect(cards()[1].querySelector("button.keep-both")).not.toBeNull();
	});

	it("tells a collision card that both versions are kept, not this device's", () => {
		render([conflict(1, "id-collision")]);

		const pending = cards()[0].querySelector(".pending")!.textContent!;
		expect(pending).toContain("both are kept");
		expect(pending).not.toContain("this device's version is kept");
	});

	it("tells an ordinary card that this device's version is kept", () => {
		render([conflict(1, "edit-edit")]);

		expect(cards()[0].querySelector(".pending")!.textContent).toContain(
			"this device's version is kept"
		);
	});

	it("drops the undecided line once the card is answered", () => {
		render([conflict(1, "edit-edit")]);
		sidesOf(cards()[0])[0].click();
		fixture.detectChanges();

		expect(cards()[0].querySelector(".pending")).toBeNull();
		expect(cards()[0].classList).not.toContain("undecided");
	});

	/** Off-screen here is the same as absent: it is the only way out of a blocking dialog. */
	it("keeps the cancel confirmation inside the pinned bar", () => {
		render([conflict(1, "edit-edit")]);
		// Tapped rather than calling `requestCancel()`: a bare method call mutates state outside
		// change detection, which the dev-mode verification pass reports as NG0100. Going through
		// the button is also what the assertion is actually about.
		cancelButton().click();
		fixture.detectChanges();

		const confirm = host().querySelector(".confirm");
		expect(confirm).not.toBeNull();
		expect(confirm!.closest(".prompt-actions")).not.toBeNull();
	});

	it("disables the footer Cancel only once the confirmation is up beside it", () => {
		render([conflict(1, "edit-edit")]);
		expect(cancelButton().disabled).toBe(false);

		cancelButton().click();
		fixture.detectChanges();

		expect(cancelButton().disabled).toBe(true);
		expect(host().querySelector(".confirm")).not.toBeNull();
	});

	it("explains why a bulk tap left cards open", () => {
		render([conflict(1, "id-collision"), conflict(2, "edit-edit")]);
		host().querySelectorAll<HTMLButtonElement>(".bulk button")[1].click();
		fixture.detectChanges();

		expect(host().querySelector(".bulk-note")!.textContent).toContain("1 card left open");
		expect(cards()[0].classList).toContain("undecided");
		expect(cards()[1].classList).not.toContain("undecided");
	});
});

/**
 * The two cases `chooseAll` refuses, and the note that explains them.
 *
 * Both are shapes where one bulk tap destroys something the user never looked at: an id
 * collision, where the sides may not be versions of each other at all, and a per-file list one
 * device removed, where the PWA cannot even render what would go. Leaving them open costs a
 * duplicate or a deferral; answering them costs an item, with no review record, because a
 * decided conflict is filtered out of `captureTodoConflicts`/`captureFileConflicts`.
 */
describe("ConflictPromptComponent bulk safety", () => {
	const filePath = "src/a.ts";

	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	const collision = (id: number): ConflictSet => ({
		todoId: id,
		base: null,
		local: todo(id, `local ${id}`),
		remote: todo(id, `remote ${id}`),
		conflictType: "id-collision",
	});

	/** Edited here, the whole list removed on the other device. */
	const removedThere = (): FileConflictSet => ({
		filePath,
		base: [todo(10, "orig")],
		local: [todo(10, "renamed here")],
		remote: null,
		conflictType: "file-edit-delete",
	});

	/** Two versions of the list, both present: safe to pick a side for. */
	const bothPresent = (): FileConflictSet => {
		const base = [todo(10, "orig")];
		const local = [todo(10, "renamed here"), todo(12, "added here")];
		const remote = [todo(10, "renamed there"), todo(13, "added there")];
		return mergeFilesData({ [filePath]: base }, { [filePath]: local }, { [filePath]: remote })
			.conflicts[0];
	};

	let component: ConflictPromptComponent;

	function mount(todos: ConflictSet[], files: FileConflictSet[] = []): void {
		component = new ConflictPromptComponent();
		component.request = { todos, files, knownIds: todos.map((c) => c.todoId) };
	}

	function decisions(): ConflictDecisions {
		let emitted = false;
		let captured: ConflictDecisions | null = null;
		component.decided.subscribe((value) => {
			emitted = true;
			captured = value;
		});
		component.apply();
		// Throwing rather than defaulting: `toBeUndefined()` on a field of `{}` would pass just
		// as well if `apply()` stopped emitting at all.
		if (!emitted) {
			throw new Error("apply() emitted nothing");
		}
		if (captured === null) {
			throw new Error("expected decisions, got a cancel");
		}
		return captured as unknown as ConflictDecisions;
	}

	it("answers a file conflict where both devices still have the list", () => {
		mount([], [bothPresent()]);
		component.chooseAll("remote");

		expect(
			decisions()
				.files?.get(filePath)
				?.map((t) => t.text)
		).toContain("renamed there");
		expect(component.bulkSkipped).toBe(0);
	});

	/**
	 * "Use this device for all" here resolves to `null`, which the engine reads as "accept the
	 * deletion" and drops the path. Nothing records it, and the PWA has no screen that shows
	 * per-file lists, so the user could not find out.
	 */
	it("refuses a file conflict where one device removed the list", () => {
		mount([], [removedThere()]);
		component.chooseAll("remote");

		expect(decisions().files).toBeUndefined();
		expect(component.bulkSkipped).toBe(1);
	});

	it("still answers the safe file conflicts alongside a removal", () => {
		mount([], [removedThere(), bothPresent()]);
		// Two entries under one path would collide, so the safe one is re-pathed.
		component.request.files[1] = { ...component.request.files[1], filePath: "src/b.ts" };
		component.chooseAll("local");

		expect([...(decisions().files?.keys() ?? [])]).toEqual(["src/b.ts"]);
	});

	it("does not count a card the user already answered as left open", () => {
		mount([collision(1), collision(2)]);
		component.chooseTodo(1, "keep-both");
		component.chooseAll("remote");

		// Only todo 2 is still open; todo 1 shows a choice and must not be reported as skipped.
		expect(component.bulkSkipped).toBe(1);
		expect(component.todoChoice(1)).toBe("keep-both");
	});

	it("leaves an answered collision answered when a bulk tap runs afterwards", () => {
		mount([collision(1)]);
		component.chooseTodo(1, "remote");
		component.chooseAll("local");

		expect(decisions().todos?.get(1)?.text).toBe("remote 1");
	});
});

/**
 * Which side of a file conflict removed the list.
 *
 * Easy to invert, and inverting it puts the wrong sentence on the card: `file-edit-delete` is
 * edited HERE and removed THERE, so this device's list survives; `file-delete-edit` is the
 * mirror, where the removal is this device's and prefer-local makes it stand. Only the latter
 * should say so.
 */
describe("ConflictPromptComponent file removal copy", () => {
	const filePath = "src/a.ts";

	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	function mount(conflict: FileConflictSet): ConflictPromptComponent {
		const component = new ConflictPromptComponent();
		component.request = { todos: [], files: [conflict], knownIds: [] };
		return component;
	}

	const list = [todo(10, "still here")];

	it("says the removal is this device's when this device deleted the list", () => {
		const component = mount({
			filePath,
			base: list,
			local: null,
			remote: [todo(10, "changed there")],
			conflictType: "file-delete-edit",
		});

		expect(component.fileRemovedHere(component.fileConflicts[0])).toBe(true);
	});

	it("does not, when the other device is the one that deleted it", () => {
		const component = mount({
			filePath,
			base: list,
			local: [todo(10, "changed here")],
			remote: null,
			conflictType: "file-edit-delete",
		});

		expect(component.fileRemovedHere(component.fileConflicts[0])).toBe(false);
	});

	/**
	 * An empty list is not a removal. Emptied here and changed there, this device's side
	 * resolves to `[]`, which the engine keeps — only `null` deletes the path — so the card must
	 * not claim a removal.
	 *
	 * Built by the real merge: a literal has no `itemMerge`, which sends `resolveFileConflict`
	 * down its shortcut and would test the wrong branch. (Emptied on *both* sides produces no
	 * conflict at all, so that card cannot exist.)
	 */
	it("does not treat an emptied list as a removal", () => {
		const conflict = mergeFilesData(
			{ [filePath]: list },
			{ [filePath]: [] },
			{ [filePath]: [todo(10, "changed there")] }
		).conflicts[0];
		const component = mount(conflict);

		expect(conflict.conflictType).toBe("file-edit-edit");
		expect(component.fileSide(conflict, "local")).toEqual([]);
		expect(component.fileRemovedHere(conflict)).toBe(false);
	});
});

/**
 * Collisions one level down, inside a per-file list.
 *
 * `canBulkAnswerFile` originally asked only "does either side delete the whole list", which
 * missed this: the two sides can both be present and still hold todos that were created
 * independently on each device and merely drew the same id. Picking a side then destroys one,
 * and because a decided file conflict is filtered out of `captureFileConflicts` there is no
 * review record to undo it from — the top-level hole `chooseAll` already closed, still open in
 * the files.
 *
 * `file-added-both` is the case that makes it common rather than exotic: its item merge runs
 * against an empty base, and against an empty base the merge can only produce collisions.
 *
 * There is no keep-both here. `ConflictDecisions.files` is a whole `Todo[]`, so leaving the
 * card undecided — which records both resolutions — is the only way to keep both sides.
 */
describe("ConflictPromptComponent in-file collisions", () => {
	const filePath = "src/a.ts";

	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	/** Both devices started this file independently, drawing the same id. */
	const addedBoth = (): FileConflictSet =>
		mergeFilesData(
			{},
			{ [filePath]: [todo(5, "written here")] },
			{ [filePath]: [todo(5, "written there")] }
		).conflicts[0];

	/** One ordinary edit, plus an independently created item on each side sharing an id. */
	const editedWithCollision = (): FileConflictSet =>
		mergeFilesData(
			{ [filePath]: [todo(9, "base")] },
			{ [filePath]: [todo(9, "edited here"), todo(7, "mine")] },
			{ [filePath]: [todo(9, "edited there"), todo(7, "theirs")] }
		).conflicts[0];

	/** Both additions are one-sided, so nothing inside collides. */
	const editedCleanly = (): FileConflictSet =>
		mergeFilesData(
			{ [filePath]: [todo(9, "base")] },
			{ [filePath]: [todo(9, "edited here"), todo(12, "mine")] },
			{ [filePath]: [todo(9, "edited there"), todo(13, "theirs")] }
		).conflicts[0];

	function mount(conflict: FileConflictSet): ConflictPromptComponent {
		const component = new ConflictPromptComponent();
		component.request = { todos: [], files: [conflict], knownIds: [] };
		return component;
	}

	function filesDecided(component: ConflictPromptComponent): string[] {
		let captured: ConflictDecisions | null = null;
		component.decided.subscribe((value) => (captured = value));
		component.apply();
		if (captured === null) {
			throw new Error("expected decisions, got a cancel");
		}
		return [...((captured as unknown as ConflictDecisions).files?.keys() ?? [])];
	}

	it("sees the collision a file-added-both always carries", () => {
		const conflict = addedBoth();

		expect(conflict.conflictType).toBe("file-added-both");
		expect(mount(conflict).fileHasCollision(conflict)).toBe(true);
	});

	it("sees one mixed in among ordinary edits", () => {
		const conflict = editedWithCollision();

		expect(mount(conflict).fileHasCollision(conflict)).toBe(true);
	});

	it("does not see one where both additions are one-sided", () => {
		const conflict = editedCleanly();

		expect(mount(conflict).fileHasCollision(conflict)).toBe(false);
	});

	/**
	 * The regression itself: without the guard this answers the card, and the other device's
	 * "written there" is dropped with nothing recorded.
	 */
	it("refuses to bulk-answer a file holding an in-file collision", () => {
		const component = mount(addedBoth());
		component.chooseAll("local");

		expect(filesDecided(component)).toEqual([]);
		expect(component.bulkSkipped).toBe(1);
	});

	it("refuses one where the collision is mixed in with a normal edit", () => {
		const component = mount(editedWithCollision());
		component.chooseAll("remote");

		expect(filesDecided(component)).toEqual([]);
	});

	it("still bulk-answers a file whose items do not collide", () => {
		const component = mount(editedCleanly());
		component.chooseAll("remote");

		expect(filesDecided(component)).toEqual([filePath]);
		expect(component.bulkSkipped).toBe(0);
	});

	/** Per card the choice is still offered: the user is looking at it, and the note warns. */
	it("still allows the choice on the card itself", () => {
		const component = mount(addedBoth());
		component.chooseFile(filePath, "remote");

		expect(filesDecided(component)).toEqual([filePath]);
	});
});

/**
 * The file half of the template, which nothing else renders.
 *
 * Its copy has been wrong twice: it told a user "this device's list is kept" on the card where
 * this device is the side that removed it, and it reassured them that "either choice keeps
 * every item the other device added" on a card where choosing discards an independently
 * created one. Both were caught by reading, which is not a control.
 */
describe("ConflictPromptComponent file card rendering", () => {
	const filePath = "src/a.ts";

	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	/** Started on both devices with the same id: every item is a collision. */
	const addedBoth = (): FileConflictSet =>
		mergeFilesData(
			{},
			{ [filePath]: [todo(5, "written here")] },
			{ [filePath]: [todo(5, "written there")] }
		).conflicts[0];

	/** Two-sided edit whose additions are one-sided, so nothing inside collides. */
	const editedCleanly = (): FileConflictSet =>
		mergeFilesData(
			{ [filePath]: [todo(9, "base")] },
			{ [filePath]: [todo(9, "edited here"), todo(12, "mine")] },
			{ [filePath]: [todo(9, "edited there"), todo(13, "theirs")] }
		).conflicts[0];

	/** Removed here, changed there: prefer-local makes the removal stand. */
	const removedHere = (): FileConflictSet => ({
		filePath,
		base: [todo(9, "base")],
		local: null,
		remote: [todo(9, "changed there")],
		conflictType: "file-delete-edit",
	});

	let fixture: ComponentFixture<ConflictPromptComponent>;

	function render(conflict: FileConflictSet): void {
		fixture = TestBed.createComponent(ConflictPromptComponent);
		fixture.componentInstance.request = { todos: [], files: [conflict], knownIds: [] };
		fixture.detectChanges();
	}

	function card(): HTMLElement {
		return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".card")!;
	}

	function noteText(): string {
		return card().querySelector(".note")!.textContent!.replace(/\s+/g, " ").trim();
	}

	function pendingText(): string {
		return card().querySelector(".pending")!.textContent!.replace(/\s+/g, " ").trim();
	}

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			declarations: [ConflictPromptComponent],
		}).compileComponents();
	});

	/**
	 * Both sides show 3, not 2: a side is the *resolution*, not that device's raw array, so each
	 * already carries the disputed item in one version plus both devices' one-sided additions.
	 * Equal counts here are the visible form of "neither choice discards the other device's
	 * additions" — the property `resolveFileConflict` exists to provide.
	 */
	it("renders the path, and a count per side that keeps both devices' additions", () => {
		render(editedCleanly());

		expect(card().querySelector(".chip")!.textContent).toContain(filePath);
		const sides = card().querySelectorAll(".side .side-meta");
		expect(sides[0].textContent).toContain("3 items");
		expect(sides[1].textContent).toContain("3 items");
	});

	it("shows a removed side as Removed rather than a count", () => {
		render(removedHere());

		expect(card().querySelectorAll(".side .side-meta")[0].textContent).toContain("Removed");
	});

	/**
	 * The hedge matters: "no shared history" is also what a cold cache produces for a file both
	 * devices genuinely hold, so the card must not assert these are unrelated items.
	 */
	it("warns without asserting, on a file whose items collide", () => {
		render(addedBoth());

		expect(noteText()).toContain("no shared history");
		expect(noteText()).toContain("can discard a real item");
		expect(noteText()).not.toContain("this is not two versions");
	});

	/**
	 * A warning with no way forward is half a message. The route offered is reversibility, not
	 * preservation: leaving the card open still applies prefer-local and still drops the other
	 * side's colliding items, but it files both resolutions, so the choice can be taken back.
	 */
	it("offers the reversible route rather than only naming the risk", () => {
		render(addedBoth());

		expect(noteText()).toContain("take the other side later");
		// And does not promise the undecided outcome keeps both, which it does not.
		expect(noteText()).not.toContain("both are kept");
	});

	it("reassures only where the reassurance is true", () => {
		render(editedCleanly());

		expect(noteText()).toContain("keeps every item the other device added");
	});

	it("does not reassure on a colliding file", () => {
		render(addedBoth());

		expect(noteText()).not.toContain("keeps every item the other device added");
	});

	it("says the removal stands when this device is the one that removed the list", () => {
		render(removedHere());

		expect(pendingText()).toContain("this device removed the list");
	});

	it("says the list is kept when this device still has one", () => {
		render(editedCleanly());

		expect(pendingText()).toContain("this device's list is kept");
	});
});
