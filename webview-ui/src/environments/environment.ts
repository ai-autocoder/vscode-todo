// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts` (extension webview build),
// or with `environment.pwa.ts` when building the standalone PWA (`pwa` configuration).
// The list of file replacements can be found in `angular.json`.

import type { AppEnvironment } from "./environment.types";
export type { AppEnvironment } from "./environment.types";

export const environment: AppEnvironment = {
	production: false,
	pwa: false,
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
