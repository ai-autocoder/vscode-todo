import {
	serialize,
	SyncErrorType,
	type CacheStore,
	type ConflictDecisions,
	type ConflictSet,
	type GistCache,
	type GlobalGistData,
	type SyncResult,
	type Todo,
	type TodoFilesData,
	type WorkspaceGistData,
} from "@vsc-todo/core";
import { TodoScope, type StoreState } from "../../../../src/todo/todoTypes";
import { MessageActionsToWebview, type SyncStatusValue } from "../../../../src/panels/message";
import { GistGateway, type GistConnectionState, type SyncFailureState } from "./gist-gateway";
import type { InboundMessage } from "./data-gateway";
import type {
	ConflictPromptRequest,
	PendingConflict,
	PendingConflictView,
} from "../pwa/conflicts/conflict-types";

/**
 * Switching the PWA to a different gist list.
 *
 * The bug these exist for: picking another workspace list pushed the list on screen into the one
 * just picked. `chooseFiles` swapped the file *names* but kept the old list in memory, and the
 * next reconcile handed that list to the engine as the new file's local state. With no baseline
 * for the new file the engine merged every old todo in as an addition; with one (a list visited
 * before) it read them as local edits and pushed them over the file outright.
 *
 * Why nothing caught it: every other gateway suite pins the file names through the internals and
 * drives `reconcileUser`/`reconcileWorkspace` directly, so the one public path that *changes* a
 * file — `chooseFiles` — had no coverage at all, and the shell spec replaces it with a spy. The
 * engine suites could not see it either: the engine did exactly what its contract says with the
 * `localData` it was given. The defect was in what the gateway gave it, between two layers each
 * tested only on its own.
 *
 * So these go through `chooseFiles`, over the **real** `GistSyncEngine` and a fake gist holding
 * several files, and assert on what each file on the gist holds afterwards — not on which method
 * ran. The cache store copies on every read and write, as IndexedDB does: an in-memory store that
 * hands back live objects lets the slice and the cache share arrays, and a test can then pass on
 * an edit the gateway never actually persisted.
 *
 * The last suite is model-based; see its comment. The one before it pins the losses that walk
 * found in edits made while a sync is on the network, which are not specific to switching.
 */

interface Internals {
	engine: unknown;
	client: unknown;
	cacheStore: unknown;
	tokenStore: unknown;
	conflictStore: unknown;
	viewPreferencesStore: unknown;
	token: string | undefined;
	gistId: string | undefined;
	userFile: string | undefined;
	workspaceFile: string | undefined;
	user: { todos: Todo[] };
	workspace: { todos: Todo[] };
	currentFile: { filePath: string; todos: Todo[] };
	filesData: TodoFilesData;
	pendingConflicts: PendingConflict[];
	workspacePushTimer: ReturnType<typeof setTimeout> | undefined;
	pendingUserPush: boolean;
	pendingWorkspacePush: boolean;
	pollTimer: ReturnType<typeof setTimeout> | undefined;
	workspaceStatus: SyncStatusValue;
	createEngine(gistId: string): unknown;
	enqueue(work: () => Promise<void>): Promise<void>;
	reconcileUser(): Promise<void>;
	reconcileWorkspace(): Promise<void>;
	pullAll(): Promise<void>;
	publishConflicts(): void;
	cancelPendingPushes(): void;
	captureTodoConflicts(scope: "user" | "workspace", conflicts: ConflictSet[]): boolean;
}

const USER_A = "user-a.json";
const USER_B = "user-b.json";
const WS_A = "workspace-a.json";
const WS_B = "workspace-b.json";
const WS_C = "workspace-c.json";

const todo = (id: number, text: string): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2026-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
});

const userFile = (...todos: Todo[]): string => serialize({ userTodos: todos } as GlobalGistData);
const workspaceFile = (todos: Todo[], filesData: TodoFilesData = {}): string =>
	serialize({ workspaceTodos: todos, filesData, filesDataPaths: {} } as WorkspaceGistData);

const failure = (type: SyncErrorType, message: string, retryable: boolean) => ({
	success: false as const,
	error: { type, message, timestamp: new Date().toISOString(), retryable },
});

/**
 * Yields to the event loop for one macrotask — the way a network or IndexedDB callback arrives.
 * A message channel rather than `setTimeout`, which browsers clamp to 4ms once nested.
 */
function macrotask(): Promise<void> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(undefined);
	});
}

/**
 * A gist of several files, held in memory. Records every write, reports an absent file the way
 * `GistClient` does, can hold a file's reads so a reconcile can be caught mid-flight, and can
 * take a file offline. `yields` delays each call by that many macrotasks, so concurrent
 * reconciles interleave the way real round trips do.
 *
 * A read sees the file as it is when the answer arrives; a write takes effect when it is sent.
 * That keeps the engine's verified write — re-read, compare, write, with nothing awaited between
 * the last two — atomic, as GitHub would if it applied requests in order. The window that
 * remains in reality, another device's write landing while ours is in flight, is the gist API's
 * missing compare-and-swap (see ARCHITECTURE.md §11): no client can close it, so a fake that
 * reproduced it would only fail the walk for something the gateway cannot fix.
 */
class FakeGist {
	readonly writes: Array<{ file: string; content: string }> = [];
	/** Files whose reads and writes fail as a dropped connection would. */
	readonly down = new Set<string>();
	private readonly held = new Map<string, Promise<void>>();

	constructor(
		public files: Record<string, string>,
		private readonly yields: () => number = () => 0
	) {}

	private async delay(name: string): Promise<void> {
		for (let i = this.yields(); i > 0; i--) {
			await macrotask();
		}
		const gate = this.held.get(name);
		if (gate) {
			await gate;
		}
	}

	async readFile(_gistId: string, name: string): Promise<SyncResult<string>> {
		await this.delay(name);
		if (this.down.has(name)) {
			return failure(SyncErrorType.NetworkError, `${name} unreachable`, true);
		}
		if (!(name in this.files)) {
			return failure(SyncErrorType.FileNotFoundError, `${name} not found`, false);
		}
		return { success: true, data: this.files[name] };
	}

	async writeFile(_gistId: string, name: string, content: string): Promise<SyncResult<unknown>> {
		const reached = !this.down.has(name);
		if (reached) {
			this.files[name] = content;
			this.writes.push({ file: name, content });
		}
		await this.delay(name);
		return reached
			? { success: true, data: {} }
			: failure(SyncErrorType.NetworkError, `${name} unreachable`, true);
	}

	/** Parks every read and write of `name` until the returned function is called. */
	hold(name: string): () => void {
		let release!: () => void;
		this.held.set(
			name,
			new Promise<void>((resolve) => {
				release = () => {
					this.held.delete(name);
					resolve();
				};
			})
		);
		return release;
	}

	private parse(name: string): Partial<GlobalGistData & WorkspaceGistData> {
		return JSON.parse(this.files[name]) as Partial<GlobalGistData & WorkspaceGistData>;
	}

	/** The todo texts a file holds — the user list for `user-*`, the workspace list otherwise. */
	texts(name: string): string[] {
		const parsed = this.parse(name);
		return (parsed.userTodos ?? parsed.workspaceTodos ?? []).map((t) => t.text);
	}

	filesDataOf(name: string): TodoFilesData {
		return this.parse(name).filesData ?? {};
	}
}

/**
 * A cache store that copies on every read and write, as the IndexedDB one does. Can be told to
 * reject saves, as a full or blocked IndexedDB would, and to take macrotasks as IndexedDB does.
 */
class CopyingCacheStore implements CacheStore {
	private readonly map = new Map<string, GistCache<unknown>>();
	/** Saves to a key containing any of these fail. */
	readonly failingSaves = new Set<string>();

	constructor(private readonly yields: () => number = () => 0) {}

	private async delay(): Promise<void> {
		for (let i = this.yields(); i > 0; i--) {
			await macrotask();
		}
	}

	async load<T>(key: string): Promise<GistCache<T> | undefined> {
		await this.delay();
		const stored = this.map.get(key);
		return stored === undefined ? undefined : (structuredClone(stored) as GistCache<T>);
	}

	/**
	 * Parks the next save (the next one `which` accepts) until released, reporting when it gets
	 * there — so a test can act at the moment a reconcile is writing to the cache.
	 */
	holdNextSave(which: (cache: GistCache<unknown>) => boolean = () => true): {
		reached: Promise<void>;
		release: () => void;
	} {
		let reached!: () => void;
		let release!: () => void;
		const arrived = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		this.nextSave = { which, reached, gate };
		return { reached: arrived, release };
	}
	private nextSave:
		| { which: (cache: GistCache<unknown>) => boolean; reached: () => void; gate: Promise<void> }
		| undefined;

	async save<T>(key: string, cache: GistCache<T>): Promise<void> {
		await this.delay();
		const hold = this.nextSave;
		if (hold?.which(cache as GistCache<unknown>)) {
			this.nextSave = undefined;
			hold.reached();
			await hold.gate;
		}
		if ([...this.failingSaves].some((fragment) => key.includes(fragment))) {
			throw new Error("QuotaExceededError");
		}
		this.map.set(key, structuredClone(cache) as GistCache<unknown>);
	}

	async delete(key: string): Promise<void> {
		await this.delay();
		this.map.delete(key);
	}

	/** What a disconnect or a gist switch calls on the real store. */
	async clear(keep: readonly string[] = []): Promise<void> {
		for (const key of [...this.map.keys()]) {
			if (!keep.includes(key)) {
				this.map.delete(key);
			}
		}
	}
}

/** Stands in for the IndexedDB token store, recording the order of writes. */
class FakeTokenStore {
	readonly calls: string[] = [];
	constructor(private readonly stored: Record<string, string | undefined> = {}) {}
	async getToken(): Promise<string | undefined> {
		return this.stored["token"];
	}
	async getGistId(): Promise<string | undefined> {
		return this.stored["gistId"];
	}
	async getUserFile(): Promise<string | undefined> {
		return this.stored["userFile"];
	}
	async getWorkspaceFile(): Promise<string | undefined> {
		return this.stored["workspaceFile"];
	}
	async setUserFile(name: string): Promise<void> {
		this.calls.push(`user:${name}`);
	}
	async setWorkspaceFile(name: string): Promise<void> {
		this.calls.push(`workspace:${name}`);
	}
	async clear(): Promise<void> {
		this.calls.push("clear");
	}
	async clearFileSelections(): Promise<void> {
		this.calls.push("clearFileSelections");
	}
}

class FakeConflictStore {
	constructor(public stored: PendingConflict[] = []) {}
	async load(): Promise<PendingConflict[]> {
		return structuredClone(this.stored);
	}
	async save(conflicts: PendingConflict[]): Promise<void> {
		this.stored = structuredClone(conflicts);
	}
	async clear(): Promise<void> {
		/* in-memory only */
	}
}

/** Builds a gateway wired to `gist`, with nothing selected yet — as right after picking a gist. */
function createGateway(
	gist: FakeGist,
	cacheStore = new CopyingCacheStore()
): { gateway: GistGateway; internals: Internals } {
	const gateway = new GistGateway({
		clientId: "test-client",
		deviceFlowProxyUrl: "https://example.invalid",
		// Well past any test: a debounced push that fires must have been armed deliberately.
		pushDebounceMs: 60_000,
	});
	const internals = gateway as unknown as Internals;
	internals.token = "stub-token";
	internals.gistId = "stub-gist";
	internals.client = gist;
	internals.cacheStore = cacheStore;
	internals.tokenStore = new FakeTokenStore();
	internals.conflictStore = new FakeConflictStore();
	// Through `createEngine`, not a hand-built engine: the gateway's own construction is what
	// attaches the cache store and the conflict resolver, and both matter here.
	internals.engine = internals.createEngine("stub-gist");
	return { gateway, internals };
}

