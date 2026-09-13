/**
 * Provides {@link DATA_GATEWAY} for the **standalone PWA** build: a {@link GistGateway}
 * configured from `environment.gist`. Selected via `fileReplacements` in the `pwa` build
 * configuration (replacing `data.providers.ts`), so the extension webview never bundles any
 * gist/device-flow code. Static imports on purpose — see the CSP note in data.providers.ts.
 */

import { Provider } from "@angular/core";
import { environment } from "../../environments/environment";
import { DATA_GATEWAY, DataGateway } from "./data-gateway";
import { GistGateway } from "./gist-gateway";

export function createDataGateway(): DataGateway {
	if (!environment.gist) {
		throw new Error("PWA build is missing environment.gist configuration.");
	}
	return new GistGateway(environment.gist);
}

export const dataGatewayProvider: Provider = {
	provide: DATA_GATEWAY,
	useFactory: createDataGateway,
};
