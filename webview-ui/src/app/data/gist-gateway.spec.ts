import {
	mergeFilesData,
	resolveFileConflict,
	SyncErrorType,
	type FileConflictSet,
	type SyncError,
	type SyncResult,
	type Todo,
	type TodoFilesData,
} from "@vsc-todo/core";
import { TodoScope } from "../../../../src/todo/todoTypes";
import { GistGateway, type SyncFailureState } from "./gist-gateway";
import {
	MessageActionsToWebview,
	type SyncStatusInfo,
} from "../../../../src/panels/message";
import {
	fileConflictKey,
	type PendingConflictView,
	type PendingFileConflict,
} from "../pwa/conflicts/conflict-types";

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

	/**
	 * Engine stub whose user reconcile returns whatever this test wants.
	 *
	 * A successful result must carry `conflicts` and `fileConflicts`: both are required on the
	 * engine's reconcile result and `reconcileUser` spreads them to record what the merge settled
	 * on its own, so a stub that omits them throws before the sync state is ever updated.
	 */
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

		withUserResult({ success: true, data: { data: { userTodos: [] }, conflicts: [], fileConflicts: [] } });
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
		withUserResult({ success: true, data: { data: { userTodos: [] }, conflicts: [], fileConflicts: [] } });
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

/**
 * The third place a file conflict gets settled — the review screen's "use the other device"
 * button — and the one furthest from the merge.
 *
 * `mergeFilesData` merges a file's todos per item and escalates only the ids both devices
 * changed, so the raw `local`/`remote` arrays on a `FileConflictSet` are pre-merge values that
 * neither device is holding: `local` is not what the engine applied, and `remote` lacks every
 * todo this device added to that file. Recording them verbatim made the card mis-state both
 * sides, made every record read as permanently stale (`resolvedValue` never matching what was
 * actually applied), and made accepting the other device delete this device's additions.
 *
 * `captureFileConflicts` therefore stores the two *resolutions*.
 */

/**
 * The header's sync indicator can only be as honest as what the gateway reports, and the state
 * it exists for — "this edit is not on GitHub yet" — is the one nothing used to record: the old
 * payload was a single `isSyncing` boolean, so an unpushed change and a settled one looked
 * identical.
 *
 * `pushDebounceMs` is set high in `beforeEach`, so a scheduled push stays scheduled for the whole
 * test: that is the dirty window, held open deliberately rather than raced.
 */
