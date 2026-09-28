import type { WebviewApi } from "vscode-webview";

/**
 * A utility wrapper around the acquireVsCodeApi() function, which enables
 * message passing and state management between the webview and extension
 * contexts.
 *
 * This utility also enables webview code to be run in a web browser-based
 * dev server by using native web browser features that mock the functionality
 * enabled by acquireVsCodeApi.
 *
 * Exported for tests; the app uses the {@link vscode} singleton.
 */
export class VSCodeAPIWrapper {
	private readonly vsCodeApi: WebviewApi<unknown> | undefined;
	private postMessageDelegate: ((message: unknown) => void) | undefined;

	/**
	 * @param win The window the app runs in. Tests pass a frame's, set up the way VS Code sets up
	 * a webview's.
	 */
	constructor(private readonly win: Window = window) {
		// Check if the acquireVsCodeApi function exists in the current development
		// context (i.e. VS Code development window or web browser)
		const scope = win as Window & { acquireVsCodeApi?: typeof acquireVsCodeApi };
		if (typeof scope.acquireVsCodeApi === "function") {
			this.vsCodeApi = scope.acquireVsCodeApi();
		}
	}

	/**
	 * Install a receiver for messages posted outside VS Code. The standalone PWA sets this to
	 * route the app's outbound messages to its data gateway. Never consulted inside the real
	 * webview, where acquireVsCodeApi exists and takes precedence.
	 */
	public setPostMessageDelegate(delegate: (message: unknown) => void) {
		this.postMessageDelegate = delegate;
	}

	/**
	 * Whether a `message` event was posted by this app's host, and so may be read as one of its
	 * messages. Any window that can reach this one, such as a page that opened it or a frame
	 * inside it, can post here too. A `syncTodoData` from it would replace the list on screen,
	 * and a drag-to-reorder then sends that whole list back to be stored.
	 *
	 * - Inside VS Code the host is the webview frame around this document. VS Code loads this
	 *   document from the host page's own origin, so the host's messages carry this origin,
	 *   while the workbench and other webviews are on origins of their own. The sending window
	 *   cannot be checked: VS Code sets `window.parent` to this document's own window before the
	 *   app's scripts run.
	 * - Outside it, the PWA shell re-posts its gateway's messages on this same window.
	 */
	public isHostMessage(event: MessageEvent): boolean {
		return this.vsCodeApi ? event.origin === this.win.origin : event.source === this.win;
	}

	/**
	 * Post a message (i.e. send arbitrary data) to the owner of the webview.
	 *
	 * @remarks When running webview code inside a web browser, postMessage will instead
	 * log the given message to the console.
	 *
	 * @param message Arbitrary data (must be JSON serializable) to send to the extension context.
	 */
	public postMessage(message: unknown) {
		if (this.vsCodeApi) {
			this.vsCodeApi.postMessage(message);
		} else if (this.postMessageDelegate) {
			this.postMessageDelegate(message);
		} else {
			console.log(message);
		}
	}

	/**
	 * Get the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, getState will retrieve state
	 * from local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @return The current state or `undefined` if no state has been set.
	 */
	public getState(): unknown | undefined {
		if (this.vsCodeApi) {
			return this.vsCodeApi.getState();
		} else {
			const state = localStorage.getItem("vscodeState");
			return state ? JSON.parse(state) : undefined;
		}
	}

	/**
	 * Set the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, setState will set the given
	 * state using local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @param newState New persisted state. This must be a JSON serializable object. Can be retrieved
	 * using {@link getState}.
	 *
	 * @return The new state.
	 */
	public setState<T extends unknown | undefined>(newState: T): T {
		if (this.vsCodeApi) {
			return this.vsCodeApi.setState(newState);
		} else {
			localStorage.setItem("vscodeState", JSON.stringify(newState));
			return newState;
		}
	}
}

// Exports class singleton to prevent multiple invocations of acquireVsCodeApi.
export const vscode = new VSCodeAPIWrapper();
