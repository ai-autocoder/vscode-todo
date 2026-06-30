/**
 * Selects the active {@link DataGateway} from the build environment and provides it under
 * {@link DATA_GATEWAY}.
 *
 * - Extension webview build (`environment.pwa === false`): {@link VsCodeGateway} — current
 *   behavior, talks to the extension host over `postMessage`.
 * - Standalone PWA build (`environment.pwa === true`): {@link GistGateway}, configured from
 *   `environment.gist`.
 *
 * `GistGateway` is loaded with a **dynamic `import()`** so esbuild code-splits it (and its
 * transitive `@vsc-todo/core` sync/device-flow code) out of the extension bundle entirely —
 * the extension build ships none of it. That makes the factory async, so the token resolves to
 * a `Promise<DataGateway>`; the (future) `TodoService` consumer awaits it. Registering the
 * provider is additive: nothing injects {@link DATA_GATEWAY} yet, so the extension webview is
 * unaffected — the `VsCodeGateway` is only constructed when something requests the token.
 */

import { Provider } from "@angular/core";
import { environment } from "../../environments/environment";
import { DATA_GATEWAY, DataGateway } from "./data-gateway";
import { VsCodeGateway } from "./vscode-gateway";

export async function createDataGateway(): Promise<DataGateway> {
	if (environment.pwa) {
		if (!environment.gist) {
			throw new Error("PWA build is missing environment.gist configuration.");
		}
		// Dynamic import keeps GistGateway + its sync/device-flow deps out of the webview bundle.
		const { GistGateway } = await import("./gist-gateway");
		return new GistGateway(environment.gist);
	}
	return new VsCodeGateway();
}

/**
 * Provides {@link DATA_GATEWAY} as a `Promise<DataGateway>`. Consumers `await` it (only a
 * future `TodoService` refactor will). Kept as a factory so no gateway is constructed unless
 * the token is actually injected.
 */
export const dataGatewayProvider: Provider = {
	provide: DATA_GATEWAY,
	useFactory: createDataGateway,
};