describe("GistGateway sync status reporting", () => {
	interface Internals {
		engine: unknown;
		userFile: string | undefined;
		workspaceFile: string | undefined;
		token: string | undefined;
		gistId: string | undefined;
		user: { todos: Todo[] };
		userStatus: string;
		workspaceStatus: string;
		retrySync(): void;
		startManualSync(options: { forgetSuppressedFailures: boolean }): void;
		refresh(): Promise<void>;
		consecutiveSyncFailures: Map<TodoScope.user | TodoScope.workspace, number>;
		reconcileUser(): Promise<void>;
		scheduleUserPush(): void;
		cancelPendingPushes(): void;
		resetSyncFailures(): void;
		notePersistFailure(scope: TodoScope.user | TodoScope.workspace, error: unknown): void;
		recordSyncFailure(
			scope: TodoScope.user | TodoScope.workspace,
			error: SyncError | undefined,
			options: { retryable: boolean; kind?: string; message?: string }
		): void;
	}

	let gateway: GistGateway;
	let internals: Internals;
	let statuses: SyncStatusInfo[];

	const failure = (type: SyncErrorType, retryable: boolean): SyncError => ({
		type,
		message: "stub failure",
		timestamp: new Date().toISOString(),
		retryable,
	});

	/** See the sibling block: a success has to carry both conflict lists or the reconcile throws. */
	function withUserResult(result: SyncResult<unknown>): void {
		internals.engine = {
			reconcileUser: () => Promise.resolve(result),
			persistLocalUser: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};
	}

	function ok(): SyncResult<unknown> {
		return {
			success: true,
			data: { data: { userTodos: [] }, conflicts: [], fileConflicts: [] },
		};
	}

	beforeEach(() => {
		gateway = new GistGateway({
			clientId: "test-client",
			deviceFlowProxyUrl: "https://example.invalid",
			pushDebounceMs: 60_000,
		});
		internals = gateway as unknown as Internals;
		internals.userFile = "user-todos.json";
		internals.workspaceFile = "workspace-default.json";
		internals.token = "stub-token";
		internals.gistId = "stub-gist";

		statuses = [];
		gateway.messages.subscribe((m) => {
			const message = m as { type: string; payload?: unknown };
			if (message.type === MessageActionsToWebview.updateSyncStatus) {
				statuses.push(message.payload as SyncStatusInfo);
			}
		});
	});

	afterEach(() => {
		// The 60s debounce timer would otherwise outlive the spec.
		internals.cancelPendingPushes();
	});

	function latest(): SyncStatusInfo {
		return statuses[statuses.length - 1];
	}

	it("reports a scope dirty as soon as an edit schedules a push", () => {
		internals.scheduleUserPush();

		expect(latest().user.status).toBe("dirty");
		// And says a manual sync would help, since the change is simply not pushed yet.
		expect(latest().user.canRetry).toBeTrue();
	});

	it("leaves the other scope alone", () => {
		internals.scheduleUserPush();

		expect(latest().workspace.status).toBe("offline");
	});

	it("reports syncing while on the network, then synced", async () => {
		withUserResult(ok());

		await internals.reconcileUser();

		expect(statuses.map((s) => s.user.status)).toEqual(["syncing", "synced"]);
		// The scope-agnostic flag the sync menu's spinner rides on.
		expect(statuses[0].isSyncing).toBeTrue();
		expect(latest().isSyncing).toBeFalse();
	});

	it("settles a scope that was dirty back to synced once the push lands", async () => {
		internals.scheduleUserPush();
		expect(latest().user.status).toBe("dirty");
		withUserResult(ok());

		await internals.reconcileUser();

		expect(latest().user.status).toBe("synced");
		// Nothing left to sync, so nothing to offer.
		expect(latest().user.canRetry).toBeFalse();
	});

	it("reports an error once the failure is one the banner would also show", async () => {
		// A revoked token is reported on the first failure, so one reconcile is enough.
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });

		await internals.reconcileUser();

		expect(latest().user.status).toBe("error");
	});

	/**
	 * The indicator's retry has to follow the gateway's own judgement. `recordSyncFailure`
	 * withholds `canRetry` from a revoked token because re-sending it only fails again — the
	 * banner offers Reconnect instead — so an indicator that reported this as retryable would
	 * put a dead "try again" beside that live button.
	 */
	it("does not call a revoked token retryable", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });

		await internals.reconcileUser();

		expect(latest().user.status).toBe("error");
		expect(latest().user.canRetry).toBeFalse();
	});

	it("calls a transient failure retryable once it is reported", async () => {
		// Suppressed while retries remain, so drive it past the threshold; a network blip really
		// can come good on a retry, which is the case that must stay actionable.
		withUserResult({ success: false, error: failure(SyncErrorType.NetworkError, true) });

		await internals.reconcileUser();
		await internals.reconcileUser();
		await internals.reconcileUser();

		expect(latest().user.status).toBe("error");
		expect(latest().user.canRetry).toBeTrue();
	});

	it("stays dirty rather than erroring on a blip the banner is suppressing", async () => {
		// A transient failure with retries left reports nothing, so the indicator must not claim
		// a failure the banner is deliberately not showing. The edit is still unpushed: dirty.
		withUserResult({ success: false, error: failure(SyncErrorType.NetworkError, true) });

		await internals.reconcileUser();

		expect(latest().user.status).toBe("dirty");
	});

	it("keeps a reported error up when the user edits again", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });
		await internals.reconcileUser();

		internals.scheduleUserPush();

		// Downgrading to "dirty" here would swap a red glyph for an amber one that says nothing is
		// wrong, on every edit made while sync is broken.
		expect(latest().user.status).toBe("error");
	});

	it("does not report a scope synced while a mid-flight edit is still owed", async () => {
		internals.engine = {
			reconcileUser: () => {
				// The edit lands while the reconcile is on the network — the case the engine's
				// re-merge exists for, and the one that leaves a push still owed afterwards.
				internals.scheduleUserPush();
				return Promise.resolve(ok());
			},
			persistLocalUser: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};

		await internals.reconcileUser();

		expect(latest().user.status).toBe("dirty");
	});

	it("drops a scope back to offline when the session ends", async () => {
		withUserResult(ok());
		await internals.reconcileUser();
		expect(latest().user.status).toBe("synced");

		await gateway.disconnectGitHub();

		expect(latest().user.status).toBe("offline");
		expect(latest().workspace.status).toBe("offline");
		expect(latest().isSyncing).toBeFalse();
	});

	/**
	 * "Sync all now" and the indicator both land here, and both are presses a user makes when a
	 * sync looks stuck — so they take the guarded path rather than a bare `pullAll()`, which
	 * refills the retry budgets the automatic backoff needs and stops repeat presses stacking
	 * four-to-eight gist requests each.
	 */
	/**
	 * Reconnect clears the banner mid-session (`connectGitHub` calls `resetSyncFailures` before
	 * running the device flow), and an edit can still be owed at that moment. Calling that "not
	 * synced yet" would put a passive grey glyph over an edit that exists only on the device —
	 * the app-looks-healthy-while-sync-is-dead state the indicator exists to remove.
	 */
	it("keeps an owed edit visible when a reconnect clears the banner", async () => {
		// A *non-retryable* failure deliberately: the retryable branch marks the scope dirty on
		// its own (it re-arms a push), which would make this pass without the edit below.
		withUserResult({ success: false, error: failure(SyncErrorType.NotFoundError, false) });
		await internals.reconcileUser();
		expect(latest().user.status).toBe("error");
		internals.scheduleUserPush();

		internals.resetSyncFailures();

		expect(latest().user.status).toBe("dirty");
	});

	/**
	 * The banner ORs retryability across the sync- and persist-failure maps, so the indicator
	 * has to as well: a revoked token beside a blocked IndexedDB write showed a banner *with* a
	 * working "Try again" and an indicator that refused the click.
	 */
	it("offers a retry when either failure says one would help", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.AuthError, true) });
		await internals.reconcileUser();
		expect(latest().user.canRetry).toBeFalse();

		// A local write failure is always retryable — the retry re-runs the write.
		internals.notePersistFailure(TodoScope.user, new Error("blocked"));

		expect(latest().user.status).toBe("error");
		expect(latest().user.canRetry).toBeTrue();
	});

	/**
	 * `canRetry` is part of the payload, so it has to be part of what decides whether to send
	 * one. Dedupe on the status string alone left the webview holding a stale retryability and
	 * offering "try again" for a failure the gateway had since reclassified.
	 */
	it("re-sends a status whose retryability changed", async () => {
		withUserResult({ success: false, error: failure(SyncErrorType.NetworkError, true) });
		await internals.reconcileUser();
		await internals.reconcileUser();
		await internals.reconcileUser();
		expect(latest().user.canRetry).toBeTrue();
		const before = statuses.length;

		// Same status, different retryability: a failure no retry can fix.
		internals.recordSyncFailure(TodoScope.user, undefined, {
			retryable: false,
			kind: "missing",
			message: "no gist",
		});

		expect(statuses.length).toBeGreaterThan(before);
		expect(latest().user.status).toBe("error");
		expect(latest().user.canRetry).toBeFalse();
	});

	it("does not re-send an identical payload", () => {
		internals.scheduleUserPush();
		const count = statuses.length;

		internals.scheduleUserPush();
		internals.scheduleUserPush();

		expect(statuses.length).toBe(count);
	});

	/**
	 * "Sync all now" and the banner's retry share one guarded entry point, but not the same
	 * treatment of the suppression streak. This pins the routing decision only; the guard and
	 * the budget reset inside that body are covered by the two tests below.
	 */
	it("routes both manual syncs through one entry point, with different suppression handling", () => {
		const calls: Array<{ forgetSuppressedFailures: boolean }> = [];
		internals.startManualSync = (options) => {
			calls.push(options);
		};

		gateway.syncNow();
		gateway.retrySync();

		expect(calls.length).toBe(2);
		// The banner's retry starts from a clean streak because its failure is already reported;
		// "Sync all now" must not, or repeat presses would hold `recordSyncFailure` below its
		// threshold forever and the failure would never be reported at all.
		expect(calls[0].forgetSuppressedFailures).toBeFalse();
		expect(calls[1].forgetSuppressedFailures).toBeTrue();
	});

	/**
	 * Asserted on the counter rather than on a resulting banner: `startManualSync` kicks off a
	 * real `refresh()` whose reconciles are not awaited here, so a test that drove the streak to
	 * its threshold through the UI would depend on microtask interleaving. `refresh` is stubbed
	 * for the same reason — this is about the counter, not about what a sync then does.
	 */
	it("leaves the suppression streak alone for a header-initiated sync", async () => {
		internals.refresh = () => Promise.resolve();
		withUserResult({ success: false, error: failure(SyncErrorType.NetworkError, true) });
		await internals.reconcileUser();
		expect(internals.consecutiveSyncFailures.get(TodoScope.user)).toBe(1);

		gateway.syncNow();

		// Cleared here, the streak could never reach MAX_SYNC_RETRIES, so a transient failure
		// would stay suppressed forever and the user would never be told sync was broken.
		expect(internals.consecutiveSyncFailures.get(TodoScope.user)).toBe(1);
	});

	it("clears the streak for a banner-initiated retry, whose failure is already reported", async () => {
		internals.refresh = () => Promise.resolve();
		withUserResult({ success: false, error: failure(SyncErrorType.NetworkError, true) });
		await internals.reconcileUser();

		gateway.retrySync();

		expect(internals.consecutiveSyncFailures.has(TodoScope.user)).toBeFalse();
	});

	it("ignores a second manual sync while the first is still running", () => {
		let refreshes = 0;
		// Never settles, so the guard stays closed for the duration of the test.
		internals.refresh = () => {
			refreshes++;
			return new Promise(() => {});
		};

		gateway.syncNow();
		gateway.syncNow();
		gateway.syncNow();

		// Each press is another four-to-eight gist requests; pressing again is the obvious
		// response to a sync that looks stuck.
		expect(refreshes).toBe(1);
	});

	/**
	 * "No failure and nothing owed" is not the same as "synced". Clearing a failure re-settles
	 * the scope, and Reconnect clears failures mid-session — so without a record of an actual
	 * round trip, tapping Connect or Reconnect reported the indicator green over a gist this
	 * device had never reached.
	 *
	 * No reconcile here on purpose: this is the fresh-session state, where nothing is owed and
	 * nothing has failed, and the only thing separating it from a settled scope is whether a
	 * round trip has happened.
	 */
	it("does not report synced before a round trip has happened", () => {
		internals.resetSyncFailures();

		expect(latest().user.status).toBe("offline");
		expect(latest().workspace.status).toBe("offline");
	});

	/**
	 * Only a confirmed round trip may leave a scope owing nothing. The reconcile clears the
	 * pending flag on the way in, so a failure that does not restore it lets the next
	 * failure-clear — the banner's Reconnect — report "synced" over an edit that never left.
	 */
	it("keeps an edit owed when the reconcile that would have pushed it failed", async () => {
		withUserResult(ok());
		await internals.reconcileUser();
		internals.scheduleUserPush();
		// The push that was owed now fails for good: a deleted gist.
		withUserResult({ success: false, error: failure(SyncErrorType.NotFoundError, false) });
		await internals.reconcileUser();

		internals.resetSyncFailures();

		expect(latest().user.status).toBe("dirty");
	});

	it("keeps an edit owed when the reconcile threw", async () => {
		withUserResult(ok());
		await internals.reconcileUser();
		internals.scheduleUserPush();
		internals.engine = {
			reconcileUser: () => Promise.reject(new Error("boom")),
			persistLocalUser: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};
		await internals.reconcileUser();

		internals.resetSyncFailures();

		expect(latest().user.status).toBe("dirty");
	});

	/**
	 * Clearing failures while a round trip is on the network must not announce a result for it —
	 * the spinner would stop and the glyph would go green mid-sync.
	 */
	it("leaves a reconcile on the network to report its own outcome", async () => {
		let settle: (() => void) | undefined;
		internals.engine = {
			reconcileUser: () =>
				new Promise((resolve) => {
					settle = () => resolve(ok());
				}),
			persistLocalUser: () => Promise.resolve(),
			reconcileWithLocalEdits: (_a: unknown, b: unknown) => b,
		};
		const inFlight = internals.reconcileUser();
		expect(latest().user.status).toBe("syncing");

		internals.resetSyncFailures();

		expect(latest().user.status).toBe("syncing");
		settle?.();
		await inFlight;
		expect(latest().user.status).toBe("synced");
	});

	it("reports synced once a round trip has happened", async () => {
		withUserResult(ok());
		await internals.reconcileUser();

		internals.resetSyncFailures();

		expect(latest().user.status).toBe("synced");
	});
});

