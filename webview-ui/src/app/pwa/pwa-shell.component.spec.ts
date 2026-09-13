import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { BehaviorSubject, Subject } from "rxjs";
import type { GistFileInfo } from "@vsc-todo/core";
import { DATA_GATEWAY } from "../data/data-gateway";
import { GistConnectionState, GistGateway } from "../data/gist-gateway";
import { PwaShellComponent } from "./pwa-shell.component";

const gistFile = (fullPath: string): GistFileInfo => ({
	displayName: fullPath,
	fullPath,
	size: 128,
});

/**
 * A stand-in for the gateway that satisfies the shell's `instanceof GistGateway` guard without
 * touching IndexedDB or the network: only the members the connection flow reads are defined,
 * over a real prototype so the guard passes.
 */
function fakeGateway(connection: BehaviorSubject<GistConnectionState>, chooseFiles: jasmine.Spy) {
	const gateway = Object.create(GistGateway.prototype) as GistGateway;
	Object.assign(gateway, {
		connection,
		messages: new Subject(),
		conflicts: new BehaviorSubject([]),
		conflictPrompt: new BehaviorSubject(null),
		answerConflictPrompt: () => undefined,
		syncFailure: new BehaviorSubject({ phase: "ok" }),
		importExport: new BehaviorSubject({ phase: "idle" }),
		restoreSession: () => Promise.resolve(connection.value),
		chooseFiles,
	});
	// Prototype getters can't be assigned over, only shadowed.
	for (const [name, value] of Object.entries({
		currentGistId: "0123456789abcdef0123456789abcdef",
		currentUserFile: undefined,
		currentWorkspaceFile: undefined,
		canCancelFileSelection: false,
	})) {
		Object.defineProperty(gateway, name, { value });
	}
	return gateway;
}

