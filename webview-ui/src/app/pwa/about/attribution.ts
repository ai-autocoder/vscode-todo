// Only `version` is imported, so the bundler keeps that one field and drops the rest of the
// extension manifest. `webview-ui/package.json` is not a release number (it stays at 0.0.1);
// the root one is the version the extension and this app ship under.
import { version } from "../../../../../package.json";

/** What the About panel shows: the app, its version, and the project's links. */
export const ATTRIBUTION = {
	appName: "Agent Plans",
	version,
	author: "Francesco Anzalone",
	authorUrl: "https://francescoanzalone.dev",
	sourceUrl: "https://github.com/ai-autocoder/vscode-todo",
	issuesUrl: "https://github.com/ai-autocoder/vscode-todo/issues",
	licenseUrl: "https://github.com/ai-autocoder/vscode-todo/blob/master/LICENSE",
	extensionUrl: "https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo",
} as const;
