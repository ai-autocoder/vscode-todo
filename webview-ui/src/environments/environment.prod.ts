import type { AppEnvironment } from "./environment.types";

// Extension webview, production build. Not a PWA — uses the VS Code postMessage gateway.
export const environment: AppEnvironment = {
	production: true,
	pwa: false,
};