describe("PwaShellComponent — naming a new list", () => {
	let fixture: ComponentFixture<PwaShellComponent>;
	let component: PwaShellComponent;
	let connection: BehaviorSubject<GistConnectionState>;
	let chooseFiles: jasmine.Spy;

	const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
	const text = (): string => host().textContent ?? "";
	const selects = (): HTMLSelectElement[] => Array.from(host().querySelectorAll("select"));
	const nameFields = (): HTMLInputElement[] =>
		Array.from(host().querySelectorAll(".new-file input"));

	/** Everything the tests do goes through the DOM, as a user would, so ngModel stays in step. */
	const settle = async (): Promise<void> => {
		await fixture.whenStable();
		fixture.detectChanges();
	};

	const pick = async (select: HTMLSelectElement, value: string): Promise<void> => {
		select.value = value;
		select.dispatchEvent(new Event("change"));
		await settle();
	};

	const typeName = async (field: HTMLInputElement, value: string): Promise<void> => {
		field.value = value;
		field.dispatchEvent(new Event("input"));
		await settle();
	};

	const clickOk = async (): Promise<void> => {
		const ok = Array.from(host().querySelectorAll("button")).find((button) =>
			(button.textContent ?? "").includes("Ok")
		);
		ok!.click();
		await settle();
	};

	/** Enters the picker with one existing user list and no workspace list. */
	const enterPicker = async (): Promise<void> => {
		connection.next({
			phase: "needs-files",
			userFiles: [gistFile("user-todos.json")],
			workspaceFiles: [],
		});
		await settle();
	};

	/** Switches the user list to "New file…" and returns its name field. */
	const newUserFile = async (): Promise<HTMLInputElement> => {
		await pick(selects()[0], component.newUserFileValue);
		return nameFields()[0];
	};

	beforeEach(async () => {
		connection = new BehaviorSubject<GistConnectionState>({ phase: "disconnected" });
		chooseFiles = jasmine.createSpy("chooseFiles").and.resolveTo(undefined);

		await TestBed.configureTestingModule({
			declarations: [PwaShellComponent],
			imports: [CommonModule, FormsModule],
			providers: [{ provide: DATA_GATEWAY, useValue: fakeGateway(connection, chooseFiles) }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(PwaShellComponent);
		component = fixture.componentInstance;
		fixture.detectChanges();
		await settle();
	});

	it("should offer an editable name only once New file is chosen", async () => {
		await enterPicker();
		// The workspace list has no existing file to fall back on, so its field already shows.
		expect(nameFields().length).toBe(1);

		await newUserFile();
		expect(nameFields().length).toBe(2);
	});

	it("should prefill the name with the default the picker used to impose", async () => {
		await enterPicker();
		expect((await newUserFile()).value).toBe("todos");
		expect(component.newWorkspaceFileName).toBe("default");
	});

	it("should create the file the user named, keeping the prefix and suffix", async () => {
		await enterPicker();
		await typeName(await newUserFile(), "shopping");
		await typeName(nameFields()[1], "home");
		await clickOk();
		expect(chooseFiles).toHaveBeenCalledWith("user-shopping.json", "workspace-home.json");
	});

	it("should not double up the affixes when a whole file name is pasted in", async () => {
		await enterPicker();
		await typeName(await newUserFile(), "user-shopping.json");
		await clickOk();
		expect(chooseFiles).toHaveBeenCalledWith("user-shopping.json", "workspace-default.json");
	});

	it("should refuse an empty name rather than fall back to a default", async () => {
		await enterPicker();
		await typeName(await newUserFile(), "   ");
		await clickOk();
		expect(chooseFiles).not.toHaveBeenCalled();
		expect(text()).toContain("Enter a name for the new user list");
	});

	it("should refuse characters GitHub would not accept in a file name", async () => {
		await enterPicker();
		await typeName(await newUserFile(), "home/shopping");
		await clickOk();
		expect(chooseFiles).not.toHaveBeenCalled();
		expect(text()).toContain("cannot contain");
	});

	it("should point at the list instead of silently adopting an existing file", async () => {
		await enterPicker();
		await typeName(await newUserFile(), "Todos");
		await clickOk();
		expect(chooseFiles).not.toHaveBeenCalled();
		expect(text()).toContain("already exists");
	});

	it("should still pass an existing selection through untouched", async () => {
		await enterPicker();
		await typeName(nameFields()[0], "home");
		await clickOk();
		expect(chooseFiles).toHaveBeenCalledWith("user-todos.json", "workspace-home.json");
	});
});

/**
 * A gist file core refuses to read is the one sync failure the app cannot recover from on its
 * own: retrying re-reads the same bytes, and the fix is a person restoring the file from the
 * gist's revision history. The banner has to say so and lead there.
 */
describe("PwaShellComponent — a damaged gist file", () => {
	let fixture: ComponentFixture<PwaShellComponent>;
	let syncFailure: BehaviorSubject<unknown>;

	const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
	const banner = (): HTMLElement | null => host().querySelector(".sync-failure");
	const links = (): HTMLAnchorElement[] =>
		Array.from(host().querySelectorAll(".sync-failure-actions a"));
	const buttons = (): HTMLButtonElement[] =>
		Array.from(host().querySelectorAll(".sync-failure-actions button"));

	beforeEach(async () => {
		const connection = new BehaviorSubject<GistConnectionState>({ phase: "disconnected" });
		const gateway = fakeGateway(connection, jasmine.createSpy("chooseFiles"));
		syncFailure = (gateway as unknown as { syncFailure: BehaviorSubject<unknown> }).syncFailure;

		await TestBed.configureTestingModule({
			declarations: [PwaShellComponent],
			imports: [CommonModule, FormsModule],
			providers: [{ provide: DATA_GATEWAY, useValue: gateway }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA],
		}).compileComponents();

		fixture = TestBed.createComponent(PwaShellComponent);
		fixture.detectChanges();
		await fixture.whenStable();
	});

	it("shows the failure and links to the gist's revisions, with no retry offered", () => {
		syncFailure.next({
			phase: "failing",
			kind: "data",
			message: "Could not read user-todos.json from the gist: it is not valid JSON.",
			canRetry: false,
		});
		fixture.detectChanges();

		expect(banner()?.textContent).toContain("user-todos.json");
		expect(links().length).toBe(1);
		expect(links()[0].href).toBe(
			"https://gist.github.com/0123456789abcdef0123456789abcdef/revisions"
		);
		// "Try again" would re-read the same bytes; "Reconnect" and "Choose a gist" are the wrong
		// diagnosis and would send the user off to change a setting that is not the problem.
		expect(buttons().length).toBe(0);
	});
});
