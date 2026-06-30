import type { GistGatewayConfig } from "../app/data/gist-gateway";

/**
 * Shape of the build environment. Defined in its own module (never subject to the
 * `fileReplacements` swap) so every `environment.*.ts` variant can import the type without it
 * being replaced out from under them at build time.
 */
export interface AppEnvironment {
	production: boolean;
	/** When true, the app runs as the standalone PWA (GistGateway) instead of in the webview. */
	pwa: boolean;
	/** GitHub access config for the PWA; only read when `pwa` is true. */
	gist?: GistGatewayConfig;
}