describe("GistGateway file conflict records", () => {
	interface FileInternals {
		filesData: TodoFilesData;
		captureFileConflicts(conflicts: FileConflictSet[]): void;
		applyConflictChoice(key: string, merged?: Todo, force?: boolean): Promise<unknown>;
	}

	const filePath = "src/a.ts";

	const todo = (id: number, text: string): Todo => ({
		id,
		text,
		completed: false,
		creationDate: "2020-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	});

	let gateway: GistGateway;
	let internals: FileInternals;
	let views: PendingConflictView[] = [];

	/**
	 * Todo 10 renamed differently on both devices, and one addition on each side — the exact
	 * shape that used to lose the other device's addition.
	 */
	const conflict = (): FileConflictSet => {
		const base = [todo(10, "orig")];
		const local = [todo(10, "renamed here"), todo(12, "added here")];
		const remote = [todo(10, "renamed there"), todo(11, "added there")];
		return mergeFilesData({ [filePath]: base }, { [filePath]: local }, { [filePath]: remote })
			.conflicts[0];
	};

	const fileRecord = (): PendingFileConflict => {
		const view = views.find((candidate) => candidate.conflict.kind === "file");
		return view!.conflict as PendingFileConflict;
	};

	beforeEach(() => {
		gateway = new GistGateway({
			clientId: "test-client",
			deviceFlowProxyUrl: "https://example.invalid",
			pushDebounceMs: 60_000,
		});
		internals = gateway as unknown as FileInternals;
		views = [];
		gateway.conflicts.subscribe((next) => (views = next));
	});

	it("records both sides as resolutions, each keeping every addition", () => {
		internals.captureFileConflicts([conflict()]);

		const record = fileRecord();
		const local = (record.local ?? []).map((t) => t.text);
		const remote = (record.remote ?? []).map((t) => t.text);

		// "This device" is what the engine applied under prefer-local...
		expect(local).toContain("renamed here");
		expect(local).not.toContain("renamed there");
		// ...and "other device" swaps only the disputed todo.
		expect(remote).toContain("renamed there");
		expect(remote).not.toContain("renamed here");
		// Neither side drops anyone's addition. This is the regression.
		for (const side of [local, remote]) {
			expect(side).toContain("added here");
			expect(side).toContain("added there");
		}
	});

	it("keeps resolvedValue equal to the applied side, so the record is not born stale", () => {
		const record = (internals.captureFileConflicts([conflict()]), fileRecord());

		expect(record.resolvedValue).toEqual(record.local);
	});

	it("does not delete this device's additions when the other device is accepted", async () => {
		const settled = conflict();
		// The engine has already applied its prefer-local resolution to the local list.
		internals.filesData = { [filePath]: resolveFileConflict(settled, "local")! };
		internals.captureFileConflicts([settled]);

		await internals.applyConflictChoice(fileConflictKey(filePath));

		const stored = (internals.filesData[filePath] ?? []).map((t) => t.text);
		expect(stored).toContain("renamed there"); // the choice took effect
		expect(stored).not.toContain("renamed here");
		expect(stored).toContain("added here"); // and nothing was collateral
		expect(stored).toContain("added there");
	});
});