function teardown(gateway: GistGateway): void {
	const internals = gateway as unknown as Internals;
	internals.cancelPendingPushes();
	gateway.suspendPolling();
}

const texts = (todos: Todo[]): string[] => todos.map((t) => t.text);

/** Resolves to "done" or "timed out" — a hang must fail as itself, not as a Jasmine timeout. */
function settles(work: Promise<unknown>, ms = 3000): Promise<string> {
	return Promise.race([
		work.then(() => "done"),
		new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), ms)),
	]);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits, a macrotask at a time, until `condition` holds; fails loudly instead of hanging. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (condition()) {
			return;
		}
		await tick();
	}
	throw new Error(`never happened: ${what}`);
}

const record = (
	key: string,
	fileName: string,
	scope: "user" | "workspace",
	todoId: number
): PendingConflict => ({
	kind: "todo",
	key,
	scope,
	fileName,
	todoId,
	conflictType: "delete-edit",
	base: todo(todoId, "base"),
	local: null,
	remote: todo(todoId, `remote ${todoId}`),
	resolvedValue: null,
	syncedAt: new Date().toISOString(),
});

describe("GistGateway switching lists", () => {
	let gist: FakeGist;
	let gateway: GistGateway;
	let internals: Internals;
	let aUser: string;
	let bUser: string;
	let aWorkspace: string;
	let bWorkspace: string;

	beforeEach(async () => {
		aUser = userFile(todo(11, "user A one"), todo(12, "user A two"));
		bUser = userFile(todo(21, "user B one"));
		aWorkspace = workspaceFile([todo(31, "ws A one"), todo(32, "ws A two")], {
			"src/a.ts": [todo(33, "file todo in A")],
		});
		bWorkspace = workspaceFile([todo(41, "ws B one"), todo(42, "ws B two")], {
			"src/b.ts": [todo(43, "file todo in B")],
		});
		gist = new FakeGist({
			[USER_A]: aUser,
			[USER_B]: bUser,
			[WS_A]: aWorkspace,
			[WS_B]: bWorkspace,
		});
		({ gateway, internals } = createGateway(gist));
		// The first selection goes through the same public path as every later one.
		await gateway.chooseFiles(USER_A, WS_A);
		expect(texts(internals.workspace.todos)).toEqual(["ws A one", "ws A two"]);
		gist.writes.length = 0;
	});

	afterEach(() => teardown(gateway));

	describe("the workspace list", () => {
		it("does not write the old list into a file this device has never synced", async () => {
			await gateway.chooseFiles(USER_A, WS_B);

			expect(gist.files[WS_B]).toBe(bWorkspace);
			expect(gist.files[WS_A]).toBe(aWorkspace);
			expect(gist.writes).toEqual([]);
		});

		it("shows the picked file's todos, not the old list's", async () => {
			await gateway.chooseFiles(USER_A, WS_B);

			expect(internals.workspaceFile).toBe(WS_B);
			expect(texts(internals.workspace.todos)).toEqual(["ws B one", "ws B two"]);
		});

		/**
		 * The overwrite rather than the merge: on a second visit the file has a baseline, so the
		 * old list would read as a local edit against it and be pushed over the file.
		 */
		it("does not overwrite a file this device has synced before", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			await gateway.chooseFiles(USER_A, WS_A);
			await gateway.chooseFiles(USER_A, WS_B);

			expect(gist.files[WS_B]).toBe(bWorkspace);
			expect(gist.files[WS_A]).toBe(aWorkspace);
			expect(gist.writes).toEqual([]);
			expect(texts(internals.workspace.todos)).toEqual(["ws B one", "ws B two"]);
		});

		it("comes back to the old list intact", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			await gateway.chooseFiles(USER_A, WS_A);

			expect(texts(internals.workspace.todos)).toEqual(["ws A one", "ws A two"]);
			expect(gist.files[WS_A]).toBe(aWorkspace);
		});

		it("adopts what another device changed in the picked file since the last visit", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			await gateway.chooseFiles(USER_A, WS_A);
			gist.files[WS_B] = workspaceFile([todo(41, "ws B one"), todo(44, "added by the extension")], {
				"src/b.ts": [todo(43, "file todo in B")],
			});
			const remote = gist.files[WS_B];

			await gateway.chooseFiles(USER_A, WS_B);

			expect(texts(internals.workspace.todos)).toEqual(["ws B one", "added by the extension"]);
			expect(gist.files[WS_B]).toBe(remote);
		});

		it("creates a new file empty, rather than seeding it with the list on screen", async () => {
			await gateway.chooseFiles(USER_A, "workspace-new.json");

			expect(gist.texts("workspace-new.json")).toEqual([]);
			expect(gist.filesDataOf("workspace-new.json")).toEqual({});
			expect(internals.workspace.todos).toEqual([]);
			expect(gist.files[WS_A]).toBe(aWorkspace);
		});

		it("does not carry the per-file lists across", async () => {
			gateway.setCurrentFile("src/a.ts");
			expect(texts(internals.currentFile.todos)).toEqual(["file todo in A"]);

			await gateway.chooseFiles(USER_A, WS_B);

			expect(gist.filesDataOf(WS_B)).toEqual({ "src/b.ts": [todo(43, "file todo in B")] });
			expect(Object.keys(internals.filesData)).toEqual(["src/b.ts"]);
			// The open file was a projection of the old workspace file's lists.
			expect(internals.currentFile.filePath).toBe("");
			expect(internals.currentFile.todos).toEqual([]);
		});

		it("pushes an edit made just before the switch to the list it was made in", async () => {
			gateway.addTodo(TodoScope.workspace, { text: "added right before switching" });

			await gateway.chooseFiles(USER_A, WS_B);

			expect(gist.texts(WS_A)).toContain("added right before switching");
			expect(gist.texts(WS_B)).not.toContain("added right before switching");
			expect(gist.files[WS_B]).toBe(bWorkspace);
			// Nothing is left armed to push later against the new file.
			expect(internals.workspacePushTimer).toBeUndefined();
			expect(internals.pendingWorkspacePush).toBe(false);
		});

		/**
		 * A reconcile of the old file already on the network when the switch starts. Its result
		 * belongs to the old file; if it could land after the swap, the new file's first reconcile
		 * would be handed the old list and push it.
		 */
		it("keeps a reconcile in flight on the old list out of the new one", async () => {
			// Give the new file a baseline first, so a leak would be an overwrite, not a merge.
			await gateway.chooseFiles(USER_A, WS_B);
			await gateway.chooseFiles(USER_A, WS_A);
			gist.writes.length = 0;

			const release = gist.hold(WS_A);
			const inFlight = internals.enqueue(() => internals.reconcileWorkspace());
			await tick();
			const switching = gateway.chooseFiles(USER_A, WS_B);
			await tick();
			release();

			expect(await settles(Promise.all([inFlight, switching]))).toBe("done");
			expect(gist.files[WS_B]).toBe(bWorkspace);
			expect(texts(internals.workspace.todos)).toEqual(["ws B one", "ws B two"]);
		});
	});

	describe("the user list", () => {
		it("does not write the old list into the picked file", async () => {
			await gateway.chooseFiles(USER_B, WS_A);

			expect(gist.files[USER_B]).toBe(bUser);
			expect(gist.files[USER_A]).toBe(aUser);
			expect(gist.writes).toEqual([]);
			expect(texts(internals.user.todos)).toEqual(["user B one"]);
		});

		it("does not overwrite a file this device has synced before", async () => {
			await gateway.chooseFiles(USER_B, WS_A);
			await gateway.chooseFiles(USER_A, WS_A);
			await gateway.chooseFiles(USER_B, WS_A);

			expect(gist.files[USER_B]).toBe(bUser);
			expect(gist.files[USER_A]).toBe(aUser);
			expect(gist.writes).toEqual([]);
		});

		it("pushes an edit made just before the switch to the list it was made in", async () => {
			gateway.addTodo(TodoScope.user, { text: "user edit before switching" });

			await gateway.chooseFiles(USER_B, WS_A);

			expect(gist.texts(USER_A)).toContain("user edit before switching");
			expect(gist.files[USER_B]).toBe(bUser);
		});
	});

	describe("the list that is not switched", () => {
		it("keeps the user list, and its unsynced edit, when only the workspace list changes", async () => {
			gateway.addTodo(TodoScope.user, { text: "unsynced user edit" });

			await gateway.chooseFiles(USER_A, WS_B);

			expect(texts(internals.user.todos)).toContain("unsynced user edit");
			// And the pull after the switch pushed it where it belongs.
			expect(gist.texts(USER_A)).toContain("unsynced user edit");
		});

		it("keeps the workspace list when only the user list changes", async () => {
			gateway.addTodo(TodoScope.workspace, { text: "unsynced ws edit" });

			await gateway.chooseFiles(USER_B, WS_A);

			expect(texts(internals.workspace.todos)).toContain("unsynced ws edit");
			expect(gist.texts(WS_A)).toContain("unsynced ws edit");
		});

		it("changes nothing when the same lists are picked again", async () => {
			gateway.addTodo(TodoScope.workspace, { text: "still here" });

			await gateway.chooseFiles(USER_A, WS_A);

			expect(texts(internals.workspace.todos)).toContain("still here");
			expect(gist.texts(WS_A)).toContain("still here");
		});
	});

	/**
	 * The push for the old list can fail — offline, a damaged file — and then the list on screen
	 * is the only copy of the edit guaranteed to exist, right as the switch is about to replace
	 * it. The debounced persist does not cover a file whose first sync never succeeded: the
	 * engine keeps no cache entry without a baseline.
	 */
	describe("an edit the old list could not push", () => {
		it("survives the switch on a list whose first sync never succeeded", async () => {
			gist.down.add(WS_B);
			await gateway.chooseFiles(USER_A, WS_B);
			gateway.addTodo(TodoScope.workspace, { text: "added while B was unreachable" });

			await gateway.chooseFiles(USER_A, WS_A);
			gist.down.delete(WS_B);
			await gateway.chooseFiles(USER_A, WS_B);

			expect(texts(internals.workspace.todos)).toContain("added while B was unreachable");
			// Merged with what B already held rather than replacing it, and not leaked into A.
			expect(gist.texts(WS_B).sort()).toEqual(
				["added while B was unreachable", "ws B one", "ws B two"].sort()
			);
			expect(gist.files[WS_A]).toBe(aWorkspace);
		});

		it("survives the switch on a list that has synced before", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			gist.down.add(WS_B);
			gateway.addTodo(TodoScope.workspace, { text: "added while B was unreachable" });

			await gateway.chooseFiles(USER_A, WS_A);
			gist.down.delete(WS_B);
			await gateway.chooseFiles(USER_A, WS_B);

			expect(gist.texts(WS_B)).toContain("added while B was unreachable");
			expect(gist.files[WS_A]).toBe(aWorkspace);
		});

		it("refuses the switch when the edit can be neither pushed nor saved", async () => {
			gist.down.add(WS_B);
			await gateway.chooseFiles(USER_A, WS_B);
			gateway.addTodo(TodoScope.workspace, { text: "only copy" });
			(internals.cacheStore as CopyingCacheStore).failingSaves.add(WS_B);
			const failures: SyncFailureState[] = [];
			const states: GistConnectionState[] = [];
			const subs = [
				gateway.syncFailure.subscribe((state) => failures.push(state)),
				gateway.connection.subscribe((state) => states.push(state)),
			];

			expect(await settles(gateway.chooseFiles(USER_A, WS_A))).toBe("done");
			subs.forEach((sub) => sub.unsubscribe());

			expect(internals.workspaceFile).toBe(WS_B);
			expect(texts(internals.workspace.todos)).toContain("only copy");
			const last = failures[failures.length - 1];
			expect(last.phase).toBe("failing");
			expect(last.phase === "failing" && last.message).toContain("the list was not switched");
			// The picker closes back onto the list the user is still on.
			expect(states[states.length - 1]).toEqual({
				phase: "connected",
				userFile: USER_A,
				workspaceFile: WS_B,
			});
			expect(gist.files[WS_A]).toBe(aWorkspace);
		});

		it("drops the refusal notice once the switch goes through", async () => {
			gist.down.add(WS_B);
			await gateway.chooseFiles(USER_A, WS_B);
			gateway.addTodo(TodoScope.workspace, { text: "only copy" });
			(internals.cacheStore as CopyingCacheStore).failingSaves.add(WS_B);
			await gateway.chooseFiles(USER_A, WS_A);
			expect(internals.workspaceFile).toBe(WS_B);
			let failure: SyncFailureState = { phase: "ok" };
			const sub = gateway.syncFailure.subscribe((state) => (failure = state));
			expect(failure.phase).toBe("failing");

			// Network and storage both recover, and the user presses Ok again.
			gist.down.delete(WS_B);
			(internals.cacheStore as CopyingCacheStore).failingSaves.delete(WS_B);
			await gateway.chooseFiles(USER_A, WS_A);
			sub.unsubscribe();

			expect(internals.workspaceFile).toBe(WS_A);
			expect(gist.texts(WS_B)).toContain("only copy");
			expect(failure.phase).toBe("ok");
			expect(internals.workspaceStatus).not.toBe("error");
		});

		/**
		 * A pull that fails marks the scope as owing a push with no edit behind it. Refusing then
		 * would report "your latest change" not saved when nothing was changed at all.
		 */
		it("does not refuse over a failed first pull of a list with nothing in it", async () => {
			gist.down.add(WS_B);
			await gateway.chooseFiles(USER_A, WS_B);
			expect(internals.pendingWorkspacePush).toBe(true);
			(internals.cacheStore as CopyingCacheStore).failingSaves.add(WS_B);

			await gateway.chooseFiles(USER_A, WS_A);

			expect(internals.workspaceFile).toBe(WS_A);
		});

		it("does not refuse over a failed pull when the cache already holds the list", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			gist.down.add(WS_B);
			await internals.pullAll();
			expect(internals.pendingWorkspacePush).toBe(true);
			(internals.cacheStore as CopyingCacheStore).failingSaves.add(WS_B);

			await gateway.chooseFiles(USER_A, WS_A);

			expect(internals.workspaceFile).toBe(WS_A);
			expect(texts(internals.workspace.todos)).toEqual(["ws A one", "ws A two"]);
		});
	});

	describe("what the app is shown", () => {
		it("renders the picked list as soon as the switch completes", async () => {
			const reloads: StoreState[] = [];
			const sub = gateway.messages.subscribe((message: InboundMessage) => {
				if (message.type === MessageActionsToWebview.reloadWebview) {
					reloads.push(message.payload as StoreState);
				}
			});

			await gateway.chooseFiles(USER_A, WS_B);
			sub.unsubscribe();

			expect(reloads.length).toBeGreaterThan(0);
			expect(texts(reloads[reloads.length - 1].workspace.todos)).toEqual(["ws B one", "ws B two"]);
		});

		it("drops a failure banner about the file just left", async () => {
			gist.files[WS_A] = "not json";
			await internals.pullAll();
			let failure: SyncFailureState = { phase: "ok" };
			const sub = gateway.syncFailure.subscribe((state) => (failure = state));
			expect(failure.phase).toBe("failing");

			// B's reads are held so the check lands after the swap and before B's own pull, whose
			// success would clear the banner anyway and hide whether the switch did.
			const release = gist.hold(WS_B);
			const switching = gateway.chooseFiles(USER_A, WS_B);
			await until(() => internals.workspaceFile === WS_B, "the swap");
			const duringPull = failure.phase;
			release();
			await switching;
			sub.unsubscribe();

			expect(duringPull).toBe("ok");
		});

		it("does not call a list synced before it has been reached", async () => {
			gist.down.add(WS_B);

			await gateway.chooseFiles(USER_A, WS_B);

			expect(internals.workspaceStatus).not.toBe("synced");
		});
	});

	/**
	 * Review records name todos by id and per-file lists by path, and both are unique only within
	 * one gist file. A record applied to another list would write the old list's todo into it.
	 */
	describe("the review screen's records", () => {
		let views: PendingConflictView[];
		let sub: { unsubscribe(): void };

		beforeEach(() => {
			internals.pendingConflicts = [
				record("workspace:31", WS_A, "workspace", 31),
				{
					kind: "file",
					key: "file:src/a.ts",
					fileName: WS_A,
					filePath: "src/a.ts",
					conflictType: "file-edit-edit",
					base: [],
					local: [],
					remote: [todo(33, "remote")],
					resolvedValue: [],
					syncedAt: new Date().toISOString(),
				},
				record("user:11", USER_A, "user", 11),
			];
			internals.publishConflicts();
			views = [];
			sub = gateway.conflicts.subscribe((next) => (views = next));
		});

		afterEach(() => sub.unsubscribe());

		const keys = (): string[] => views.map((view) => view.conflict.key).sort();

		it("shows only the records of the lists selected now", async () => {
			expect(keys()).toEqual(["file:src/a.ts", "user:11", "workspace:31"]);

			await gateway.chooseFiles(USER_A, WS_B);

			expect(keys()).toEqual(["user:11"]);
		});

		it("brings the old list's records back when it is picked again", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			await gateway.chooseFiles(USER_A, WS_A);

			expect(keys()).toEqual(["file:src/a.ts", "user:11", "workspace:31"]);
		});

		it("never applies a record to a list it was not made against", async () => {
			await gateway.chooseFiles(USER_A, WS_B);

			expect(await gateway.applyConflictChoice("workspace:31", undefined, true)).toBe("missing");
			await internals.pullAll();

			expect(internals.workspace.todos.map((t) => t.id)).not.toContain(31);
			expect(gist.files[WS_B]).toBe(bWorkspace);
		});

		it("keeps the other list's records through Dismiss all", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			gateway.dismissAllConflicts();
			await gateway.chooseFiles(USER_A, WS_A);

			expect(keys()).toEqual(["file:src/a.ts", "workspace:31"]);
		});

		it("does not let a record on one list replace another list's record for the same id", async () => {
			await gateway.chooseFiles(USER_A, WS_B);
			internals.captureTodoConflicts("workspace", [
				{
					todoId: 31,
					base: todo(31, "b base"),
					local: todo(31, "b local"),
					remote: todo(31, "b remote"),
					conflictType: "edit-edit",
				},
			]);
			await gateway.chooseFiles(USER_A, WS_A);

			const a = views.find((view) => view.conflict.key === "workspace:31")!.conflict;
			expect(a.kind === "todo" && a.remote?.text).toBe("remote 31");
		});
	});

	/**
	 * Records saved by a build that did not tag them with a file were made against the selection
	 * of that session, which is the one restored at startup.
	 */
	describe("records saved before they carried a file", () => {
		/** A gateway started the way the app starts, from stored settings and stored records. */
		async function restart(
			conflictStore: FakeConflictStore,
			workspace: string
		): Promise<{ restored: GistGateway; views: () => PendingConflictView[] }> {
			const restored = new GistGateway({
				clientId: "test-client",
				deviceFlowProxyUrl: "https://example.invalid",
				pushDebounceMs: 60_000,
			});
			const r = restored as unknown as Internals;
			r.client = gist;
			r.cacheStore = new CopyingCacheStore();
			r.tokenStore = new FakeTokenStore({
				token: "stub-token",
				gistId: "stub-gist",
				userFile: USER_A,
				workspaceFile: workspace,
			});
			r.conflictStore = conflictStore;
			r.viewPreferencesStore = { load: async () => ({}) };
			let latest: PendingConflictView[] = [];
			restored.conflicts.subscribe((next) => (latest = next));
			await restored.restoreSession();
			return { restored, views: () => latest };
		}

		let conflictStore: FakeConflictStore;

		beforeEach(() => {
			const legacy = { ...record("workspace:31", WS_A, "workspace", 31) } as PendingConflict;
			delete (legacy as { fileName?: string }).fileName;
			conflictStore = new FakeConflictStore([legacy]);
		});

		it("assigns them to the files restored at startup", async () => {
			const { restored, views } = await restart(conflictStore, WS_A);
			try {
				expect(views().map((view) => view.conflict.fileName)).toEqual([WS_A]);

				await restored.chooseFiles(USER_A, WS_B);
				expect(views()).toEqual([]);
			} finally {
				teardown(restored);
			}
		});

		/**
		 * Assigned once, not at every startup: otherwise switching lists and restarting would
		 * re-assign an old list's record to the new one, and applying it would write the old
		 * list's todo into it.
		 */
		it("saves the assignment, so a restart on another list does not re-assign them", async () => {
			const first = await restart(conflictStore, WS_A);
			await first.restored.chooseFiles(USER_A, WS_B);
			teardown(first.restored);

			const second = await restart(conflictStore, WS_B);
			try {
				expect(conflictStore.stored.map((conflict) => conflict.fileName)).toEqual([WS_A]);
				expect(second.views()).toEqual([]);
			} finally {
				teardown(second.restored);
			}
		});
	});

	/**
	 * The file picker is on screen during a switch and covers the conflict dialog (same z-index,
	 * later in the document). Any reconcile that parked on a dialog then would hold the queue the
	 * switch waits on, and the app would freeze behind the picker with nothing to answer.
	 */
	describe("conflicts during a switch", () => {
		let prompts: ConflictPromptRequest[];
		let answer: ((request: ConflictPromptRequest) => ConflictDecisions | null) | undefined;
		let sub: { unsubscribe(): void };

		beforeEach(() => {
			prompts = [];
			answer = undefined;
			sub = gateway.conflictPrompt.subscribe((request) => {
				if (!request) {
					return;
				}
				prompts.push(request);
				if (answer) {
					gateway.answerConflictPrompt(answer(request));
				}
			});
		});

		afterEach(() => sub.unsubscribe());

		/** Both sides edit todo 31 in the old workspace file, so pushing it would conflict. */
		function divergeOldWorkspace(): void {
			gateway.editTodo(TodoScope.workspace, { id: 31, newText: "edited on this device" });
			gist.files[WS_A] = workspaceFile([todo(31, "edited elsewhere"), todo(32, "ws A two")], {
				"src/a.ts": [todo(33, "file todo in A")],
			});
		}

		it("does not ask while the picker is up, and still completes", async () => {
			divergeOldWorkspace();

			expect(await settles(gateway.chooseFiles(USER_A, WS_B))).toBe("done");
			expect(prompts.length).toBe(0);
			// Declining writes nothing: the other device's edit is still what the file holds.
			expect(gist.texts(WS_A)).toContain("edited elsewhere");
			expect(gist.files[WS_B]).toBe(bWorkspace);
		});

		it("keeps the declined edit, and asks about it when the list is picked again", async () => {
			divergeOldWorkspace();
			await gateway.chooseFiles(USER_A, WS_B);
			answer = (request) => ({
				todos: new Map([[request.todos[0].todoId, request.todos[0].local]]),
			});

			await gateway.chooseFiles(USER_A, WS_A);

			expect(prompts.length).toBe(1);
			expect(gist.texts(WS_A)).toContain("edited on this device");
		});

		it("releases a dialog already open behind the picker", async () => {
			divergeOldWorkspace();
			// A poll that raised a dialog after the picker opened: parked, and never answered.
			const parked = internals.enqueue(() => internals.reconcileWorkspace());
			await tick();
			expect(prompts.length).toBe(1);

			expect(await settles(gateway.chooseFiles(USER_A, WS_B))).toBe("done");
			await parked;
			expect(prompts.length).toBe(1);
			expect(gist.texts(WS_A)).toContain("edited elsewhere");
			expect(gist.files[WS_B]).toBe(bWorkspace);
			expect(texts(internals.workspace.todos)).toEqual(["ws B one", "ws B two"]);
		});
	});

	/**
	 * Once Ok is pressed the switch is queued and will land. A Cancel honoured in that window
	 * would show the old list and then change it under a user who had just said not to.
	 */
	it("ignores Cancel once a switch is under way", async () => {
		const release = gist.hold(WS_A);
		const inFlight = internals.enqueue(() => internals.reconcileWorkspace());
		await tick();
		const states: GistConnectionState[] = [];
		const sub = gateway.connection.subscribe((state) => states.push(state));
		states.length = 0;

		const switching = gateway.chooseFiles(USER_A, WS_B);
		expect(gateway.switchingFiles).toBe(true);
		gateway.cancelFileSelection();
		release();
		expect(await settles(Promise.all([inFlight, switching]))).toBe("done");
		sub.unsubscribe();

		expect(gateway.switchingFiles).toBe(false);
		expect(states.map((state) => state.phase === "connected" && state.workspaceFile)).toEqual([WS_B]);
	});

	/**
	 * A disconnect that starts while a switch is still waiting on the queue. The switch must not
	 * write its file names back after the session is gone, or the next connection would resume a
	 * selection from a gist that is no longer in use.
	 */
	it("abandons a switch that a disconnect overtook", async () => {
		const release = gist.hold(WS_A);
		const inFlight = internals.enqueue(() => internals.reconcileWorkspace());
		await tick();
		const states: GistConnectionState[] = [];
		const sub = gateway.connection.subscribe((state) => states.push(state));

		const switching = gateway.chooseFiles(USER_B, WS_B);
		const disconnecting = gateway.disconnectGitHub();
		release();
		expect(await settles(Promise.all([inFlight, switching, disconnecting]))).toBe("done");
		sub.unsubscribe();

		expect(internals.userFile).toBeUndefined();
		expect(internals.workspaceFile).toBeUndefined();
		expect(states[states.length - 1].phase).toBe("disconnected");
		const calls = (internals.tokenStore as FakeTokenStore).calls;
		expect(calls.slice(calls.lastIndexOf("clear") + 1)).toEqual([]);
	});
});

