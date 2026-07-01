import { provideZoneChangeDetection } from "@angular/core";
import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";
import { PwaAppModule } from "./app/pwa/pwa-app.module";

/**
 * Boots the standalone PWA (selected via `fileReplacements` in the `pwa` build configuration).
 * Static import on purpose: within the PWA build there is nothing to code-split away, and the
 * extension build never sees this file.
 */
export function bootstrapApp(): void {
	platformBrowserDynamic()
		.bootstrapModule(PwaAppModule, { applicationProviders: [provideZoneChangeDetection()] })
		.catch((err) => console.error(err));
}
