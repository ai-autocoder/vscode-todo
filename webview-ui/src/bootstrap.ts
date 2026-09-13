import { provideZoneChangeDetection } from "@angular/core";
import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";
import { AppModule } from "./app/app.module";

/**
 * Boots the extension-webview app. The PWA build swaps this file for `bootstrap.pwa.ts` via
 * `fileReplacements` in angular.json.
 *
 * IMPORTANT: keep this build-time swap — do NOT turn it into a runtime `if` with a dynamic
 * `import()`. A dynamic import makes esbuild code-split the entry, and the webview's CSP
 * (`script-src 'nonce-…'`, no `'strict-dynamic'`) blocks chunk imports because imported
 * modules don't inherit the nonce. The extension build must stay a single self-contained
 * main.js (TodoViewProvider hand-loads exactly main.js/polyfills.js/scripts.js/styles.css).
 */
export function bootstrapApp(): void {
	platformBrowserDynamic()
		.bootstrapModule(AppModule, { applicationProviders: [provideZoneChangeDetection()] })
		.catch((err) => console.error(err));
}