/**
 * An edit made through the real mutations while a reconcile is on the network.
 *
 * `addTodo`, `deleteTodo` and `editTodo` change the slice in place — `unshift`, `splice`, a todo's
 * own fields. The reconcile used to hand the engine `{ userTodos: this.user.todos }`, the live
 * array, so its "snapshot" took on any edit made after it was taken. When the edit landed after
 * the engine had compared (while the cache write was pending) the re-merge compared the edit with
 * itself, saw no local change and a gist without it, and dropped it — or, for a delete, read the
 * gist's copy as a remote add and brought the todo back.
 *
 * The suites that cover the generation counter assign fresh arrays into the slice, which never
 * shares anything with the snapshot, so none of them could see it. These go through the public
 * mutations and park the reconcile's cache write, the one moment the window is open.
 */
describe("GistGateway edits made while a sync is on the network", () => {
	let gist: FakeGist;
	let store: CopyingCacheStore;
	let gateway: GistGateway;
	let internals: Internals;

	beforeEach(async () => {
		gist = new FakeGist({
			[USER_A]: userFile(todo(11, "user A one"), todo(12, "user A two")),
			[WS_A]: workspaceFile([todo(31, "ws A one")], { "src/a.ts": [todo(33, "file todo in A")] }),
		});
		store = new CopyingCacheStore();
		({ gateway, internals } = createGateway(gist, store));
		await gateway.chooseFiles(USER_A, WS_A);
	});

	afterEach(() => teardown(gateway));

	/** Runs `reconcile`, applies `edit` while its cache write is parked, then lets it finish. */
	async function editDuringCacheWrite(
		reconcile: () => Promise<void>,
		edit: () => void
	): Promise<void> {
		const parked = store.holdNextSave();
		const inFlight = internals.enqueue(reconcile);
		await parked.reached;
		edit();
		parked.release();
		expect(await settles(inFlight)).toBe("done");
		// Whatever the edit still owes the gist goes out with the next sync.
		await internals.pullAll();
	}

	it("keeps a todo added through addTodo", async () => {
		await editDuringCacheWrite(
			() => internals.reconcileUser(),
			() => gateway.addTodo(TodoScope.user, { text: "added mid-flight" })
		);

		expect(texts(internals.user.todos)).toContain("added mid-flight");
		expect(gist.texts(USER_A)).toContain("added mid-flight");
	});

	it("keeps an edit made through editTodo", async () => {
		await editDuringCacheWrite(
			() => internals.reconcileUser(),
			() => gateway.editTodo(TodoScope.user, { id: 11, newText: "edited mid-flight" })
		);

		expect(texts(internals.user.todos)).toContain("edited mid-flight");
		expect(gist.texts(USER_A)).toContain("edited mid-flight");
		expect(gist.texts(USER_A)).not.toContain("user A one");
	});

	it("does not bring back a todo deleted through deleteTodo", async () => {
		await editDuringCacheWrite(
			() => internals.reconcileUser(),
			() => gateway.deleteTodo(TodoScope.user, { id: 12 })
		);

		expect(texts(internals.user.todos)).not.toContain("user A two");
		expect(gist.texts(USER_A)).not.toContain("user A two");
	});

	it("keeps a workspace todo added through addTodo", async () => {
		await editDuringCacheWrite(
			() => internals.reconcileWorkspace(),
			() => gateway.addTodo(TodoScope.workspace, { text: "ws added mid-flight" })
		);

		expect(gist.texts(WS_A)).toContain("ws added mid-flight");
	});

	/**
	 * After the first per-file edit, `filesData`'s entry for the open file *is* `currentFile.todos`,
	 * so the next edit changes the snapshot's per-file list in place too.
	 */
	it("keeps a per-file todo added while the workspace file syncs", async () => {
		gateway.setCurrentFile("src/a.ts");
		gateway.addTodo(TodoScope.currentFile, { text: "first file edit" });
		await internals.pullAll();

		await editDuringCacheWrite(
			() => internals.reconcileWorkspace(),
			() => gateway.addTodo(TodoScope.currentFile, { text: "file todo added mid-flight" })
		);

		expect(texts(gist.filesDataOf(WS_A)["src/a.ts"] ?? [])).toEqual(
			jasmine.arrayWithExactContents([
				"file todo added mid-flight",
				"first file edit",
				"file todo in A",
			])
		);
	});

	/**
	 * A reconcile that pulls another device's per-file todo, and has an edit of its own to fold in,
	 * re-persists before it finishes — an IndexedDB write a tap can land in. The open file was
	 * re-projected only after that write, so an edit to it in the meantime wrote the stale list
	 * back into `filesData`, and the next push deleted the other device's todo from the gist.
	 */
	/**
	 * The same window as the test below, reached by a drag instead of an edit: `reorderTodo`
	 * replaces the list with the one the screen holds. A screen still showing the pre-pull list
	 * when the drop lands wrote it back, and the next push deleted what the pull brought in.
	 */
	it("keeps another device's todo through a reorder dropped while a pull re-persists", async () => {
		let onScreen: Todo[] = [];
		const sub = gateway.messages.subscribe((message: InboundMessage) => {
			if (message.type === MessageActionsToWebview.reloadWebview) {
				onScreen = (message.payload as StoreState).workspace.todos;
			} else if (
				message.type === MessageActionsToWebview.syncTodoData &&
				(message.payload as { scope: TodoScope }).scope === TodoScope.workspace
			) {
				onScreen = (message.payload as { todos: Todo[] }).todos;
			}
		});
		gist.files[WS_A] = workspaceFile([todo(31, "ws A one"), todo(35, "from the other device")], {
			"src/a.ts": [todo(33, "file todo in A")],
		});
		const release = gist.hold(WS_A);
		const inFlight = internals.enqueue(() => internals.reconcileWorkspace());
		await tick();
		gateway.addTodo(TodoScope.workspace, { text: "edit mid-flight" });
		await tick();
		const parked = store.holdNextSave((cache) => cache.isDirty);
		release();
		await parked.reached;
		// The drop, during the re-persist, carrying whatever the screen shows.
		gateway.reorderTodos(TodoScope.workspace, { reorderedTodos: [...onScreen].reverse() });
		parked.release();
		expect(await settles(inFlight)).toBe("done");
		await internals.pullAll();
		sub.unsubscribe();

		expect(gist.texts(WS_A)).toEqual(
			jasmine.arrayWithExactContents(["edit mid-flight", "ws A one", "from the other device"])
		);
	});

	/**
	 * An import applied its user half, awaited that save, and only then its workspace half —
	 * merged from the state before the await. A pull adopted in between was overwritten, and
	 * the next push deleted it from the gist.
	 */
	it("keeps a pull that lands while an import saves its first half", async () => {
		gist.files[WS_A] = workspaceFile([todo(31, "ws A one"), todo(36, "remote ws")], {
			"src/a.ts": [todo(33, "file todo in A")],
		});
		// The pull gets as far as its cache write, which holds the store...
		const pullWrite = store.holdNextSave((cache) => !cache.isDirty);
		const inFlight = internals.enqueue(() => internals.reconcileWorkspace());
		await pullWrite.reached;
		// ...so the import, started now, queues its first save behind it.
		const importSave = store.holdNextSave((cache) => cache.isDirty);
		const importing = (
			internals as unknown as {
				applyImport(data: unknown, fileName: string): Promise<void>;
			}
		).applyImport(
			{ user: [{ text: "imported user" }], workspace: [{ text: "imported ws" }] },
			"backup.json"
		);
		// The pull lands and adopts while the import's save is still pending.
		pullWrite.release();
		await importSave.reached;
		await until(
			() => texts(internals.workspace.todos).includes("remote ws"),
			"the pull adopting its result"
		);
		importSave.release();
		expect(await settles(Promise.all([importing, inFlight]))).toBe("done");
		await internals.pullAll();

		expect(gist.texts(WS_A)).toEqual(
			jasmine.arrayWithExactContents(["imported ws", "ws A one", "remote ws"])
		);
		expect(gist.texts(USER_A)).toContain("imported user");
	});

	/**
	 * An import used to await its save before arming the push. A save that threw rejected the
	 * whole import with its todos already on screen: "The import failed", nothing marked owed,
	 * and the indicator still reading synced over changes that were nowhere but memory.
	 */
	it("still owes the gist an import whose save fails, and says the save failed", async () => {
		store.failingSaves.add(USER_A);
		store.failingSaves.add(WS_A);
		let failure = { phase: "ok" } as SyncFailureState;
		const sub = gateway.syncFailure.subscribe((state) => (failure = state));

		await expectAsync(
			(
				internals as unknown as {
					applyImport(data: unknown, fileName: string): Promise<void>;
				}
			).applyImport(
				{ user: [{ text: "imported user" }], workspace: [{ text: "imported ws" }] },
				"backup.json"
			)
		).toBeResolved();
		await until(() => failure.phase === "failing", "the persist failure being reported");
		sub.unsubscribe();

		expect(internals.pendingUserPush).toBe(true);
		expect(internals.pendingWorkspacePush).toBe(true);
		expect(failure.phase === "failing" && failure.message).toContain("could not save");
		// And the import still reaches the gist.
		store.failingSaves.clear();
		await internals.pullAll();
		expect(gist.texts(USER_A)).toContain("imported user");
		expect(gist.texts(WS_A)).toContain("imported ws");
	});

	it("keeps another device's per-file todo through an edit to the open file mid-pull", async () => {
		gateway.setCurrentFile("src/a.ts");
		gist.files[WS_A] = workspaceFile([todo(31, "ws A one")], {
			"src/a.ts": [todo(33, "file todo in A"), todo(34, "from the other device")],
		});
		const release = gist.hold(WS_A);
		const inFlight = internals.enqueue(() => internals.reconcileWorkspace());
		await tick();
		// An edit while the pull is on the network, so it has one to fold in and re-persists.
		gateway.addTodo(TodoScope.workspace, { text: "ws edit mid-flight" });
		await tick();
		const parked = store.holdNextSave((cache) => cache.isDirty);
		release();
		await parked.reached;
		// The tap, during the re-persist.
		gateway.addTodo(TodoScope.currentFile, { text: "open file edit" });
		parked.release();
		expect(await settles(inFlight)).toBe("done");
		await internals.pullAll();

		expect(texts(gist.filesDataOf(WS_A)["src/a.ts"] ?? [])).toEqual(
			jasmine.arrayWithExactContents(["open file edit", "file todo in A", "from the other device"])
		);
		expect(texts(internals.currentFile.todos)).toContain("from the other device");
	});
});

