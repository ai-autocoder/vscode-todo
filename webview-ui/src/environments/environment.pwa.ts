import type { AppEnvironment } from "./environment.types";

/**
 * Standalone PWA build. Selected by the `pwa` configuration in `angular.json` via
 * `fileReplacements`, so the extension webview build never sees these settings.
 *
 * `clientId` and `deviceFlowProxyUrl` are NOT secrets:
 *   - `clientId` is the public id of a GitHub OAuth App with Device Flow enabled.
 *   - `deviceFlowProxyUrl` is the deployed Cloudflare Worker (worker/) that adds CORS headers
 *     to GitHub's two device-flow endpoints; it holds no credentials.
 *
 * Replace the placeholders below with the real values once the OAuth App is registered and the
 * Worker is deployed (Phase 6).
 */
export const environment: AppEnvironment = {
	production: true,
	pwa: true,
	gist: {
		clientId: "REPLACE_WITH_GITHUB_OAUTH_CLIENT_ID",
		deviceFlowProxyUrl: "https://REPLACE_WITH_YOUR_WORKER.workers.dev",
	},
};
