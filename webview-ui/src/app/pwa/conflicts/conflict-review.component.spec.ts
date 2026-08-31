import { ComponentFixture, TestBed } from "@angular/core/testing";
import type { Todo } from "@vsc-todo/core";
import type { GistGateway } from "../../data/gist-gateway";
import { ConflictReviewComponent } from "./conflict-review.component";
import type { ConflictApplyResult, PendingConflictView } from "./conflict-types";

const todo = (overrides: Partial<Todo> = {}): Todo => ({
	id: 1,
	text: "Buy milk",
	completed: false,
	creationDate: "2026-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...overrides,
});

const editEdit: PendingConflictView = {
	stale: false,
	conflict: {
		kind: "todo",
		key: "user:1",
		scope: "user",
		todoId: 1,
		conflictType: "edit-edit",
		base: todo(),
		local: todo({ text: "milk from the corner shop" }),
		remote: todo({ text: "oat milk", completed: true }),
		resolvedValue: todo({ text: "milk from the corner shop" }),
		syncedAt: "2026-01-02T00:00:00.000Z",
	},
};

const keptBoth: PendingConflictView = {
	stale: false,
	conflict: {
		kind: "kept-both",
		key: "user:2",
		scope: "user",
		todoId: 2,
		local: todo({ id: 2, text: "call the dentist" }),
		remote: todo({ id: 2, text: "renew the passport" }),
		newId: 777,
		syncedAt: "2026-01-02T00:00:00.000Z",
	},
};

const fileConflict: PendingConflictView = {
	stale: false,
	conflict: {
		kind: "file",
		key: "file:src/app.ts",
		filePath: "src/app.ts",
		conflictType: "file-edit-edit",
		base: [],
		local: [todo({ id: 10, text: "refactor" })],
		remote: [todo({ id: 11, text: "add tests" }), todo({ id: 12, text: "drop the shim" })],
		resolvedValue: [todo({ id: 10, text: "refactor" })],
		syncedAt: "2026-01-02T00:00:00.000Z",
	},
};

describe("ConflictReviewComponent", () => {
	let fixture: ComponentFixture<ConflictReviewComponent>;
	let component: ConflictReviewComponent;
	let gateway: jasmine.SpyObj<GistGateway>;

	const text = (): string => (fixture.nativeElement as HTMLElement).textContent ?? "";
	const cards = (): NodeListOf<Element> =>
		(fixture.nativeElement as HTMLElement).querySelectorAll(".card");
	const buttonWith = (
		label: string,
		root: ParentNode = fixture.nativeElement
	): HTMLButtonElement => {
		const match = Array.from(root.querySelectorAll("button")).find((button) =>
			(button.textContent ?? "").includes(label)
		);
		if (!match) {
			throw new Error(`No button labelled "${label}"`);
		}
		return match as HTMLButtonElement;
	};

	beforeEach(async () => {
		gateway = jasmine.createSpyObj<GistGateway>("GistGateway", [
			"applyConflictChoice",
			"undoKeptBoth",
			"dismissConflict",
			"dismissAllConflicts",
			"keepAllFromOtherDevice",
		]);
		gateway.applyConflictChoice.and.resolveTo("applied" as ConflictApplyResult);
		gateway.undoKeptBoth.and.resolveTo("applied" as ConflictApplyResult);
		gateway.keepAllFromOtherDevice.and.resolveTo({ applied: 2, skipped: 1 });

		await TestBed.configureTestingModule({
			declarations: [ConflictReviewComponent],
		}).compileComponents();

		fixture = TestBed.createComponent(ConflictReviewComponent);
		component = fixture.componentInstance;
		component.gateway = gateway;
		component.views = [editEdit, keptBoth, fileConflict];
		fixture.detectChanges();
	});

	it("should render one card per pending conflict", () => {
		expect(cards().length).toBe(3);
	});

	it("should show both versions of a todo edited on both devices", () => {
		expect(text()).toContain("Edited on both devices");
		expect(text()).toContain("milk from the corner shop");
		expect(text()).toContain("oat milk");
	});

	it("should offer a per-field merge only on the edit-edit card", () => {
		const mergeButtons = Array.from(
			(fixture.nativeElement as HTMLElement).querySelectorAll("button")
		).filter((button) => (button.textContent ?? "").includes("Merge fields"));
		expect(mergeButtons.length).toBe(1);
	});

	it("should apply the other device's version when asked", async () => {
		buttonWith("Use other device", cards()[0]).click();
		await fixture.whenStable();
		expect(gateway.applyConflictChoice).toHaveBeenCalledWith("user:1", undefined);
	});

	it("should only dismiss the record when this device's version is kept", () => {
		buttonWith("Keep this device", cards()[0]).click();
		expect(gateway.dismissConflict).toHaveBeenCalledWith("user:1");
		expect(gateway.applyConflictChoice).not.toHaveBeenCalled();
	});

	it("should list only the differing fields in the merge expander", () => {
		buttonWith("Merge fields", cards()[0]).click();
		fixture.detectChanges();
		const labels = Array.from(
			(fixture.nativeElement as HTMLElement).querySelectorAll(".merge-label")
		).map((label) => label.textContent?.trim());
		expect(labels).toEqual(["Text", "Status"]);
	});

	it("should send a merged todo built from the chosen sides", async () => {
		buttonWith("Merge fields", cards()[0]).click();
		fixture.detectChanges();
		// Take the other device's status, keep this device's text.
		component.pick("user:1", "completed", "remote");
		buttonWith("Apply merge", cards()[0]).click();
		await fixture.whenStable();

		const [key, merged] = gateway.applyConflictChoice.calls.mostRecent().args;
		expect(key).toBe("user:1");
		expect(merged?.text).toBe("milk from the corner shop");
		expect(merged?.completed).toBeTrue();
	});

	it("should ask for confirmation before overwriting an item edited since the sync", async () => {
		gateway.applyConflictChoice.and.resolveTo("stale" as ConflictApplyResult);
		buttonWith("Use other device", cards()[0]).click();
		await fixture.whenStable();
		fixture.detectChanges();

		expect(text()).toContain("will overwrite that change");

		gateway.applyConflictChoice.and.resolveTo("applied" as ConflictApplyResult);
		buttonWith("Overwrite anyway", cards()[0]).click();
		await fixture.whenStable();
		expect(gateway.applyConflictChoice).toHaveBeenCalledWith("user:1", undefined, true);
	});

	it("should present an id collision as two kept items with an undo", async () => {
		expect(text()).toContain("Two different items with the same id");
		buttonWith("Remove the added copy", cards()[1]).click();
		await fixture.whenStable();
		expect(gateway.undoKeptBoth).toHaveBeenCalledWith("user:2");
	});

	it("should show a file conflict as two whole lists, previewable on demand", () => {
		expect(text()).toContain("src/app.ts");
		expect(text()).toContain("1 item");
		expect(text()).toContain("2 items");
		expect(text()).not.toContain("add tests");

		buttonWith("Show items", cards()[2]).click();
		fixture.detectChanges();
		expect(text()).toContain("add tests");
	});

	it("should not offer a per-field merge on a file conflict", () => {
		expect(component.canMerge(fileConflict)).toBeFalse();
	});

	it("should report how many a bulk switch skipped as needing review", async () => {
		buttonWith("Use other device for all").click();
		await fixture.whenStable();
		fixture.detectChanges();
		expect(text()).toContain("1 changed on this device since the sync");
	});
});