/**
 * Review records filed by a real reconcile.
 *
 * A conflict left undecided in the prompt is settled by prefer-local and filed for review, with
 * the local version as what was applied. The engine builds the merged list from those same todo
 * objects and the slice adopts it, so the record used to share them with the list: an in-place
 * edit afterwards changed the record too, `isStale` compared the todo with itself, and "keep
 * everything from the other device" overwrote the later edit without skipping it.
 */
describe("GistGateway review records filed by a real sync", () => {
	let gist: FakeGist;
	let gateway: GistGateway;
	let internals: Internals;
	let views: PendingConflictView[];
	let subs: Array<{ unsubscribe(): void }>;

	beforeEach(async () => {
		gist = new FakeGist({
			[USER_A]: userFile(todo(11, "base")),
			[WS_A]: workspaceFile([]),
		});
		({ gateway, internals } = createGateway(gist));
		await gateway.chooseFiles(USER_A, WS_A);
		views = [];
		subs = [
			gateway.conflicts.subscribe((next) => (views = next)),
			// Shown and left undecided: prefer-local applies, and the conflict is filed.
			gateway.conflictPrompt.subscribe((request) => {
				if (request) {
					gateway.answerConflictPrompt({});
				}
			}),
		];
		gateway.editTodo(TodoScope.user, { id: 11, newText: "mine" });
		gist.files[USER_A] = userFile(todo(11, "theirs"));
		await internals.pullAll();
		expect(views.length).toBe(1);
	});

	afterEach(() => {
		subs.forEach((sub) => sub.unsubscribe());
		teardown(gateway);
	});

	it("marks the record stale once the todo is edited again", () => {
		gateway.editTodo(TodoScope.user, { id: 11, newText: "mine, edited after the sync" });

		expect(views[0].stale).toBe(true);
		const filed = views[0].conflict;
		expect(filed.kind === "todo" && filed.resolvedValue?.text).toBe("mine");
	});

	it("skips that record in keep-everything-from-the-other-device", async () => {
		gateway.editTodo(TodoScope.user, { id: 11, newText: "mine, edited after the sync" });

		expect(await gateway.keepAllFromOtherDevice()).toEqual({ applied: 0, skipped: 1 });
		expect(texts(internals.user.todos)).toEqual(["mine, edited after the sync"]);
	});
});

