import { SyncErrorType, type SyncError, type SyncResult } from "@vsc-todo/core";
import { TodoScope } from "../../../../src/todo/todoTypes";
import { GistGateway, type SyncFailureState } from "./gist-gateway";
import { MessageActionsToWebview } from "../../../../src/panels/message";

/**
 * Regression cover for the audit finding "a dead sync looks exactly like a healthy one".
 *
 * Edits are meant to keep landing in IndexedDB whatever the network does, so the only thing
 * between a dead sync and silently marooned data is whether the gateway *says* so. Three paths
 * used to say nothing:
 *
 *   1. a non-retryable failure (a deleted gist) fell straight through the `else if`;
 *   2. a retryable one that exhausted the retry budget gave up quietly — and that is the path a
 *      revoked token takes, since GitHub's 401 is marked `retryable: true`;
 *   3. a thrown error reached no `SyncResult` branch at all, and every caller runs these through
 *      `void this.enqueue(...)`, which discards the rejection.
 *
 * The audit described only (1), and attributed the 401 to it. Reporting is now deliberately
 * independent of the retry budget: `mutate` refills it on every edit and `refresh` on every
 * focus, so an actively-used app could loop 401 → retry → edit → 401 forever without the
 * counter ever reaching the cap.
 *
 * `GistGateway`'s constructor builds only plain objects and opens no IndexedDB connection, so it
 * can be driven directly here with a stub standing in for `GistSyncEngine`.
 */
