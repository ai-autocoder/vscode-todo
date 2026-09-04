import { ChangeDetectorRef } from "@angular/core";
import { AppComponent } from "./app.component";
import { TodoService } from "./todo/todo.service";
import { environment } from "../environments/environment";

/**
 * Pinning stops the File list following the active editor. The standalone PWA has no editor,
 * so `pinFile()` is a no-op there and the control is hidden — see `isFilePinSupported`.
 *
 * Rendering `AppComponent` would pull in `AngularSplitModule` (for the `ViewChild("mySplit")`
 * that `ngAfterViewInit` dereferences), `FileNamePipe` and `CommonModule`'s pipes — a large
 * harness for one flag. The constructor only stores its two dependencies, so instantiate it
 * directly instead: that still catches the failure that matters, an inverted initializer
 * (`environment.pwa` instead of `!environment.pwa`) hiding the pin from the *extension*
 * webview, which no build or lint run would flag.
 *
 * Whether the `@if` actually removes the button from the DOM is left to the manual pass; this
 * asserts the flag it reads, not the template.
 */
describe("AppComponent file pin support", () => {
	function create(): AppComponent {
		return new AppComponent({} as TodoService, {} as ChangeDetectorRef);
	}

	it("derives the flag from the build target", () => {
		expect(create().isFilePinSupported).toBe(!environment.pwa);
	});

	it("supports pinning in the extension webview, where an editor exists", () => {
		// Guards the polarity in the direction the shared build cares about: this spec suite
		// runs against `environment.ts` (`pwa: false`), i.e. the extension webview.
		expect(environment.pwa).toBe(false);
		expect(create().isFilePinSupported).toBe(true);
	});
});
