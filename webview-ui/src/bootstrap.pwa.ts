import { provideZoneChangeDetection } from "@angular/core";
import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";
import { PwaAppModule } from "./app/pwa/pwa-app.module";

/**
 * Samsung Internet paints its collapsed address bar *over* the bottom of the layout viewport
 * while the soft keyboard is open, leaving the composer partly behind it. Nothing measurable
 * exposes the strip: `innerHeight`, `visualViewport` and `env(safe-area-inset-bottom)` all
 * describe the region it covers (0px there, where Chrome reports 16px), so the page's own
 * metrics report the composer fully visible. Measured at ~16px on Samsung Internet 30.
 *
 * A UA class is the only handle the page gets. The inset it enables lives in
 * pwa/vscode-theme.css and applies only while a field is focused, since at rest Samsung
 * excludes its full toolbar from the viewport correctly and no extra padding is wanted.
 */
function flagSamsungInternet(): void {
	if (/SamsungBrowser/.test(navigator.userAgent)) {
		document.documentElement.classList.add("samsung-internet");
	}
}

/**
 * Boots the standalone PWA (selected via `fileReplacements` in the `pwa` build configuration).
 * Static import on purpose: within the PWA build there is nothing to code-split away, and the
 * extension build never sees this file.
 */
export function bootstrapApp(): void {
	flagSamsungInternet();
	platformBrowserDynamic()
		.bootstrapModule(PwaAppModule, { applicationProviders: [provideZoneChangeDetection()] })
		.catch((err) => console.error(err));
}