describe("GistGateway sync failure reporting", () => {
	/** The private surface these tests reach into; all of it is real gateway state. */
	interface Internals {
		engine: unknown;
		userFile: string | undefined;
		workspaceFile: string | undefined;
		token: string | undefined;
		gistId: string | undefined;
		userRetries: number;
		workspaceRetries: number;
		reconcileUser(): Promise<void>;
		reconcileWorkspace(): Promise<void>;
		notePersistFailure(scope: TodoScope.user | TodoScope.workspace, error: unknown): void;
		clearPersistFailure(scope: TodoScope.user | TodoScope.workspace): void;
		unexpectedSyncMessage(scope: TodoScope.user | TodoScope.workspace, error: unknown): string;
	}

	let gateway: GistGateway;
	let internals: Internals;
	let states: SyncFailureState[];

	const failure = (type: SyncErrorType, retryable: boolean): SyncError => ({
		type,
		message: "stub failure",
		timestamp: new Date().toISOString(),
		retryable,
	});

	/**
	 * Counts real calls into the engine stub, so a test asserting *silence* can first prove the
	 * reconcile actually ran. Without it, `reconcileUser`'s `if (!engine || !fileName) return;`
	 * guard makes every "no failure reported" assertion pass for the wrong reason — a renamed
	 * field or a changed guard would leave those tests green while reporting was broken.
	 */
	let engineCalls = 0;

	/** Engine stub whose user reconcile returns whatever this test wants. */
	function withUserResult(result: SyncResult<unknown>): void {
		internals.engine = {
			reconcileUser: () => {
				engineCalls++;
				return Promise.resolve(result);
			},
			persistLocalUser: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};
	}

	function latest(): SyncFailureState {
		return states[states.length - 1];
	}

	beforeEach(() => {
		gateway = new GistGateway({
			clientId: "test-client",
			deviceFlowProxyUrl: "https://example.invalid",
			// Keeps any scheduled retry timer well clear of the run.
			pushDebounceMs: 60_000,
		});
		internals = gateway as unknown as Internals;
		internals.userFile = "user-todos.json";
		internals.token = "stub-token";
		internals.gistId = "stub-gist";

		states = [];
		engineCalls = 0;
		gateway.syncFailure.subscribe((state) => states.push(state));
	});

	it("starts out reporting no failure", () => {
		expect(latest()).toEqual({ phase: "ok" });
	});

	it("reports a non-retryable failure instead of falling through silently", async () => {
		// A deleted gist. No retry can fix it, and this branch previously emitted nothing at all.
		withUserResult({ success: false, error: failure(SyncErrorType.NotFoundError, false) });

		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.kind).toBe("missing");
		// The wording has to say the todos are safe locally, or it reads as data loss.
		expect(state.message).toContain("still on this device");
	});

	it("reports a revoked token on the very first failure, with no dead retry offered", async () => {
		// A dead token does not fix itself, and waiting for the retry budget would mean an
		// actively-edited app may never report it at all.
		internals.userRetries = 0;
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });

		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.kind).toBe("auth");
		// Core marks 401/403 `retryable: true` at the transport level, so passing that straight
		// through put a "Try again" button — which re-sends the same rejected token and can only
		// fail — right next to the "Reconnect" that actually works.
		expect(state.canRetry).toBe(false);
	});

	it("treats a 403 secondary rate limit as transient, not as a revoked token", async () => {
		// GitHub returns 403 for both, and core folds them into one `AuthError`. Classifying by
		// status alone told a rate-limited user their token was revoked and sent them to redo the
		// device flow, which cannot help.
		const rateLimited: SyncError = {
			type: SyncErrorType.AuthError,
			message: "You have exceeded a secondary rate limit. Please wait a few minutes.",
			timestamp: new Date().toISOString(),
			retryable: true,
		};
		withUserResult({ success: false, error: rateLimited });

		// Transient, so it takes the full budget to surface.
		await internals.reconcileUser();
		await internals.reconcileUser();
		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.kind).toBe("other");
		expect(state.canRetry).toBe(true);
	});

	it("stays quiet on a transient blip while retries remain", async () => {
		// A rate limit or a dropped connection often clears itself, so it waits for the cap.
		withUserResult({ success: false, error: failure(SyncErrorType.RateLimitError, true) });

		await internals.reconcileUser();

		// Proves the silence is a decision, not an early return before any of this code ran.
		expect(engineCalls).toBe(1);
		expect(latest()).toEqual({ phase: "ok" });
	});

	it("reports a transient failure once it has happened enough times", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.RateLimitError, true) });

		// The resets stand in for the edit or focus that would refill `userRetries` in a live app.
		// They are deliberately inert here — `recordSyncFailure` counts `consecutiveSyncFailures`
		// and never reads `userRetries`, which is the whole point: reporting survives a budget
		// that keeps being refilled.
		await internals.reconcileUser();
		internals.userRetries = 0;
		await internals.reconcileUser();
		internals.userRetries = 0;
		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.kind).toBe("other");
		expect(state.canRetry).toBe(true);
	});

	it("keeps reporting the token as connected, so recovery stays reachable", async () => {
		// Folding the rejection into `isConnected` looked tempting — it would stop the sync menu
		// reading "Connected" — but the shared menu gates "Disconnect GitHub" and the gist-file
		// picker on that flag, so a false value strips the controls needed to recover. The banner
		// carries the bad news instead.
		const statuses: boolean[] = [];
		gateway.messages.subscribe((message) => {
			if (message.type === MessageActionsToWebview.updateGitHubStatus) {
				statuses.push((message.payload as { isConnected: boolean }).isConnected);
			}
		});

		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });
		await internals.reconcileUser();

		expect(latest().phase).toBe("failing");
		expect(statuses.every((connected) => connected)).toBe(true);
	});

	it("does not offer a retry for a failure retrying cannot fix", async () => {
		// A rejected payload is non-retryable, so a "Try again" button would only fail again.
		withUserResult({ success: false, error: failure(SyncErrorType.ValidationError, false) });
		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.canRetry).toBe(false);
	});

	it("reports an engine that throws, which reaches no SyncResult branch", async () => {
		// Callers run these through `void this.enqueue(...)`, which discards the rejection, so a
		// throw (a blocked IndexedDB upgrade, say) used to stop the spinner and say nothing.
		internals.engine = {
			reconcileUser: () => Promise.reject(new Error("indexeddb blocked")),
			persistLocalUser: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};

		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.message).toContain("indexeddb blocked");
	});

	it("clears the failure once a round trip gets through", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.NotFoundError, false) });
		await internals.reconcileUser();
		expect(latest().phase).toBe("failing");

		withUserResult({ success: true, data: { data: { userTodos: [] } } });
		await internals.reconcileUser();

		expect(latest()).toEqual({ phase: "ok" });
	});

	it("keeps the notice up while another scope is still failing", async () => {
		internals.workspaceFile = "workspace-default.json";
		internals.engine = {
			reconcileUser: () =>
				Promise.resolve({ success: false, error: failure(SyncErrorType.AuthError, true) }),
			reconcileWorkspace: () =>
				Promise.resolve({ success: false, error: failure(SyncErrorType.AuthError, true) }),
			persistLocalUser: () => Promise.resolve(),
			persistLocalWorkspace: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};

		await internals.reconcileUser();
		await internals.reconcileWorkspace();
		expect(latest().phase).toBe("failing");

		// User recovers; workspace has not.
		withUserResult({ success: true, data: { data: { userTodos: [] } } });
		await internals.reconcileUser();

		expect(latest().phase).toBe("failing");
	});

	it("prefers the dead token over a rate limit when both scopes fail", async () => {
		// One banner, two scopes. Reporting whichever landed last would hide a 401 behind a 429
		// and offer a retry that can never succeed.
		internals.workspaceFile = "workspace-default.json";
		internals.engine = {
			reconcileUser: () =>
				Promise.resolve({ success: false, error: failure(SyncErrorType.AuthError, true) }),
			reconcileWorkspace: () =>
				Promise.resolve({ success: false, error: failure(SyncErrorType.RateLimitError, true) }),
			persistLocalUser: () => Promise.resolve(),
			persistLocalWorkspace: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};

		await internals.reconcileUser();
		await internals.reconcileWorkspace();
		internals.workspaceRetries = 0;
		await internals.reconcileWorkspace();
		internals.workspaceRetries = 0;
		await internals.reconcileWorkspace();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.kind).toBe("auth");
	});

	it("clears a standing failure when the user reconnects", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });
		await internals.reconcileUser();
		expect(latest().phase).toBe("failing");

		// Reconnecting is the banner's own advice for an auth failure. If the notice survived it,
		// the button would look broken until an unrelated edit or focus happened to clear it.
		void gateway.connectGitHub();

		expect(latest()).toEqual({ phase: "ok" });
	});

	it("clears a standing failure on disconnect, so it cannot outlive the session", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.NotFoundError, false) });
		await internals.reconcileUser();
		expect(latest().phase).toBe("failing");

		void gateway.disconnectGitHub();

		expect(latest()).toEqual({ phase: "ok" });
	});

	it("leaves a rejected payload with no action, rather than a retry that cannot work", async () => {
		// A 422. Nothing the user can press fixes it, so the banner must not imply otherwise —
		// the shell suppresses the whole actions row when every button is gated off.
		withUserResult({ success: false, error: failure(SyncErrorType.ValidationError, false) });

		await internals.reconcileUser();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		expect(state.kind).toBe("other");
		expect(state.canRetry).toBe(false);
	});

	it("keeps a revoked token visible when a local write also fails", async () => {
		// Both are keyed by scope. Sharing one map let the persist failure overwrite the `auth`
		// entry, which silently removed the "Reconnect" button — the user's only way out.
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });
		await internals.reconcileUser();
		expect(latest().phase).toBe("failing");

		internals.notePersistFailure(TodoScope.user, new Error("QuotaExceededError"));

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		// `auth` outranks the local-write failure, so the actionable one still wins the banner.
		expect(state.kind).toBe("auth");
	});

	it("stops reporting a local write failure once a write gets through", () => {
		internals.notePersistFailure(TodoScope.user, new Error("QuotaExceededError"));
		const failing = latest();
		expect(failing.phase).toBe("failing");
		if (failing.phase !== "failing") {
			return;
		}
		expect(failing.message).toContain("could not save");

		internals.clearPersistFailure(TodoScope.user);

		expect(latest()).toEqual({ phase: "ok" });
	});

	it("does not promise local safety when this device has also failed to write", () => {
		// The generic thrown-error message ends "Your todos are still on this device", which is
		// false precisely when IndexedDB is the thing that broke.
		internals.notePersistFailure(TodoScope.user, new Error("QuotaExceededError"));

		const message = internals.unexpectedSyncMessage(TodoScope.user, new Error("boom"));

		expect(message).not.toContain("still on this device");
		expect(message).toContain("also failed to save");
	});

	it("says so rather than doing nothing when there is no gist to retry against", () => {
		// `refresh()` returns silently without a gist selection, which would leave the banner's
		// "Try again" looking broken.
		internals.gistId = undefined;

		gateway.retrySync();

		const state = latest();
		expect(state.phase).toBe("failing");
		if (state.phase !== "failing") {
			return;
		}
		// Must be `missing`, or the banner tells the user to choose a gist while withholding the
		// button that does it — inferring the kind from the custom message made it "other".
		expect(state.kind).toBe("missing");
		expect(state.message).toContain("no gist selected");
	});
});

