import { VSCodeAPIWrapper } from "./vscode";

/**
 * Only the app's host may send it messages. Any window holding a reference to this one can
 * post to it, so a message from anywhere else must not be read as the host's.
 */
describe("VSCodeAPIWrapper.isHostMessage", () => {
	const frames: HTMLIFrameElement[] = [];
	const newFrameWindow = (): Window => {
		const frame = document.createElement("iframe");
		document.body.appendChild(frame);
		frames.push(frame);
		return frame.contentWindow!;
	};
	const message = (init: MessageEventInit) =>
		new MessageEvent("message", { data: { type: "x" }, ...init });

	afterEach(() => {
		frames.splice(0).forEach((frame) => frame.remove());
	});

	describe("outside VS Code, where the PWA shell posts on this window", () => {
		let wrapper: VSCodeAPIWrapper;

		beforeEach(() => {
			wrapper = new VSCodeAPIWrapper();
		});

		it("accepts a message this window posted", () => {
			expect(wrapper.isHostMessage(message({ source: window }))).toBeTrue();
		});

		it("rejects a message from another window", () => {
			// Stands in for a page that opened this one, or a frame inside it.
			expect(wrapper.isHostMessage(message({ source: newFrameWindow() }))).toBeFalse();
		});

		it("rejects a message with no source window", () => {
			expect(wrapper.isHostMessage(message({}))).toBeFalse();
		});
	});

	describe("inside VS Code, where the webview host frame posts", () => {
		let content: Window;
		let wrapper: VSCodeAPIWrapper;

		beforeEach(() => {
			// Built the way VS Code builds a webview's content frame: same-origin with the host
			// page, with acquireVsCodeApi defined and then window.parent pointed at the frame
			// itself, before any of the app's scripts run. (VS Code assigns window.top as well, but
			// that property cannot be replaced, so the assignment does nothing.)
			content = newFrameWindow();
			const scope = content as unknown as { acquireVsCodeApi: () => unknown; parent: Window };
			scope.acquireVsCodeApi = () => ({
				postMessage: () => undefined,
				getState: () => undefined,
				setState: (state: unknown) => state,
			});
			scope.parent = content;
			wrapper = new VSCodeAPIWrapper(content);
		});

		it("accepts what the host posts into the frame, though window.parent is the frame itself", async () => {
			expect(content.parent).toBe(content);

			// This window plays the host page, which posts into the frame with the frame's origin
			// as the target.
			const accepted = new Promise<boolean>((resolve) => {
				content.addEventListener("message", (event) => resolve(wrapper.isHostMessage(event)), {
					once: true,
				});
			});
			content.postMessage({ type: "x" }, content.origin);

			expect(await accepted).toBeTrue();
		});

		it("rejects a message from another origin", () => {
			const fromWorkbench = message({ origin: "vscode-file://vscode-app", source: window });

			expect(wrapper.isHostMessage(fromWorkbench)).toBeFalse();
		});
	});
});
