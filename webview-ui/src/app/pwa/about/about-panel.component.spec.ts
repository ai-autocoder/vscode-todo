import { A11yModule } from "@angular/cdk/a11y";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { version } from "../../../../../package.json";
import { AboutPanelComponent } from "./about-panel.component";
import { ATTRIBUTION } from "./attribution";

describe("AboutPanelComponent", () => {
	let fixture: ComponentFixture<AboutPanelComponent>;
	let closed: jasmine.Spy;
	/** Stands in for the header's menu button, which has focus when the panel opens. */
	let opener: HTMLButtonElement;

	const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
	const links = (): HTMLAnchorElement[] => Array.from(host().querySelectorAll("a"));
	const panel = (): HTMLElement => host().querySelector(".about-panel")!;
	const backdrop = (): HTMLElement => host().querySelector(".about-backdrop")!;

	beforeEach(async () => {
		opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();

		await TestBed.configureTestingModule({
			declarations: [AboutPanelComponent],
			imports: [A11yModule],
		}).compileComponents();
		fixture = TestBed.createComponent(AboutPanelComponent);
		closed = jasmine.createSpy("closed");
		fixture.componentInstance.closed.subscribe(closed);
		fixture.detectChanges();
		// The focus trap moves focus after the first render.
		await fixture.whenStable();
	});

	afterEach(() => {
		opener.remove();
	});

	it("should show the released version, not the webview package's placeholder", () => {
		expect(version).not.toBe("0.0.1");
		expect(host().querySelector(".version")?.textContent).toContain(version);
	});

	it("should link the author, the source, issues and the licence", () => {
		const hrefs = links().map((link) => link.href);
		expect(hrefs).toContain(`${ATTRIBUTION.authorUrl}/`);
		expect(hrefs).toContain(ATTRIBUTION.sourceUrl);
		expect(hrefs).toContain(ATTRIBUTION.issuesUrl);
		expect(hrefs).toContain(ATTRIBUTION.licenseUrl);
	});

	it("should open every link in a new tab without dropping the referrer", () => {
		for (const link of links()) {
			expect(link.target).toBe("_blank");
			expect(link.rel).toBe("noopener");
		}
	});

	it("should say where the lists sync to, and that there are no analytics", () => {
		const text = host().querySelector(".privacy")?.textContent ?? "";
		expect(text).toContain("directly between this device and your GitHub gist");
		expect(text).toContain("No analytics");
	});

	it("should label the dialog by its title", () => {
		const dialog = host().querySelector('[role="dialog"]')!;
		const title = host().querySelector(`#${dialog.getAttribute("aria-labelledby")}`);
		expect(title?.textContent).toContain(ATTRIBUTION.appName);
	});

	it("should move focus to the heading when it opens, so a tall panel opens at its top", () => {
		expect(document.activeElement).toBe(host().querySelector("h2"));
	});

	it("should keep Tab inside the panel", () => {
		// The trap's end anchor is what Tab reaches after the last control; it hands focus back to
		// the first link instead of letting it leave for the app behind the scrim.
		const anchors = host().querySelectorAll<HTMLElement>(".cdk-focus-trap-anchor");
		expect(anchors.length).toBe(2);
		anchors[1].focus();
		expect(document.activeElement).toBe(links()[0]);
	});

	it("should hand focus back to where it was when it closes", () => {
		fixture.destroy();
		expect(document.activeElement).toBe(opener);
	});

	it("should close on Escape inside the panel without letting the key reach the document", () => {
		const documentListener = jasmine.createSpy("documentListener");
		document.addEventListener("keydown", documentListener);
		try {
			panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		} finally {
			document.removeEventListener("keydown", documentListener);
		}
		expect(closed).toHaveBeenCalledTimes(1);
		expect(documentListener).not.toHaveBeenCalled();
	});

	it("should ignore an Escape that is not inside the panel", () => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(closed).not.toHaveBeenCalled();
	});

	it("should close on a click on the backdrop", () => {
		backdrop().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		backdrop().click();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("should stay open for a click inside the panel", () => {
		panel().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		panel().click();
		expect(closed).not.toHaveBeenCalled();
	});

	it("should stay open when a drag starts inside the panel and ends on the backdrop", () => {
		// The browser fires such a click on the common ancestor, which is the backdrop.
		const version = host().querySelector(".version")!;
		version.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		backdrop().click();
		expect(closed).not.toHaveBeenCalled();
	});
});