/**
 * Model-based: a seeded random walk over local edits, per-file lists, edits by another device,
 * dropped connections, syncs fired and left running, and list switches — often with an edit
 * still unsynced, a sync still on the network, or the old list unreachable.
 *
 * Scheduling follows the browser, so every interleaving it finds is one a user can reach. Each
 * gist call and each cache read or write resolves on a macrotask, as `fetch` and IndexedDB do,
 * after a random number of them; and each step — a user's tap, another device's push — runs
 * between macrotasks, as an input event does. A step can therefore land while a sync is waiting
 * on the network or on storage, but never inside a stretch of synchronous or microtask-only work,
 * which no real event can interrupt either.
 *
 * Two properties are checked:
 *
 *  - **After every step, mid-flight or not:** no file on the gist, and no list on screen,
 *    holds a todo that was never added to *that* file. That is the whole class of bug this
 *    suite is about, whatever path puts the todo there — a slice carried across a switch, a
 *    late reconcile landing in the wrong slice, a per-file list left behind.
 *  - **Whenever the walk settles** (network back, everything drained, a sync run) the lists
 *    selected now match the model exactly; at the end, after visiting every file, all do. So
 *    nothing is lost either, including an edit left behind on a list that could not be reached.
 *
 * The model is deliberately dumb: a set of texts per file, where a local edit belongs to
 * whichever file its scope had selected *when it was made*. Only adds and deletes of top-level
 * todos, and adds to per-file lists another device already has, so no step can produce a
 * conflict the model would have to adjudicate; any prompt is answered with no decisions.
 */
