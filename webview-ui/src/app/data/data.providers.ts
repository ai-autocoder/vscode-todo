/**
 * Provides {@link DATA_GATEWAY} for the **extension webview** build: always
 * {@link VsCodeGateway} (the current `postMessage` behavior). The PWA build swaps this file
 * for `data.providers.pwa.ts` via `fileReplacements`, so no gist/device-flow code is ever
 * bundled into the webview.
 *
 * IMPORTANT: keep the two variants as a build-time file swap — do NOT merge them behind a
 * runtime `if` with a dynamic `import()`. Code-splitting the entry breaks the webview's
 * nonce-only CSP (imported chunks don't inherit the nonce). See bootstrap.ts.
 *
 * Registering this provider is additive: nothing injects {@link DATA_GATEWAY} yet (the
 * `TodoService` migration is deferred); the gateway is only constructed when the token is
 * actually requested.
 */

import { Provider } from "@angular/core";
import { environment } from "../../environments/environment";
import { DATA_GATEWAY, DataGateway } from "./data-gateway";
import { VsCodeGateway } from "./vscode-gateway";

export function createDataGateway(): DataGateway {
	if (environment.pwa) {
		throw new Error("PWA build must use data.providers.pwa.ts (see angular.json fileReplacements).");
	}
	return new VsCodeGateway();
}

export const dataGatewayProvider: Provider = {
	provide: DATA_GATEWAY,
	useFactory: createDataGateway,
};
