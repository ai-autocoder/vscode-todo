import { Component, EventEmitter, Output } from "@angular/core";
import { ATTRIBUTION } from "./attribution";

/**
 * What the app is, who made it and where its source lives. Opened from the header menu.
 *
 * Unlike the conflict prompt this blocks nothing, so Escape and a click on the backdrop both
 * close it. Focus is trapped inside while it is open and returns to where it was on close (the
 * menu button, since the header opens it once the menu has closed). On open, focus goes to the
 * heading rather than Close, so a panel taller than a landscape phone opens at its top instead
 * of scrolled down to its last button.
 *
 * PWA-only.
 */
@Component({
	selector: "app-about-panel",
	templateUrl: "./about-panel.component.html",
	styleUrls: ["./about-panel.component.css"],
	standalone: false,
})
export class AboutPanelComponent {
	@Output() closed = new EventEmitter<void>();

	readonly info = ATTRIBUTION;

	/**
	 * Whether the current press began on the backdrop. A drag that starts inside the panel and
	 * ends outside it, such as selecting the version text, fires its click on the backdrop, their
	 * common ancestor. Only a press that both starts and ends there closes the panel.
	 */
	private pressStartedOnBackdrop = false;

	close(): void {
		this.closed.emit();
	}

	/**
	 * Bound on the panel, not the document, and stopped here: the todo list also listens for
	 * Escape on the document, and clears its selection when it hears one.
	 */
	onEscape(event: Event): void {
		event.stopPropagation();
		this.close();
	}

	onBackdropPointerDown(event: PointerEvent): void {
		this.pressStartedOnBackdrop = event.target === event.currentTarget;
	}

	onBackdropClick(event: MouseEvent): void {
		if (this.pressStartedOnBackdrop && event.target === event.currentTarget) {
			this.close();
		}
		this.pressStartedOnBackdrop = false;
	}
}