/**
 * Regression cover for the audit finding "enter and reorder animations never play in the PWA".
 *
 * `todoMutations` stores a bare reducer name (`"addTodo"`) and documents that the
 * `"<scope>/<name>"` prefix "is applied by the caller", mirroring the slice-name prefix Redux
 * adds in the extension. `emitScope` is that caller and used to ship the bare name, so the
 * consumer's `actionType.split("/")[1]` produced `undefined` — never a member of
 * `enterAnimationEnabledActions`, and enough to make `shouldRunReorderAnimation()` always
 * return false.
 *
 * Asserted here on the gateway rather than in the shared list component's specs: the component
 * is built into the extension webview too, and its parse side is correct — the drift was on the
 * PWA's emit side.
 */
describe("GistGateway lastActionType scope prefix", () => {
	interface Internals {
		user: { lastActionType: string };
		workspace: { lastActionType: string };
		currentFile: { lastActionType: string };
		emitScope(scope: TodoScope): void;
	}

	let gateway: GistGateway;
	let internals: Internals;
	let emitted: Array<{ type: string; payload?: unknown }>;

	/** The `lastActionType` of the most recent `syncTodoData` message. */
	function lastEmittedActionType(): string | undefined {
		const syncs = emitted.filter((m) => m.type === MessageActionsToWebview.syncTodoData);
		const payload = syncs[syncs.length - 1]?.payload as { lastActionType?: string } | undefined;
		return payload?.lastActionType;
	}

	beforeEach(() => {
		gateway = new GistGateway({
			clientId: "test-client",
			deviceFlowProxyUrl: "https://example.invalid",
			pushDebounceMs: 60_000,
		});
		internals = gateway as unknown as Internals;

		emitted = [];
		gateway.messages.subscribe((m) => emitted.push(m as { type: string; payload?: unknown }));
	});

	it("prefixes the emitting scope onto a user action", () => {
		internals.user.lastActionType = "addTodo";

		internals.emitScope(TodoScope.user);

		// The exact shape the consumer's `split("/")[1]` depends on.
		expect(lastEmittedActionType()).toBe("user/addTodo");
	});

	it("prefixes the workspace scope", () => {
		internals.workspace.lastActionType = "toggleTodo";

		internals.emitScope(TodoScope.workspace);

		expect(lastEmittedActionType()).toBe("workspace/toggleTodo");
	});

	it("prefixes the currentFile scope", () => {
		internals.currentFile.lastActionType = "reorderTodo";

		internals.emitScope(TodoScope.currentFile);

		expect(lastEmittedActionType()).toBe("currentFile/reorderTodo");
	});

	it("yields an action name the enter animation actually accepts", () => {
		// The end the fix exists for: what the component extracts must be a real reducer name.
		internals.user.lastActionType = "addTodo";
		internals.emitScope(TodoScope.user);

		const extracted = (lastEmittedActionType() ?? "").split("/")[1];

		expect(extracted).toBe("addTodo");
		expect(["addTodo", "toggleTodo", "undoDelete"]).toContain(extracted);
	});

	it("leaves an empty action type empty rather than emitting a bare scope", () => {
		// `""` is the initial value; prefixing it would yield "user/", which parses to "" anyway
		// but reads as a real action in logs and in the store.
		internals.user.lastActionType = "";

		internals.emitScope(TodoScope.user);

		expect(lastEmittedActionType()).toBe("");
	});

	it("does not re-prefix the stored slice on a second emit", () => {
		// The reason the prefix is applied to a copy: mutating the slice in place would compound
		// to "user/user/addTodo" the next time the same slice was emitted.
		internals.user.lastActionType = "addTodo";

		internals.emitScope(TodoScope.user);
		internals.emitScope(TodoScope.user);

		expect(lastEmittedActionType()).toBe("user/addTodo");
		expect(internals.user.lastActionType).toBe("addTodo");
	});
});