describe("GistGateway list switching, model-based", () => {
	const USER_FILES = [USER_A, USER_B, "user-c.json"];
	const WORKSPACE_FILES = [WS_A, WS_B, WS_C, "workspace-d.json"];
	const PATHS = ["src/one.ts", "src/two.ts"];
	// Fixed seeds, so a failure reproduces exactly: its message lists every step taken. The walk
	// is cheap (a few ms a seed) and was run against 2000 more seeds of up to 300 steps before
	// these were settled on; raise both locally when changing the sync paths.
	const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
	const STEPS = 120;

	/** mulberry32: small, seedable, good enough to pick operations. */
	function rng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/** One gist file's contents in the model: top-level texts, and per-file lists by path. */
	interface FileModel {
		todos: Set<string>;
		files: Map<string, Set<string>>;
	}
	const emptyModel = (): FileModel => ({ todos: new Set(), files: new Map() });
	const cloneModel = (m: FileModel): FileModel => ({
		todos: new Set(m.todos),
		files: new Map([...m.files].map(([path, set]) => [path, new Set(set)])),
	});

	for (const seed of SEEDS) {
		it(`keeps every file to its own todos (seed ${seed})`, async () => {
			const random = rng(seed);
			// Separate stream, so how the calls interleave cannot shift which operations are picked.
			const jitter = rng(seed * 7919);
			const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
			let counter = 0;
			let nextId = 1000;
			const log: string[] = [];

			const cacheStore = new CopyingCacheStore(() => 1 + Math.floor(jitter() * 2));
			const gist = new FakeGist(
				{
					[USER_A]: userFile(todo(nextId++, "seed user A")),
					[USER_B]: userFile(todo(nextId++, "seed user B")),
					[WS_A]: workspaceFile([todo(nextId++, "seed ws A")], {
						[PATHS[0]]: [todo(nextId++, "seed file todo A")],
					}),
					[WS_B]: workspaceFile([todo(nextId++, "seed ws B")], {
						[PATHS[1]]: [todo(nextId++, "seed file todo B")],
					}),
				},
				() => 1 + Math.floor(jitter() * 3)
			);
			// What each file should hold, and everything ever added to it (for the leak check).
			const model = new Map<string, FileModel>([
				[USER_A, { todos: new Set(["seed user A"]), files: new Map() }],
				[USER_B, { todos: new Set(["seed user B"]), files: new Map() }],
				[
					WS_A,
					{ todos: new Set(["seed ws A"]), files: new Map([[PATHS[0], new Set(["seed file todo A"])]]) },
				],
				[
					WS_B,
					{ todos: new Set(["seed ws B"]), files: new Map([[PATHS[1], new Set(["seed file todo B"])]]) },
				],
			]);
			const ever = new Map([...model].map(([file, m]) => [file, cloneModel(m)]));
			const entry = (map: Map<string, FileModel>, file: string): FileModel => {
				if (!map.has(file)) {
					map.set(file, emptyModel());
				}
				return map.get(file)!;
			};
			const addTo = (file: string, text: string, path?: string): void => {
				for (const map of [model, ever]) {
					const m = entry(map, file);
					if (path) {
						if (!m.files.has(path)) {
							m.files.set(path, new Set());
						}
						m.files.get(path)!.add(text);
					} else {
						m.todos.add(text);
					}
				}
			};

			const { gateway, internals } = createGateway(gist, cacheStore);
			const sub = gateway.conflictPrompt.subscribe((request) => {
				if (request) {
					gateway.answerConflictPrompt({});
				}
			});
			let outstanding: Array<Promise<unknown>> = [];

			const context = (): string => `seed ${seed}, after: ${log.join(" → ")}`;

			/** No todo anywhere that was never added to the file it is in. */
			const expectNoForeignTodos = (): void => {
				const foreign = (where: string, found: string[], allowed: Set<string> | undefined): void => {
					const stray = found.filter((text) => !allowed?.has(text));
					expect(stray).withContext(`${context()}\n${where} holds todos never added to it`).toEqual([]);
				};
				for (const file of Object.keys(gist.files)) {
					const allowed = ever.get(file);
					foreign(`${file} on the gist`, gist.texts(file), allowed?.todos);
					for (const [path, list] of Object.entries(gist.filesDataOf(file))) {
						foreign(`${file} → ${path} on the gist`, texts(list ?? []), allowed?.files.get(path));
					}
				}
				const user = ever.get(internals.userFile!);
				foreign(
					`user list on screen (${internals.userFile})`,
					texts(internals.user.todos),
					user?.todos
				);
				const workspace = ever.get(internals.workspaceFile!);
				foreign(
					`workspace list on screen (${internals.workspaceFile})`,
					texts(internals.workspace.todos),
					workspace?.todos
				);
				for (const [path, list] of Object.entries(internals.filesData)) {
					foreign(
						`${internals.workspaceFile} → ${path} in memory`,
						texts(list ?? []),
						workspace?.files.get(path)
					);
				}
				if (internals.currentFile.filePath) {
					foreign(
						`open file ${internals.currentFile.filePath}`,
						texts(internals.currentFile.todos),
						workspace?.files.get(internals.currentFile.filePath)
					);
				}
			};

			/** A file on the gist, and (when selected) on screen, matches the model exactly. */
			const expectMatches = (file: string): void => {
				const m = model.get(file) ?? emptyModel();
				expect(file in gist.files)
					.withContext(`${context()}\n${file} exists`)
					.toBe(true);
				expect(new Set(gist.texts(file)))
					.withContext(`${context()}\n${file} on the gist`)
					.toEqual(m.todos);
				if (file.startsWith("workspace-")) {
					const onGist = new Map(
						Object.entries(gist.filesDataOf(file)).map(([path, list]) => [
							path,
							new Set(texts(list ?? [])),
						])
					);
					expect(onGist)
						.withContext(`${context()}\n${file} per-file lists on the gist`)
						.toEqual(m.files);
				}
				if (file === internals.userFile) {
					expect(new Set(texts(internals.user.todos)))
						.withContext(`${context()}\nuser list on screen`)
						.toEqual(m.todos);
				}
				if (file === internals.workspaceFile) {
					expect(new Set(texts(internals.workspace.todos)))
						.withContext(`${context()}\nworkspace list on screen`)
						.toEqual(m.todos);
				}
			};

			/** Network back, every sync fired so far finished, then one more sync. */
			const settle = async (): Promise<void> => {
				gist.down.clear();
				await Promise.all(outstanding);
				outstanding = [];
				await internals.pullAll();
			};

			try {
				await gateway.chooseFiles(USER_A, WS_A);
				log.push(`pick ${USER_A} ${WS_A}`);
				expectNoForeignTodos();

				for (let step = 0; step < STEPS; step++) {
					const roll = random();
					if (roll < 0.22) {
						// Local add to a top-level list, owed to the file selected right now.
						const scope = random() < 0.5 ? TodoScope.user : TodoScope.workspace;
						const file = scope === TodoScope.user ? internals.userFile! : internals.workspaceFile!;
						const text = `local ${counter++}`;
						gateway.addTodo(scope, { text });
						addTo(file, text);
						log.push(`add "${text}" to ${file}`);
					} else if (roll < 0.3) {
						// Local add to a per-file list, opening one first if none is.
						if (!internals.currentFile.filePath || random() < 0.3) {
							const path = pick(PATHS);
							gateway.setCurrentFile(path);
							log.push(`open ${path}`);
						}
						const text = `local ${counter++}`;
						gateway.addTodo(TodoScope.currentFile, { text });
						addTo(internals.workspaceFile!, text, internals.currentFile.filePath);
						log.push(`add "${text}" to ${internals.workspaceFile} → ${internals.currentFile.filePath}`);
					} else if (roll < 0.38) {
						// Local delete of something on screen.
						const scope = random() < 0.5 ? TodoScope.user : TodoScope.workspace;
						const slice = scope === TodoScope.user ? internals.user : internals.workspace;
						const file = scope === TodoScope.user ? internals.userFile! : internals.workspaceFile!;
						if (slice.todos.length > 0) {
							const victim = pick(slice.todos);
							gateway.deleteTodo(scope, { id: victim.id });
							model.get(file)?.todos.delete(victim.text);
							log.push(`delete "${victim.text}" from ${file}`);
						}
					} else if (roll < 0.5) {
						// Another device adds to a file that exists on the gist, selected or not.
						const file = pick(Object.keys(gist.files));
						const text = `remote ${counter++}`;
						const data = JSON.parse(gist.files[file]) as Partial<GlobalGistData & WorkspaceGistData>;
						if (file.startsWith("user-")) {
							gist.files[file] = userFile(...(data.userTodos ?? []), todo(nextId++, text));
							addTo(file, text);
							log.push(`remote add "${text}" to ${file}`);
						} else {
							const filesData = { ...(data.filesData ?? {}) };
							const paths = Object.keys(filesData);
							if (paths.length > 0 && random() < 0.4) {
								// Only to a per-file list the gist already has, so no step can create the
								// same path on both sides at once — a conflict the model cannot judge.
								const path = pick(paths);
								filesData[path] = [...(filesData[path] ?? []), todo(nextId++, text)];
								gist.files[file] = workspaceFile(data.workspaceTodos ?? [], filesData);
								addTo(file, text, path);
								log.push(`remote add "${text}" to ${file} → ${path}`);
							} else {
								gist.files[file] = workspaceFile(
									[...(data.workspaceTodos ?? []), todo(nextId++, text)],
									filesData
								);
								addTo(file, text);
								log.push(`remote add "${text}" to ${file}`);
							}
						}
					} else if (roll < 0.56) {
						// A dropped connection to one file, or its recovery.
						const file = pick([...USER_FILES, ...WORKSPACE_FILES]);
						if (gist.down.has(file)) {
							gist.down.delete(file);
							log.push(`${file} back`);
						} else {
							gist.down.add(file);
							log.push(`${file} down`);
						}
					} else if (roll < 0.66) {
						// A poll, or a debounced push, fired and left running.
						if (random() < 0.5) {
							outstanding.push(internals.pullAll());
							log.push("poll fired");
						} else {
							const workspace = random() < 0.5;
							outstanding.push(
								internals.enqueue(() =>
									workspace ? internals.reconcileWorkspace() : internals.reconcileUser()
								)
							);
							log.push(`${workspace ? "workspace" : "user"} push fired`);
						}
					} else if (roll < 0.86) {
						// Switch — the picker covers the app, so nothing else happens until it is done.
						const nextUser = pick(USER_FILES);
						const nextWorkspace = pick(WORKSPACE_FILES);
						log.push(`pick ${nextUser} ${nextWorkspace}`);
						await gateway.chooseFiles(nextUser, nextWorkspace);
						entry(model, nextUser);
						entry(model, nextWorkspace);
						entry(ever, nextUser);
						entry(ever, nextWorkspace);
					} else if (roll < 0.92) {
						log.push("settle");
						await settle();
						expectNoForeignTodos();
						expectMatches(internals.userFile!);
						expectMatches(internals.workspaceFile!);
					}
					// Let whatever is still running get part of the way before the next step.
					for (let i = Math.floor(random() * 4); i > 0; i--) {
						await macrotask();
					}
					expectNoForeignTodos();
				}

				// Visit every file with the network up, so anything left behind on one is pushed.
				log.push("final settle");
				await settle();
				const visits = Math.max(USER_FILES.length, WORKSPACE_FILES.length);
				for (let i = 0; i < visits; i++) {
					await gateway.chooseFiles(
						USER_FILES[i % USER_FILES.length],
						WORKSPACE_FILES[i % WORKSPACE_FILES.length]
					);
					entry(model, USER_FILES[i % USER_FILES.length]);
					entry(model, WORKSPACE_FILES[i % WORKSPACE_FILES.length]);
				}
				await internals.pullAll();
				expectNoForeignTodos();
				for (const file of model.keys()) {
					expectMatches(file);
				}
			} finally {
				sub.unsubscribe();
				teardown(gateway);
			}
		}, 30_000);
	}
});

/**
 * Switching to another GIST.
 *
 * A list switch settles what the old file is owed first (push it, save it, or refuse). A gist
 * switch used to do none of that: `resetForNewGist` cancelled the owed pushes, cleared the whole
 * sync cache and emptied the slices. So an edit made in the debounce window before "Change gist"
 * was gone from this device and never reached the gist it was made in.
 */
describe("GistGateway switching gists", () => {
	const CURRENT_GIST = "a".repeat(32);
	const OTHER_GIST = "c".repeat(32);

	/** The fake gist, plus the calls the gist picker makes. */
	class PickerGist extends FakeGist {
		async fetchGist(id: string) {
			return { success: true as const, data: { id, files: {} } };
		}
		async listFiles() {
			return { success: true as const, data: [] };
		}
	}

	let gist: PickerGist;
	let gateway: GistGateway;
	let internals: Internals;

	beforeEach(async () => {
		gist = new PickerGist({
			[USER_A]: userFile(todo(11, "user A one")),
			[WS_A]: workspaceFile([todo(31, "ws A one")]),
		});
		({ gateway, internals } = createGateway(gist));
		// A real-looking id, so the picker's validation lets a same-gist pick through.
		internals.gistId = CURRENT_GIST;
		internals.tokenStore = Object.assign(new FakeTokenStore(), { setGistId: async () => undefined });
		await gateway.chooseFiles(USER_A, WS_A);
		gist.writes.length = 0;
	});

	afterEach(() => teardown(gateway));

	it("control: picking the same gist again keeps the lists and the owed edit", async () => {
		gateway.addTodo(TodoScope.user, { text: "kept" });

		await gateway.selectGist(CURRENT_GIST);

		expect(internals.gistId).toBe(CURRENT_GIST);
		expect(texts(internals.user.todos)).toContain("kept");
		expect(internals.pendingUserPush).toBe(true);
	});

	it("an edit made just before switching gists reaches the gist it was made in", async () => {
		gateway.addTodo(TodoScope.user, { text: "added right before switching gists" });

		await gateway.selectGist(OTHER_GIST);

		expect(gist.texts(USER_A)).toContain("added right before switching gists");
		expect(internals.gistId).toBe(OTHER_GIST);
	});
});

/**
 * A gist switch when the gist being left cannot take what the device holds.
 *
 * The "gist not found" banner says the todos are still on this device and offers "Choose a gist",
 * which used to lead straight into the reset above: the lists were emptied, the cache cleared,
 * and the device's only copy was gone — through "Create new" too. Now a gist that can never take
 * them (deleted, unreadable, rejecting) has its lists carried over and added to the files picked
 * in the new gist. A gist that still could — a dropped connection — refuses the switch instead,
 * so the edit reaches the gist it was made in.
 *
 * Over an account of several gists: the single-gist fake above cannot tell one gist's files from
 * another's, so it cannot show which gist a list ended up in.
 */
