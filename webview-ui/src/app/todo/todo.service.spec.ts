import { MessageActionsToWebview } from "../../../../src/panels/message";
import { TodoScope, TodoSlice } from "../../../../src/todo/todoTypes";
import { vscode } from "../utilities/vscode";
import { TodoService } from "./todo.service";

/**
 * The composer's add is recognised by the text it sent rather than by the action name that
 * brings it back, because in the workspace scope the item usually arrives on a `loadData` —
 * the data-file watcher and a gist reload each dispatch one — and not on the add's own slice.
 * These cover the bookkeeping that makes that safe: a request expires, is claimable once, and
 * belongs to a single scope.
 */
describe("TodoService local add tracking", () => {
	let service: TodoService;

	beforeEach(() => {
		// Built directly, with its `message` listener suppressed — and only that one, since Karma
		// and Angular register their own on the same window. The service otherwise subscribes to
		// `window` for the host's slices, and every suite shares one page, so the gist-gateway
		// specs' posts would reach this instance and be read as host messages.
		const addEventListener = window.addEventListener.bind(window);
		spyOn(window, "addEventListener").and.callFake((type: string, ...rest: unknown[]) => {
			if (type !== "message") {
				(addEventListener as (...args: unknown[]) => void)(type, ...rest);
			}
		});
		// Its constructor also announces "webview-ready" on a timer, through the shared vscode
		// wrapper, where the PWA shell specs leave a delegate installed that would route it into
		// their gateway — and it fires after this spec ends, once the spy below is restored. The
		// clock holds that timer (and the service's minute interval) so neither ever runs.
		jasmine.clock().install();
		spyOn(vscode, "postMessage");
		service = new TodoService();
	});

	afterEach(() => {
		jasmine.clock().uninstall();
	});

	it("matches the text the composer sent", () => {
		service.addTodo(TodoScope.user, { text: "buy milk" });

		expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeTrue();
	});

	it("does not match a different item", () => {
		service.addTodo(TodoScope.user, { text: "buy milk" });

		expect(service.matchesLocalAdd(TodoScope.user, "something an agent added")).toBeFalse();
	});

	it("matches nothing when the composer has not added anything", () => {
		expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeFalse();
	});

	it("compares trimmed on both sides", () => {
		// The composer trims before sending; a host is free to hand the text back either way.
		service.addTodo(TodoScope.user, { text: "  buy milk  " });

		expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeTrue();
		expect(service.matchesLocalAdd(TodoScope.user, " buy milk ")).toBeTrue();
	});

	it("keeps each scope's request to itself", () => {
		service.addTodo(TodoScope.workspace, { text: "buy milk" });

		expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeFalse();
		expect(service.matchesLocalAdd(TodoScope.workspace, "buy milk")).toBeTrue();
	});

	it("can be claimed once", () => {
		service.addTodo(TodoScope.user, { text: "buy milk" });

		expect(service.claimLocalAdd(TodoScope.user, "buy milk")).toBeTrue();
		expect(service.claimLocalAdd(TodoScope.user, "buy milk")).toBeFalse();
		expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeFalse();
	});

	it("does not claim on a mismatch, leaving the request for its own item", () => {
		service.addTodo(TodoScope.user, { text: "buy milk" });

		expect(service.claimLocalAdd(TodoScope.user, "not mine")).toBeFalse();
		expect(service.claimLocalAdd(TodoScope.user, "buy milk")).toBeTrue();
	});

	it("expires, so a request the host silently dropped cannot be claimed much later", () => {
		// The host refuses a workspace add outright when no folder is open, and answers nothing.
		const realNow = Date.now;
		try {
			service.addTodo(TodoScope.user, { text: "buy milk" });
			Date.now = () => realNow() + 10_001;

			expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeFalse();
		} finally {
			Date.now = realNow;
		}
	});

	it("still matches just inside the window, which has to cover a sync round trip", () => {
		const realNow = Date.now;
		try {
			service.addTodo(TodoScope.user, { text: "buy milk" });
			Date.now = () => realNow() + 9_000;

			expect(service.matchesLocalAdd(TodoScope.user, "buy milk")).toBeTrue();
		} finally {
			Date.now = realNow;
		}
	});
});

/**
 * The host's messages arrive on `window`, where any window holding a reference to this one can
 * post. A `syncTodoData` from elsewhere would replace the list on screen, and a drag-to-reorder
 * sends the whole list on screen back to be stored, so only the host's messages may be applied.
 */
describe("TodoService host messages", () => {
	let service: TodoService;
	let onMessage: (event: MessageEvent) => void;
	let frame: HTMLIFrameElement;

	const plantedList: TodoSlice = {
		scope: TodoScope.user,
		todos: [
			{
				id: 1,
				text: "planted",
				completed: false,
				creationDate: "2026-09-28T00:00:00.000Z",
				isMarkdown: false,
				isNote: false,
			},
		],
		lastActionType: "user/loadData",
		numberOfTodos: 1,
		numberOfNotes: 0,
	};
	const syncMessage = { type: MessageActionsToWebview.syncTodoData, payload: plantedList };

	beforeEach(() => {
		// The service's `message` listener is captured and called directly, not registered, so
		// the posts other suites make on this shared page never reach it.
		const addEventListener = window.addEventListener.bind(window);
		spyOn(window, "addEventListener").and.callFake(
			(type: string, listener: unknown, ...rest: unknown[]) => {
				if (type === "message") {
					onMessage = listener as (event: MessageEvent) => void;
				} else {
					(addEventListener as (...args: unknown[]) => void)(type, listener, ...rest);
				}
			}
		);
		// Holds the constructor's "webview-ready" timer, as in the suite above.
		jasmine.clock().install();
		spyOn(vscode, "postMessage");
		service = new TodoService();
		// Karma has no acquireVsCodeApi, so the host is this window, as in the PWA.
		frame = document.createElement("iframe");
		document.body.appendChild(frame);
	});

	afterEach(() => {
		frame.remove();
		jasmine.clock().uninstall();
	});

	it("applies a list the host sent", () => {
		onMessage(new MessageEvent("message", { data: syncMessage, source: window }));

		expect(service.userTodos.map((todo) => todo.text)).toEqual(["planted"]);
	});

	it("ignores a list posted by another window", () => {
		onMessage(new MessageEvent("message", { data: syncMessage, source: frame.contentWindow }));

		expect(service.userTodos).toEqual([]);
	});

	it("ignores a message that is not an object", () => {
		for (const data of [null, "syncTodoData", 42]) {
			expect(() => onMessage(new MessageEvent("message", { data, source: window }))).not.toThrow();
		}
		expect(service.userTodos).toEqual([]);
	});
});