describe("GistGateway switching away from a gist that cannot take the lists", () => {
	const GIST_A = "a".repeat(32);
	const GIST_B = "b".repeat(32);
	const CREATED_GIST = "d".repeat(32);
	const CARRIED = "carriedOver";

	class GistAccount {
		readonly gists = new Map<string, Record<string, string>>();
		/** Gists whose reads and writes fail as a dropped connection would. */
		readonly down = new Set<string>();
		created = 0;
		failCreate = false;
		private gate: Promise<void> | undefined;

		/** Parks every read and write until the returned function is called. */
		hold(): () => void {
			let release!: () => void;
			this.gate = new Promise<void>((resolve) => (release = resolve));
			return () => {
				this.gate = undefined;
				release();
			};
		}

		private reach(gistId: string): { files: Record<string, string> } | { failed: SyncResult<never> } {
			if (this.down.has(gistId)) {
				return { failed: failure(SyncErrorType.NetworkError, "unreachable", true) };
			}
			const files = this.gists.get(gistId);
			return files
				? { files }
				: { failed: failure(SyncErrorType.NotFoundError, "gist not found", false) };
		}

		async readFile(gistId: string, name: string): Promise<SyncResult<string>> {
			await macrotask();
			await this.gate;
			const reached = this.reach(gistId);
			if ("failed" in reached) {
				return reached.failed;
			}
			const { files } = reached;
			if (!(name in files)) {
				return failure(SyncErrorType.FileNotFoundError, `${name} not found`, false);
			}
			return { success: true, data: files[name] };
		}

		async writeFile(gistId: string, name: string, content: string): Promise<SyncResult<unknown>> {
			await macrotask();
			const reached = this.reach(gistId);
			if ("failed" in reached) {
				return reached.failed;
			}
			reached.files[name] = content;
			return { success: true, data: {} };
		}

		async fetchGist(id: string) {
			return this.gists.has(id)
				? { success: true as const, data: { id, files: {} } }
				: failure(SyncErrorType.NotFoundError, "gist not found", false);
		}

		async listFiles(gistId: string, kind: "user" | "workspace") {
			if (!this.gists.has(gistId)) {
				return failure(SyncErrorType.NotFoundError, "gist not found", false);
			}
			const names = Object.keys(this.gists.get(gistId) ?? {}).filter((n) =>
				n.startsWith(`${kind}-`)
			);
			return {
				success: true as const,
				data: names.map((fullPath) => ({ fullPath, displayName: fullPath, size: 0 })),
			};
		}

		async listGists() {
			return { success: true as const, data: [] };
		}

		async createGist(_description: string, files: Record<string, string>) {
			if (this.failCreate) {
				return failure(SyncErrorType.NetworkError, "could not create", true);
			}
			this.created++;
			this.gists.set(CREATED_GIST, { ...files });
			return { success: true as const, data: { id: CREATED_GIST } };
		}

		private parse(gistId: string, name: string): Partial<GlobalGistData & WorkspaceGistData> {
			return JSON.parse(this.gists.get(gistId)?.[name] ?? "{}") as Partial<
				GlobalGistData & WorkspaceGistData
			>;
		}

		/** The todo texts a file holds — empty for a file that is not there. */
		texts(gistId: string, name: string): string[] {
			const parsed = this.parse(gistId, name);
			return (parsed.userTodos ?? parsed.workspaceTodos ?? []).map((t) => t.text);
		}

		filesDataOf(gistId: string, name: string): TodoFilesData {
			return this.parse(gistId, name).filesData ?? {};
		}
	}

	/** Keeps what it is given, as IndexedDB does, so a second gateway can restore from it. */
	class SessionStore {
		constructor(public stored: Record<string, string | undefined>) {}
		async getToken() {
			return this.stored["token"];
		}
		async getGistId() {
			return this.stored["gistId"];
		}
		async getUserFile() {
			return this.stored["userFile"];
		}
		async getWorkspaceFile() {
			return this.stored["workspaceFile"];
		}
		async setGistId(id: string) {
			this.stored["gistId"] = id;
		}
		async setUserFile(name: string) {
			this.stored["userFile"] = name;
		}
		async setWorkspaceFile(name: string) {
			this.stored["workspaceFile"] = name;
		}
		async clearFileSelections() {
			delete this.stored["userFile"];
			delete this.stored["workspaceFile"];
		}
		async clear() {
			this.stored = {};
		}
	}

	let account: GistAccount;
	let cacheStore: CopyingCacheStore;
	let session: SessionStore;
	let gateway: GistGateway;
	let internals: Internals;

	/** A gateway over the shared account and storage — a second call is a reload. */
	function open(): { gateway: GistGateway; internals: Internals } {
		const opened = createGateway(account as unknown as FakeGist, cacheStore);
		opened.internals.gistId = GIST_A;
		opened.internals.engine = opened.internals.createEngine(GIST_A);
		opened.internals.tokenStore = session;
		opened.internals.viewPreferencesStore = {
			load: async () => ({}),
			save: async () => undefined,
		};
		return opened;
	}

	/** Closes the gateway and opens another over the same storage, as a reload does. */
	async function reload(): Promise<GistConnectionState> {
		teardown(gateway);
		({ gateway, internals } = open());
		return gateway.restoreSession();
	}

	const connection = (): GistConnectionState =>
		(gateway as unknown as { _connection: { value: GistConnectionState } })._connection.value;
	const syncFailure = (): SyncFailureState =>
		(gateway as unknown as { _syncFailure: { value: SyncFailureState } })._syncFailure.value;

	/** A carried-over record as a switch writes it; `sources` are the files it names. */
	const carriedRecord = (
		from: string,
		carried: Partial<GlobalGistData & WorkspaceGistData>,
		sources: { user?: string; workspace?: string } = {}
	) => ({
		data: {
			fromGistId: from,
			fromUserFile: sources.user,
			fromWorkspaceFile: sources.workspace,
			user: carried.userTodos ? { userTodos: carried.userTodos } : undefined,
			workspace: carried.workspaceTodos
				? { workspaceTodos: carried.workspaceTodos, filesData: {}, filesDataPaths: {} }
				: undefined,
		},
		lastSynced: new Date(0).toISOString(),
		isDirty: true,
	});

	beforeEach(async () => {
		account = new GistAccount();
		account.gists.set(GIST_A, {
			[USER_A]: userFile(todo(11, "user A one")),
			[WS_A]: workspaceFile([todo(31, "ws A one")], { "src/a.ts": [todo(41, "file a one")] }),
		});
		account.gists.set(GIST_B, { [USER_B]: userFile(todo(21, "user B one")) });
		cacheStore = new CopyingCacheStore();
		session = new SessionStore({ token: "stub-token", gistId: GIST_A });
		({ gateway, internals } = open());
		await gateway.chooseFiles(USER_A, WS_A);
	});

	afterEach(() => teardown(gateway));

	/** Gist A disappears, and this device finds out on its next pull. */
	async function deleteGistA(): Promise<void> {
		account.gists.delete(GIST_A);
		await internals.pullAll();
	}

	it("brings a deleted gist's lists, and the edit it never took, to the files picked in the next gist", async () => {
		account.gists.delete(GIST_A);
		gateway.addTodo(TodoScope.user, { text: "added after the gist was deleted" });
		await internals.pullAll();

		await gateway.selectGist(GIST_B);
		expect(connection()).toEqual(
			jasmine.objectContaining({ phase: "needs-files", carryingOver: true })
		);
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents([
				"user B one",
				"user A one",
				"added after the gist was deleted",
			])
		);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
		expect(Object.keys(account.filesDataOf(GIST_B, WS_B))).toEqual(["src/a.ts"]);
		expect(internals.pendingUserPush).toBe(false);
		expect(internals.pendingWorkspacePush).toBe(false);
	});

	it("notices a gist deleted since the last pull, with nothing owed to it", async () => {
		account.gists.delete(GIST_A);

		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
	});

	it("carries only the scope whose file cannot be read", async () => {
		account.gists.get(GIST_A)![USER_A] = "{ not json";
		await internals.pullAll();

		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
		// The workspace file was readable and holds its list; nothing of it is brought along.
		expect(account.texts(GIST_B, WS_B)).toEqual([]);
	});

	it("carries them into a gist made with Create new", async () => {
		await deleteGistA();
		await gateway.changeGist();

		await gateway.createSyncGist();
		await gateway.chooseFiles(USER_B, WS_B);

		expect(internals.gistId).toBe(CREATED_GIST);
		expect(account.texts(CREATED_GIST, USER_B)).toEqual(["user A one"]);
		expect(account.texts(CREATED_GIST, WS_B)).toEqual(["ws A one"]);
	});

	it("keeps the lists when Create new fails, for the next attempt", async () => {
		await deleteGistA();
		await gateway.changeGist();
		account.failCreate = true;

		await gateway.createSyncGist();

		expect(internals.gistId).toBe(GIST_A);
		expect(texts(internals.user.todos)).toEqual(["user A one"]);
		expect(connection()).toEqual(
			jasmine.objectContaining({ phase: "change-gist", busy: false, message: "could not create" })
		);

		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
	});

	it("keeps the carried lists across a reload in the file picker", async () => {
		await deleteGistA();
		await gateway.selectGist(GIST_B);

		const restored = await reload();
		expect(restored).toEqual(
			jasmine.objectContaining({ phase: "needs-files", carryingOver: true })
		);
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
	});

	it("adds the carried lists once, to the first files picked", async () => {
		await deleteGistA();
		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);

		await gateway.chooseFiles(USER_B, WS_C);

		expect(texts(internals.workspace.todos)).toEqual([]);
		expect(account.texts(GIST_B, WS_C)).toEqual([]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("drops a carried record left behind once files were picked, rather than adding it again", async () => {
		await deleteGistA();
		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);
		// As if the app was closed between saving the selection and removing the record.
		await cacheStore.save(CARRIED, carriedRecord(GIST_A, { workspaceTodos: [todo(31, "ws A one")] }));

		await reload();
		await gateway.chooseFiles(USER_B, WS_C);

		expect(account.texts(GIST_B, WS_C)).toEqual([]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("keeps the part of a record whose file was not saved yet", async () => {
		// Closed between saving the user file and the workspace file: the user part is in USER_B's
		// cache entry, written there before either was saved, as chooseFiles does.
		session.stored = { token: "stub-token", gistId: GIST_B, userFile: USER_B };
		await cacheStore.save(`gistCache_global_${USER_B}`, {
			data: { userTodos: [todo(11, "user A one")] },
			lastSynced: new Date(0).toISOString(),
			isDirty: true,
		});
		await cacheStore.save(
			CARRIED,
			carriedRecord(GIST_A, {
				userTodos: [todo(11, "user A one")],
				workspaceTodos: [todo(31, "ws A one")],
			})
		);

		const restored = await reload();
		expect(restored).toEqual(
			jasmine.objectContaining({ phase: "needs-files", carryingOver: true })
		);
		await gateway.chooseFiles(USER_B, WS_B);

		// The user part had gone into its file before the selection was saved; it is there once.
		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
	});

	it("drops a record from a switch cut off before it cleared anything", async () => {
		await cacheStore.save(CARRIED, carriedRecord(GIST_A, { userTodos: [todo(11, "user A one")] }));

		const restored = await reload();

		expect(restored).toEqual(jasmine.objectContaining({ phase: "connected", userFile: USER_A }));
		expect(texts(internals.user.todos)).toEqual(["user A one"]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("finishes a switch cut off after it dropped the files, back on the gist picker", async () => {
		await deleteGistA();
		// Closed after the record was written and the selection cleared, before the new gist
		// was saved — the old gist's cache entries may or may not have gone yet.
		await cacheStore.save(
			CARRIED,
			carriedRecord(GIST_A, {
				userTodos: [todo(11, "user A one")],
				workspaceTodos: [todo(31, "ws A one")],
			})
		);
		await session.clearFileSelections();

		const restored = await reload();
		expect(restored).toEqual(jasmine.objectContaining({ phase: "change-gist" }));
		expect(await cacheStore.load(`gistCache_global_${USER_A}`)).toBeUndefined();
		await until(() => !(connection() as { busy?: boolean }).busy, "the gist list to load");

		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
	});

	it("still carries the lists when their record cannot be written, and says so", async () => {
		await deleteGistA();
		cacheStore.failingSaves.add(CARRIED);

		await gateway.selectGist(GIST_B);

		expect(syncFailure()).toEqual(
			jasmine.objectContaining({
				phase: "failing",
				message: jasmine.stringContaining("brought over from the previous gist"),
			})
		);
		await gateway.chooseFiles(USER_B, WS_B);
		expect(account.texts(GIST_B, WS_B)).toEqual(["ws A one"]);
	});

	it("does not switch lists when the carried ones cannot be written to the file picked", async () => {
		await deleteGistA();
		await gateway.selectGist(GIST_B);
		cacheStore.failingSaves.add(`gistCache_global_${USER_B}`);

		await gateway.chooseFiles(USER_B, WS_B);

		expect(internals.userFile).toBeUndefined();
		expect(connection()).toEqual(
			jasmine.objectContaining({ phase: "needs-files", carryingOver: true })
		);
		expect(syncFailure()).toEqual(
			jasmine.objectContaining({ message: jasmine.stringContaining("not switched") })
		);

		cacheStore.failingSaves.clear();
		await gateway.chooseFiles(USER_B, WS_B);
		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
	});

	it("takes the user lists back out when only the workspace ones fail to be written", async () => {
		await deleteGistA();
		await gateway.selectGist(GIST_B);
		cacheStore.failingSaves.add(`gistCache_workspace_${WS_B}`);

		await gateway.chooseFiles(USER_B, WS_B);

		expect(internals.userFile).toBeUndefined();
		expect(await cacheStore.load(`gistCache_global_${USER_B}`)).toBeUndefined();

		// A different user file on the next try, and the first one never gets the lists.
		cacheStore.failingSaves.clear();
		await gateway.chooseFiles(USER_A, WS_B);
		await gateway.chooseFiles(USER_B, WS_B);
		expect(account.texts(GIST_B, USER_B)).toEqual(["user B one"]);
	});

	it("does not add a leftover record's lists again to a file that has synced since", async () => {
		await deleteGistA();
		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);
		gateway.deleteTodo(TodoScope.user, { id: 11 });
		await internals.pullAll();
		// The record outlived its lists going into USER_B, its removal having failed.
		await cacheStore.save(CARRIED, carriedRecord(GIST_A, { userTodos: [todo(11, "user A one")] }));

		await reload();
		await internals.pullAll();

		expect(account.texts(GIST_B, USER_B)).toEqual(["user B one"]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("adds carried lists to a picked file that already synced, without deleting what it holds", async () => {
		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);
		// Lists still waiting for a user file, and USER_B picked for them has a baseline.
		await cacheStore.save(CARRIED, carriedRecord(GIST_A, { userTodos: [todo(11, "user A one")] }));
		delete session.stored["userFile"];

		expect(await reload()).toEqual(
			jasmine.objectContaining({ phase: "needs-files", carryingOver: true })
		);
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(
			jasmine.arrayWithExactContents(["user B one", "user A one"])
		);
	});

	it("does not write a leftover record into a file picked since, which never synced", async () => {
		// The lists went into USER_B; the record outlived that, and a new user file has been picked
		// whose first pull never got through, so it has no cache entry.
		session.stored = {
			token: "stub-token",
			gistId: GIST_B,
			userFile: "user-c.json",
			workspaceFile: WS_B,
		};
		await cacheStore.save(CARRIED, carriedRecord(GIST_A, { userTodos: [todo(11, "user A one")] }));

		await reload();
		await internals.pullAll();

		expect(texts(internals.user.todos)).toEqual([]);
		expect(account.texts(GIST_B, "user-c.json")).toEqual([]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("puts the lists back in a file that never synced, when the record is their only copy", async () => {
		// A file with no cache entry, as one picked new and never pushed has.
		await cacheStore.delete(`gistCache_global_${USER_A}`);
		await cacheStore.save(
			CARRIED,
			carriedRecord(
				GIST_A,
				{ userTodos: [todo(11, "user A one"), todo(12, "only in the record")] },
				{ user: USER_A }
			)
		);

		await reload();

		expect(texts(internals.user.todos)).toEqual(["user A one", "only in the record"]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("puts a leftover record back only in the file it came from", async () => {
		// Cut off before anything was cleared, the record's removal then failed, and a new user
		// file has been picked on the same gist whose first pull never got through.
		session.stored = {
			token: "stub-token",
			gistId: GIST_A,
			userFile: "user-v.json",
			workspaceFile: WS_A,
		};
		await cacheStore.save(
			CARRIED,
			carriedRecord(GIST_A, { userTodos: [todo(11, "user A one")] }, { user: USER_A })
		);

		await reload();
		await internals.pullAll();

		expect(texts(internals.user.todos)).toEqual([]);
		expect(account.texts(GIST_A, "user-v.json")).toEqual([]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("removes a leftover record before a switch that carries nothing clears the selections", async () => {
		const GIST_C = "c".repeat(32);
		account.gists.set(GIST_C, {});
		await gateway.selectGist(GIST_B);
		await gateway.chooseFiles(USER_B, WS_B);
		// Its lists went into USER_B, but its removal failed.
		await cacheStore.save(CARRIED, carriedRecord(GIST_A, { userTodos: [todo(11, "user A one")] }));
		let recordWhenCleared: unknown = "never cleared";
		const clearFileSelections = session.clearFileSelections.bind(session);
		session.clearFileSelections = async () => {
			recordWhenCleared = await cacheStore.load(CARRIED);
			return clearFileSelections();
		};

		await gateway.selectGist(GIST_C);

		expect(recordWhenCleared).toBeUndefined();
	});

	it("does not restore a session that a disconnect waiting in the queue is ending", async () => {
		const release = account.hold();
		const inFlight = internals.pullAll();
		await tick();
		const disconnecting = gateway.disconnectGitHub();
		// The error screen's Retry, pressed while the disconnect waits behind the pull.
		const restoring = gateway.restoreSession();
		await tick();

		release();
		await Promise.all([inFlight, disconnecting]);

		expect((await restoring).phase).toBe("disconnected");
		expect(internals.token).toBeUndefined();
		expect(internals.pollTimer).toBeUndefined();
	});

	it("ends the stored session only once a disconnect has cleared its cache", async () => {
		// Otherwise a reload in between finds no session over the old cache and carried lists,
		// and the next connection takes them up as its own.
		await deleteGistA();
		await gateway.selectGist(GIST_B);
		const order: string[] = [];
		const clearCache = cacheStore.clear.bind(cacheStore);
		cacheStore.clear = async (keep) => {
			order.push("cache");
			return clearCache(keep);
		};
		const clearSession = session.clear.bind(session);
		session.clear = async () => {
			order.push("session");
			return clearSession();
		};

		await gateway.disconnectGitHub();

		expect(order).toEqual(["cache", "session"]);
		expect(await cacheStore.load(CARRIED)).toBeUndefined();
	});

	it("names the files the lists came from only until the cache is cleared", async () => {
		const saved: Array<{ fromUserFile?: string; fromWorkspaceFile?: string }> = [];
		const save = cacheStore.save.bind(cacheStore);
		cacheStore.save = async (key, cache) => {
			if (key === CARRIED) {
				saved.push(structuredClone(cache.data) as { fromUserFile?: string });
			}
			return save(key, cache);
		};
		await deleteGistA();

		await gateway.selectGist(GIST_B);

		expect(saved[0]).toEqual(
			jasmine.objectContaining({ fromUserFile: USER_A, fromWorkspaceFile: WS_A })
		);
		const stored = (await cacheStore.load<{ fromUserFile?: string }>(CARRIED))?.data;
		expect(stored).toBeDefined();
		expect(stored?.fromUserFile).toBeUndefined();
	});

	it("control: leaving a gist that holds everything carries nothing", async () => {
		await gateway.selectGist(GIST_B);
		expect(connection()).toEqual(jasmine.objectContaining({ phase: "needs-files" }));
		expect((connection() as { carryingOver?: boolean }).carryingOver).toBeUndefined();
		await gateway.chooseFiles(USER_B, WS_B);

		expect(account.texts(GIST_B, USER_B)).toEqual(["user B one"]);
		expect(account.texts(GIST_B, WS_B)).toEqual([]);
	});

	it("refuses to switch while an edit could still reach the gist it was made in", async () => {
		account.down.add(GIST_A);
		gateway.addTodo(TodoScope.user, { text: "made while offline" });
		await gateway.changeGist();

		await gateway.selectGist(GIST_B);

		expect(internals.gistId).toBe(GIST_A);
		expect(internals.userFile).toBe(USER_A);
		expect(texts(internals.user.todos)).toContain("made while offline");
		expect(connection()).toEqual(
			jasmine.objectContaining({
				phase: "change-gist",
				busy: false,
				message: jasmine.stringContaining("not switched"),
			})
		);
		// The session goes on, and so does its poll.
		expect(internals.pollTimer).toBeDefined();

		// Once gist A answers again, the same switch pushes the edit there first.
		account.down.delete(GIST_A);
		await gateway.selectGist(GIST_B);

		expect(account.texts(GIST_A, USER_A)).toContain("made while offline");
		expect(internals.gistId).toBe(GIST_B);
		// No files are picked in gist B yet, so there is nothing to poll.
		expect(internals.pollTimer).toBeUndefined();
	});

	it("switches when the old gist is out of reach but owed nothing", async () => {
		account.down.add(GIST_A);
		await gateway.changeGist();

		await gateway.selectGist(GIST_B);

		expect(internals.gistId).toBe(GIST_B);
		expect(connection()).toEqual(jasmine.objectContaining({ phase: "needs-files" }));
		expect((connection() as { carryingOver?: boolean }).carryingOver).toBeUndefined();
	});

	it("declines a conflict found while settling, rather than asking behind the gist picker", async () => {
		// Visible, so only the switch in progress keeps the dialog shut.
		const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		const asked: unknown[] = [];
		const sub = gateway.conflictPrompt.subscribe((request) => request && asked.push(request));
		try {
			gateway.editTodo(TodoScope.user, { id: 11, newText: "edited on this device" });
			account.gists.get(GIST_A)![USER_A] = userFile(todo(11, "edited on the other device"));
			await gateway.changeGist();

			expect(await settles(gateway.selectGist(GIST_B))).toBe("done");

			expect(asked).toEqual([]);
			expect(internals.gistId).toBe(GIST_A);
			expect(connection()).toEqual(
				jasmine.objectContaining({ message: jasmine.stringContaining("not switched") })
			);
		} finally {
			sub.unsubscribe();
			delete (document as unknown as Record<string, unknown>)["visibilityState"];
			if (original) {
				Object.defineProperty(Document.prototype, "visibilityState", original);
			}
		}
	});

	it("refuses on a dropped connection even after an earlier failure no retry could fix", async () => {
		// A damaged file, reported, then repaired on github.com.
		const good = account.gists.get(GIST_A)![USER_A];
		account.gists.get(GIST_A)![USER_A] = "{ not json";
		await internals.pullAll();
		expect(syncFailure()).toEqual(jasmine.objectContaining({ kind: "data" }));
		account.gists.get(GIST_A)![USER_A] = good;
		account.down.add(GIST_A);
		await gateway.changeGist();

		await gateway.selectGist(GIST_B);

		expect(internals.gistId).toBe(GIST_A);
		expect(connection()).toEqual(
			jasmine.objectContaining({ message: jasmine.stringContaining("not switched") })
		);
	});

	it("does not create a gist for a switch it refuses", async () => {
		account.down.add(GIST_A);
		gateway.addTodo(TodoScope.user, { text: "made while offline" });
		await gateway.changeGist();

		await gateway.createSyncGist();

		expect(account.created).toBe(0);
		expect(internals.gistId).toBe(GIST_A);
		expect(texts(internals.user.todos)).toContain("made while offline");
	});
});
