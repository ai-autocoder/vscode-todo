/**
 * Concurrency regressions: an edit that lands *while a reconcile is on the network*.
 *
 * gistSyncRegression.test.ts drives one reconcile at a time with local state frozen, which is
 * why the lost-update race below survived it. The gateway snapshots its todos, awaits two HTTP
 * round-trips, then assigns the merged result back over whatever local state has since become.
 * An edit made in that window was overwritten in memory — and because the engine had already
 * advanced its baseline to the merged data, no later reconcile could tell that edit apart from
 * "nothing changed", so it never reached the gist either. Silent and unrecoverable.
 *
 * On a phone both halves of the trigger are the norm: a slow network widens the window, and the
 * 3s push debounce means a push is often in flight while the user is still typing.
 */

import { describe, it, expect } from "vitest";
import {
	GistSyncEngine,
	GistFileIO,
	CacheStore,
	GlobalGistData,
	WorkspaceGistData,
	SyncErrorType,
	SyncResult,
	serialize,
	Todo,
	TodoFilesData,
	mergeFilesData,
} from "../src/index";

const GIST_ID = "0123456789abcdef0123456789abcdef";
const USER_FILE = "user-vscode-extensions.json";
const WS_FILE = "workspace-vscode-todo.json";
/** Computed so the literal path key does not trip the camelCase naming rule. */
const FILE_PATH = "c:/repo/a.ts";

const todo = (id: number, text: string, over: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});

const emptyWorkspace = (): WorkspaceGistData => ({
	workspaceTodos: [],
	filesData: {},
	filesDataPaths: {},
});

/** In-memory gist with a controllable round-trip delay, so edits can be interleaved. */
class LatentGist implements GistFileIO {
	readonly files = new Map<string, string>();
	readonly writeLog: Array<{ fileName: string; content: string }> = [];
	latencyMs = 0;

	private async delay(): Promise<void> {
		if (this.latencyMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
		}
	}

	async readFile(_gistId: string, fileName: string): Promise<SyncResult<string>> {
		await this.delay();
		if (!this.files.has(fileName)) {
			return {
				success: false,
				error: {
					type: SyncErrorType.FileNotFoundError,
					message: "not found",
					timestamp: "",
					retryable: false,
				},
			};
		}
		return { success: true, data: this.files.get(fileName)! };
	}

	async writeFile(_gistId: string, fileName: string, content: string): Promise<SyncResult<unknown>> {
		await this.delay();
		this.writeLog.push({ fileName, content });
		this.files.set(fileName, content);
		return { success: true, data: {} };
	}

	seed(fileName: string, data: unknown): void {
		this.files.set(fileName, serialize(data));
	}

	user(): GlobalGistData {
		return JSON.parse(this.files.get(USER_FILE)!) as GlobalGistData;
	}

	workspace(): WorkspaceGistData {
		return JSON.parse(this.files.get(WS_FILE)!) as WorkspaceGistData;
	}
}

/** Cache store that survives restarting the engine, mirroring the IndexedDB-backed one. */
class PersistentCacheStore implements CacheStore {
	private readonly map = new Map<string, string>();

	async load<T>(key: string) {
		const raw = this.map.get(key);
		return raw === undefined ? undefined : (JSON.parse(raw) as never);
	}

	async save<T>(key: string, cache: T) {
		this.map.set(key, JSON.stringify(cache));
	}

	get size(): number {
		return this.map.size;
	}
}

const newEngine = (gist: LatentGist, store: CacheStore) =>
	new GistSyncEngine({ client: gist, gistId: GIST_ID, cacheStore: store });

/**
 * Stand-in for GistGateway, carrying the parts that matter here: in-memory local state, the
 * push debounce, the serializing queue, the generation guard, and persist-local-on-edit.
 */
class FakeGateway {
	userTodos: Todo[] = [];
	workspaceTodos: Todo[] = [];
	filesData: TodoFilesData = {};

	private userGeneration = 0;
	private workspaceGeneration = 0;
	private userTimer: ReturnType<typeof setTimeout> | undefined;
	private wsTimer: ReturnType<typeof setTimeout> | undefined;
	private queue: Promise<void> = Promise.resolve();

	/**
	 * When false the gateway behaves the way it did before the fix: it adopts the reconciled
	 * result unconditionally and never persists a debounced edit. That is what makes the tests
	 * below meaningful — flip this off and they fail on a real data-loss assertion rather than on
	 * a missing method, which is the only way to know they are testing the bug and not the API.
	 */
	constructor(
		private readonly engine: GistSyncEngine,
		private readonly debounceMs = 5,
		private readonly guardStaleAdopt = true
	) {}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(work, work);
		return this.queue;
	}

	async reconcileUser(): Promise<void> {
		const generation = this.userGeneration;
		const snapshot = { userTodos: this.userTodos };
		const res = await this.engine.reconcileUser(USER_FILE, snapshot);
		if (res.success && res.data) {
			const stale = this.guardStaleAdopt && this.userGeneration !== generation;
			this.userTodos = stale
				? this.engine.reconcileWithLocalEdits(snapshot, res.data.data, { userTodos: this.userTodos })
						.userTodos
				: res.data.data.userTodos;
			if (stale) {
				this.scheduleUserPush();
			}
		}
	}

	async reconcileWorkspace(): Promise<void> {
		const generation = this.workspaceGeneration;
		const snapshot: WorkspaceGistData = {
			workspaceTodos: this.workspaceTodos,
			filesData: this.filesData,
			filesDataPaths: {},
		};
		const res = await this.engine.reconcileWorkspace(WS_FILE, snapshot);
		if (res.success && res.data) {
			const stale = this.guardStaleAdopt && this.workspaceGeneration !== generation;
			const merged = stale
				? this.engine.reconcileWorkspaceWithLocalEdits(snapshot, res.data.data, {
						workspaceTodos: this.workspaceTodos,
						filesData: this.filesData,
						filesDataPaths: {},
					})
				: res.data.data;
			this.workspaceTodos = merged.workspaceTodos;
			this.filesData = merged.filesData;
			if (stale) {
				this.scheduleWorkspacePush();
			}
		}
	}

	private scheduleUserPush(): void {
		if (this.userTimer) {
			clearTimeout(this.userTimer);
		}
		if (this.guardStaleAdopt) {
			void this.engine.persistLocalUser(USER_FILE, { userTodos: this.userTodos });
		}
		this.userTimer = setTimeout(() => {
			this.userTimer = undefined;
			void this.enqueue(() => this.reconcileUser());
		}, this.debounceMs);
	}

	private scheduleWorkspacePush(): void {
		if (this.wsTimer) {
			clearTimeout(this.wsTimer);
		}
		if (this.guardStaleAdopt) {
			void this.engine.persistLocalWorkspace(WS_FILE, {
				workspaceTodos: this.workspaceTodos,
				filesData: this.filesData,
				filesDataPaths: {},
			});
		}
		this.wsTimer = setTimeout(() => {
			this.wsTimer = undefined;
			void this.enqueue(() => this.reconcileWorkspace());
		}, this.debounceMs);
	}

	addUserTodo(t: Todo): void {
		this.userGeneration++;
		this.userTodos = [...this.userTodos, t];
		this.scheduleUserPush();
	}

	editUserTodo(id: number, over: Partial<Todo>): void {
		this.userGeneration++;
		this.userTodos = this.userTodos.map((t) => (t.id === id ? { ...t, ...over } : t));
		this.scheduleUserPush();
	}

	deleteUserTodo(id: number): void {
		this.userGeneration++;
		this.userTodos = this.userTodos.filter((t) => t.id !== id);
		this.scheduleUserPush();
	}

	addFileTodo(filePath: string, t: Todo): void {
		this.workspaceGeneration++;
		this.filesData = { ...this.filesData, [filePath]: [...(this.filesData[filePath] ?? []), t] };
		this.scheduleWorkspacePush();
	}

	/**
	 * Waits for the queue to drain rather than guessing at a duration. A stale reconcile re-arms
	 * the debounce, so convergence takes an extra timer + round-trip; polling keeps the test
	 * honest about that instead of encoding a magic sleep that breaks under load.
	 */
	async settle(): Promise<void> {
		for (let i = 0; i < 200; i++) {
			await new Promise((resolve) => setTimeout(resolve, this.debounceMs * 2));
			await this.queue;
			if (!this.userTimer && !this.wsTimer) {
				return;
			}
		}
		throw new Error("sync never settled");
	}
}

describe("an edit made while a reconcile is in flight", () => {
	it("survives in memory instead of being overwritten by the merged snapshot", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(2, "first"));
		// The debounce fires and the reconcile goes to the network; the user keeps typing.
		await new Promise((r) => setTimeout(r, 15));
		gw.addUserTodo(todo(3, "typed during sync"));
		await gw.settle();

		expect(gw.userTodos.map((t) => t.text)).toEqual(["existing", "first", "typed during sync"]);
	});

	it("reaches the gist, because the re-armed push sees it as a local change", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(2, "first"));
		await new Promise((r) => setTimeout(r, 15));
		gw.addUserTodo(todo(3, "typed during sync"));
		await gw.settle();

		expect(gist.user().userTodos.map((t) => t.text)).toEqual([
			"existing",
			"first",
			"typed during sync",
		]);
	});

	it("keeps a modification, not just an addition", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "task")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.editUserTodo(1, { text: "renamed" });
		await new Promise((r) => setTimeout(r, 15));
		gw.editUserTodo(1, { completed: true });
		await gw.settle();

		expect(gist.user().userTodos[0].text).toBe("renamed");
		expect(gist.user().userTodos[0].completed).toBe(true);
	});

	it("protects per-file todos, which ride on the workspace file", async () => {
		const gist = new LatentGist();
		gist.seed(WS_FILE, emptyWorkspace());
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileWorkspace();

		gist.latencyMs = 20;
		gw.addFileTodo(FILE_PATH, todo(1, "first"));
		await new Promise((r) => setTimeout(r, 15));
		gw.addFileTodo(FILE_PATH, todo(2, "typed during sync"));
		await gw.settle();

		expect(gist.workspace().filesData[FILE_PATH].map((t) => t.text)).toEqual([
			"first",
			"typed during sync",
		]);
	});

	it("converges once the edits stop, rather than re-arming forever", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 10;
		gw.addUserTodo(todo(2, "a"));
		await new Promise((r) => setTimeout(r, 8));
		gw.addUserTodo(todo(3, "b"));
		await gw.settle();

		const writesAfterSettle = gist.writeLog.length;
		await gw.reconcileUser();
		expect(gist.writeLog.length).toBe(writesAfterSettle);
	});

	it("does not lose a remote change that arrived during the same flight", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(2, "local"));
		await new Promise((r) => setTimeout(r, 15));
		// The extension pushes its own todo while our reconcile is mid-flight...
		gist.seed(USER_FILE, {
			userTodos: [todo(1, "existing"), todo(7, "from the extension")],
		});
		// ...and the user types at the same time.
		gw.addUserTodo(todo(3, "typed during sync"));
		await gw.settle();

		const texts = gist.user().userTodos.map((t) => t.text);
		expect(texts).toContain("local");
		expect(texts).toContain("typed during sync");
		expect(texts).toContain("from the extension");
	});
});

describe("persistLocal* keeps a debounced edit across a reload", () => {
	it("rehydrates an edit that was never pushed, and still pushes it", async () => {
		const gist = new LatentGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });

		// Session 1: establish a baseline, then edit and get torn down before the debounce fires.
		const engine1 = newEngine(gist, store);
		const first = await engine1.reconcileUser(USER_FILE, { userTodos: [] });
		const afterPull = first.data!.data;
		await engine1.persistLocalUser(USER_FILE, {
			userTodos: [...afterPull.userTodos, todo(2, "typed then backgrounded")],
		});

		// Session 2: fresh engine, rehydrating from the cache the way the gateway does.
		const engine2 = newEngine(gist, store);
		const rehydrated = await engine2.loadCachedUser(USER_FILE);
		expect(rehydrated?.userTodos.map((t) => t.text)).toEqual([
			"existing",
			"typed then backgrounded",
		]);

		await engine2.reconcileUser(USER_FILE, rehydrated!);
		expect(gist.user().userTodos.map((t) => t.text)).toEqual([
			"existing",
			"typed then backgrounded",
		]);
	});

	it("leaves the merge baseline alone, so the pending edit reads as a local change", async () => {
		const gist = new LatentGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const engine = newEngine(gist, store);
		await engine.reconcileUser(USER_FILE, { userTodos: [] });

		await engine.persistLocalUser(USER_FILE, {
			userTodos: [todo(1, "existing"), todo(2, "pending")],
		});

		const cache = await store.load<GlobalGistData>(`gistCache_global_${USER_FILE}`);
		expect(cache!.data.userTodos.map((t) => t.text)).toEqual(["existing", "pending"]);
		expect(cache!.lastCleanRemoteData!.userTodos.map((t) => t.text)).toEqual(["existing"]);
		expect(cache!.isDirty).toBe(true);
	});

	it("round-trips a pending workspace edit, filesData included", async () => {
		const gist = new LatentGist();
		const store = new PersistentCacheStore();
		gist.seed(WS_FILE, emptyWorkspace());
		const engine1 = newEngine(gist, store);
		await engine1.reconcileWorkspace(WS_FILE, emptyWorkspace());

		await engine1.persistLocalWorkspace(WS_FILE, {
			workspaceTodos: [todo(1, "ws pending")],
			filesData: { [FILE_PATH]: [todo(2, "file pending")] },
			filesDataPaths: {},
		});

		const engine2 = newEngine(gist, store);
		const rehydrated = await engine2.loadCachedWorkspace(WS_FILE);
		expect(rehydrated!.workspaceTodos.map((t) => t.text)).toEqual(["ws pending"]);
		expect(rehydrated!.filesData[FILE_PATH].map((t) => t.text)).toEqual(["file pending"]);

		await engine2.reconcileWorkspace(WS_FILE, rehydrated!);
		expect(gist.workspace().workspaceTodos.map((t) => t.text)).toEqual(["ws pending"]);
		expect(gist.workspace().filesData[FILE_PATH].map((t) => t.text)).toEqual(["file pending"]);
	});

	it("is a no-op before the first reconcile, leaving the cold-cache bootstrap intact", async () => {
		const gist = new LatentGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "remote only")] });
		const engine = newEngine(gist, store);

		// No cache entry yet, so this must not write a baseline-less entry.
		await engine.persistLocalUser(USER_FILE, { userTodos: [todo(9, "local")] });
		expect(store.size).toBe(0);

		// The bootstrap path still runs, and still refuses to clobber the remote.
		const res = await engine.reconcileUser(USER_FILE, { userTodos: [] });
		expect(res.data!.data.userTodos.map((t) => t.text)).toEqual(["remote only"]);
	});

	it("clears isDirty once the pending edit matches the baseline again", async () => {
		const gist = new LatentGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const engine = newEngine(gist, store);
		await engine.reconcileUser(USER_FILE, { userTodos: [] });

		await engine.persistLocalUser(USER_FILE, { userTodos: [todo(1, "existing")] });
		const cache = await store.load<GlobalGistData>(`gistCache_global_${USER_FILE}`);
		expect(cache!.isDirty).toBe(false);
	});
});

/**
 * The gist API has no compare-and-swap, so `reconcile` reading the remote and then writing the
 * merged result is a TOCTOU window. A push from the extension that landed inside it used to be
 * overwritten wholesale — and because `saveCache` then recorded our stale result as the clean
 * baseline, the next reconcile saw remote == base and never pulled the lost change back.
 */
describe("a remote push that lands between our read and our write", () => {
	/** Gist that lets a concurrent remote push be injected right after a read resolves. */
	class RacingGist extends LatentGist {
		onAfterRead: (() => void) | undefined;

		override async readFile(gistId: string, fileName: string): Promise<SyncResult<string>> {
			const result = await super.readFile(gistId, fileName);
			if (this.onAfterRead) {
				const hook = this.onAfterRead;
				this.onAfterRead = undefined;
				hook();
			}
			return result;
		}
	}

	it("is merged in rather than overwritten", async () => {
		const gist = new RacingGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const engine = newEngine(gist, store);
		await engine.reconcileUser(USER_FILE, { userTodos: [todo(1, "existing")] });

		gist.onAfterRead = () => {
			gist.seed(USER_FILE, { userTodos: [todo(1, "existing"), todo(7, "from the extension")] });
		};
		await engine.reconcileUser(USER_FILE, {
			userTodos: [todo(1, "existing"), todo(2, "local")],
		});

		const texts = gist.user().userTodos.map((t) => t.text);
		expect(texts).toContain("local");
		expect(texts).toContain("from the extension");
	});

	it("leaves a baseline that does not read the pulled change back as a local deletion", async () => {
		const gist = new RacingGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const engine = newEngine(gist, store);
		await engine.reconcileUser(USER_FILE, { userTodos: [todo(1, "existing")] });

		gist.onAfterRead = () => {
			gist.seed(USER_FILE, { userTodos: [todo(1, "existing"), todo(7, "from the extension")] });
		};
		const first = await engine.reconcileUser(USER_FILE, {
			userTodos: [todo(1, "existing"), todo(2, "local")],
		});

		// Adopting the result and reconciling again must be a no-op, not a deletion.
		await engine.reconcileUser(USER_FILE, first.data!.data);
		expect(gist.user().userTodos.map((t) => t.text)).toContain("from the extension");
	});

	it("gives up retryably instead of clobbering when the remote will not settle", async () => {
		const gist = new RacingGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const engine = newEngine(gist, store);
		await engine.reconcileUser(USER_FILE, { userTodos: [todo(1, "existing")] });

		// A remote that changes after every single read, forever.
		let n = 100;
		const keepMoving = () => {
			gist.seed(USER_FILE, { userTodos: [todo(1, "existing"), todo(n++, `remote ${n}`)] });
			gist.onAfterRead = keepMoving;
		};
		gist.onAfterRead = keepMoving;

		const res = await engine.reconcileUser(USER_FILE, {
			userTodos: [todo(1, "existing"), todo(2, "local")],
		});
		expect(res.success).toBe(false);
		expect(res.error?.retryable).toBe(true);
	});
});

describe("a delete made while a reconcile is in flight", () => {
	it("stays deleted rather than being resurrected by the merged snapshot", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "keep"), todo(2, "delete me")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(3, "unrelated"));
		await new Promise((r) => setTimeout(r, 15));
		gw.deleteUserTodo(2);
		await gw.settle();

		expect(gw.userTodos.map((t) => t.text)).toEqual(["keep", "unrelated"]);
		expect(gist.user().userTodos.map((t) => t.text)).toEqual(["keep", "unrelated"]);
	});

	it("does not resurrect it when the remote also changed during the flight", async () => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "keep"), todo(2, "delete me")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()));
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(3, "local"));
		await new Promise((r) => setTimeout(r, 15));
		gist.seed(USER_FILE, {
			userTodos: [todo(1, "keep"), todo(2, "delete me"), todo(7, "from the extension")],
		});
		gw.deleteUserTodo(2);
		await gw.settle();

		const texts = gist.user().userTodos.map((t) => t.text);
		expect(texts).not.toContain("delete me");
		expect(texts).toContain("from the extension");
		expect(texts).toContain("local");
	});
});

describe("durability of an edit that arrives mid-flight", () => {
	it("persists the adopted state, since the reconcile's saveCache discards the earlier persist", async () => {
		const gist = new LatentGist();
		const store = new PersistentCacheStore();
		gist.seed(USER_FILE, { userTodos: [todo(1, "base")] });
		const engine = newEngine(gist, store);
		await engine.reconcileUser(USER_FILE, { userTodos: [todo(1, "base")] });

		gist.latencyMs = 20;
		const inFlight = engine.reconcileUser(USER_FILE, {
			userTodos: [todo(1, "base"), todo(2, "first")],
		});
		await new Promise((r) => setTimeout(r, 10));
		// The gateway's scheduleUserPush persists here when the mid-flight edit lands...
		await engine.persistLocalUser(USER_FILE, {
			userTodos: [todo(1, "base"), todo(2, "first"), todo(3, "typed")],
		});
		const res = await inFlight;

		// ...and saveCache has now replaced that entry, so the gateway must persist again after
		// adopting. Emulate the fixed gateway's re-persist.
		const adopted = {
			userTodos: [...res.data!.data.userTodos, todo(3, "typed")],
		};
		await engine.persistLocalUser(USER_FILE, adopted);

		const reloaded = await newEngine(gist, store).loadCachedUser(USER_FILE);
		expect(reloaded!.userTodos.map((t) => t.text)).toContain("typed");
	});
});

describe("seeding a file both peers create at once", () => {
	/** Absent on the first read, then created by the other peer before we can write. */
	class CreatedUnderUsGist extends LatentGist {
		override async readFile(gistId: string, fileName: string): Promise<SyncResult<string>> {
			const result = await super.readFile(gistId, fileName);
			if (!result.success) {
				this.seed(fileName, { userTodos: [todo(7, "from the extension")] });
			}
			return result;
		}
	}

	it("merges instead of replacing the other peer's brand-new file", async () => {
		const gist = new CreatedUnderUsGist();
		const engine = newEngine(gist, new PersistentCacheStore());

		const res = await engine.reconcileUser(USER_FILE, { userTodos: [todo(2, "pwa local")] });
		expect(res.success).toBe(true);

		const texts = gist.user().userTodos.map((t) => t.text);
		expect(texts).toContain("pwa local");
		expect(texts).toContain("from the extension");
	});
});

/**
 * The gateway's retry timers are deliberately separate from its debounce timers, and its retry
 * budget resets on user activity. Both were bugs once: a retry cancelled a pending edit's push
 * and replaced it with a backoff the edit had not earned, and a run of offline failures left the
 * budget exhausted so an idle device never retried again.
 *
 * CAVEAT: `RetryBookkeeper` below re-implements the gateway's bookkeeping rather than exercising
 * it. `GistGateway` lives in `webview-ui` (Angular) and is unreachable from vitest, so these
 * cases document and lock the intended semantics but will NOT catch a regression in
 * `gist-gateway.ts` itself. Covering that for real needs a Karma spec under `webview-ui`.
 */
describe("retry budget and timer separation", () => {
	/** Mirrors the gateway's retry bookkeeping, without the network. */
	class RetryBookkeeper {
		retries = 0;
		pushTimerArmed = false;
		retryTimerArmed = false;
		static readonly MAX = 3;

		/** `mutate`: a real user edit. */
		edit(): void {
			this.retries = 0;
			this.pushTimerArmed = true;
		}

		/** `scheduleUserRetry`: only touches the retry timer. */
		retry(): boolean {
			if (this.retries >= RetryBookkeeper.MAX) {
				return false;
			}
			this.retries++;
			this.retryTimerArmed = true;
			return true;
		}

		/** `refresh`: returning to the app forgives a stale failure streak. */
		focus(): void {
			this.retries = 0;
		}
	}

	it("does not cancel a pending edit's push when a retry is armed", () => {
		const g = new RetryBookkeeper();
		g.edit();
		expect(g.pushTimerArmed).toBe(true);
		g.retry();
		// The edit's debounce is still pending; only the retry timer was touched.
		expect(g.pushTimerArmed).toBe(true);
		expect(g.retryTimerArmed).toBe(true);
	});

	it("stops retrying after the bound", () => {
		const g = new RetryBookkeeper();
		expect([g.retry(), g.retry(), g.retry(), g.retry()]).toEqual([true, true, true, false]);
	});

	it("gives a fresh budget to a new user edit", () => {
		const g = new RetryBookkeeper();
		g.retry();
		g.retry();
		g.retry();
		expect(g.retry()).toBe(false);
		g.edit();
		expect(g.retry()).toBe(true);
	});

	it("forgives a stale failure streak when the app regains focus", () => {
		const g = new RetryBookkeeper();
		g.retry();
		g.retry();
		g.retry();
		expect(g.retry()).toBe(false);
		g.focus();
		expect(g.retry()).toBe(true);
	});
});

/**
 * Proof that the tests above are pinning the *bug* and not merely the new API.
 *
 * Each case runs the identical scenario twice through the same harness: once with the stale
 * guard off (pre-fix behaviour — adopt the reconciled result blindly, never persist a debounced
 * edit) and once with it on. The unguarded run must lose data on a real content assertion; the
 * guarded run must not. A regression that removes the guard therefore fails the second half,
 * rather than erroring on a missing method.
 */
describe("the guard is what prevents the loss (paired, same harness)", () => {
	const runAddDuringFlight = async (guard: boolean) => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "existing")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()), 5, guard);
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(2, "first"));
		await new Promise((r) => setTimeout(r, 15));
		gw.addUserTodo(todo(3, "typed during sync"));
		await gw.settle();

		return {
			local: gw.userTodos.map((t) => t.text),
			remote: gist.user().userTodos.map((t) => t.text),
		};
	};

	it("loses the mid-flight addition without the guard", async () => {
		const { local, remote } = await runAddDuringFlight(false);
		// The real defect, asserted on content: the todo is gone from memory AND from the gist,
		// and no later reconcile brings it back.
		expect(local).not.toContain("typed during sync");
		expect(remote).not.toContain("typed during sync");
	});

	it("keeps the mid-flight addition with the guard", async () => {
		const { local, remote } = await runAddDuringFlight(true);
		expect(local).toEqual(["existing", "first", "typed during sync"]);
		expect(remote).toEqual(["existing", "first", "typed during sync"]);
	});

	const runEditDuringFlight = async (guard: boolean) => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "task")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()), 5, guard);
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.editUserTodo(1, { text: "renamed" });
		await new Promise((r) => setTimeout(r, 15));
		gw.editUserTodo(1, { completed: true });
		await gw.settle();

		return gist.user().userTodos[0];
	};

	it("loses the mid-flight completion toggle without the guard", async () => {
		expect((await runEditDuringFlight(false)).completed).toBe(false);
	});

	it("keeps the mid-flight completion toggle with the guard", async () => {
		const finished = await runEditDuringFlight(true);
		expect(finished.completed).toBe(true);
		expect(finished.text).toBe("renamed");
	});

	const runDeleteDuringFlight = async (guard: boolean) => {
		const gist = new LatentGist();
		gist.seed(USER_FILE, { userTodos: [todo(1, "keep"), todo(2, "delete me")] });
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()), 5, guard);
		await gw.reconcileUser();

		gist.latencyMs = 20;
		gw.addUserTodo(todo(3, "unrelated"));
		await new Promise((r) => setTimeout(r, 15));
		gw.deleteUserTodo(2);
		await gw.settle();

		return gist.user().userTodos.map((t) => t.text);
	};

	it("resurrects a mid-flight delete without the guard", async () => {
		expect(await runDeleteDuringFlight(false)).toContain("delete me");
	});

	it("honours a mid-flight delete with the guard", async () => {
		expect(await runDeleteDuringFlight(true)).toEqual(["keep", "unrelated"]);
	});

	const runFileTodoDuringFlight = async (guard: boolean) => {
		const gist = new LatentGist();
		gist.seed(WS_FILE, emptyWorkspace());
		const gw = new FakeGateway(newEngine(gist, new PersistentCacheStore()), 5, guard);
		await gw.reconcileWorkspace();

		gist.latencyMs = 20;
		gw.addFileTodo(FILE_PATH, todo(1, "first"));
		await new Promise((r) => setTimeout(r, 15));
		gw.addFileTodo(FILE_PATH, todo(2, "typed during sync"));
		await gw.settle();

		return (gist.workspace().filesData[FILE_PATH] ?? []).map((t) => t.text);
	};

	it("loses a mid-flight per-file todo without the guard", async () => {
		expect(await runFileTodoDuringFlight(false)).not.toContain("typed during sync");
	});

	it("keeps a mid-flight per-file todo with the guard", async () => {
		expect(await runFileTodoDuringFlight(true)).toEqual(["first", "typed during sync"]);
	});
});

/**
 * Per-file todo lists used to be merged as one opaque array: any concurrent change to the same
 * file became a whole-array `file-edit-edit` conflict, and `prefer-local` then discarded the
 * other side entirely. Two people adding a todo to the same file are not in conflict, so the
 * arrays are merged per item and only genuinely conflicting todos escalate.
 *
 * `mergeFilesData` is duplicated in `src/sync/ThreeWayMerge.ts` for the extension; both copies
 * carry this behaviour so the two peers resolve identically.
 */
describe("mergeFilesData merges per todo, not per file", () => {
	it("keeps additions made to the same file on both sides", () => {
		const result = mergeFilesData(
			{ [FILE_PATH]: [todo(1, "shared")] },
			{ [FILE_PATH]: [todo(1, "shared"), todo(2, "typed here")] },
			{ [FILE_PATH]: [todo(1, "shared"), todo(7, "from the extension")] }
		);
		expect(result.conflicts).toEqual([]);
		// Both survive. Order follows threeWayMerge's position anchoring, which places the remote
		// addition relative to its neighbours on the remote side.
		expect((result.autoMerged[FILE_PATH] ?? []).map((t) => t.text)).toEqual([
			"shared",
			"from the extension",
			"typed here",
		]);
	});

	it("keeps a local addition alongside a remote edit of a different todo", () => {
		const result = mergeFilesData(
			{ [FILE_PATH]: [todo(1, "original")] },
			{ [FILE_PATH]: [todo(1, "original"), todo(2, "mine")] },
			{ [FILE_PATH]: [todo(1, "renamed remotely")] }
		);
		expect(result.conflicts).toEqual([]);
		const texts = (result.autoMerged[FILE_PATH] ?? []).map((t) => t.text);
		expect(texts).toContain("renamed remotely");
		expect(texts).toContain("mine");
	});

	it("honours a remote deletion while keeping an unrelated local addition", () => {
		const result = mergeFilesData(
			{ [FILE_PATH]: [todo(1, "doomed"), todo(2, "kept")] },
			{ [FILE_PATH]: [todo(1, "doomed"), todo(2, "kept"), todo(3, "mine")] },
			{ [FILE_PATH]: [todo(2, "kept")] }
		);
		expect(result.conflicts).toEqual([]);
		const texts = (result.autoMerged[FILE_PATH] ?? []).map((t) => t.text);
		expect(texts).not.toContain("doomed");
		expect(texts).toContain("kept");
		expect(texts).toContain("mine");
	});

	it("still reports a file conflict when the same todo is edited differently on both sides", () => {
		const result = mergeFilesData(
			{ [FILE_PATH]: [todo(1, "original")] },
			{ [FILE_PATH]: [todo(1, "local rename")] },
			{ [FILE_PATH]: [todo(1, "remote rename")] }
		);
		expect(result.conflicts.map((c) => c.conflictType)).toEqual(["file-edit-edit"]);
		// Left for the caller's policy, so the file is absent from the auto-merged set.
		expect(result.autoMerged[FILE_PATH]).toBeUndefined();
	});

	it("is unchanged when only one side touched the file", () => {
		const remoteOnly = mergeFilesData(
			{ [FILE_PATH]: [todo(1, "a")] },
			{ [FILE_PATH]: [todo(1, "a")] },
			{ [FILE_PATH]: [todo(1, "a"), todo(2, "remote")] }
		);
		expect(remoteOnly.conflicts).toEqual([]);
		expect((remoteOnly.autoMerged[FILE_PATH] ?? []).map((t) => t.text)).toEqual(["a", "remote"]);

		const localOnly = mergeFilesData(
			{ [FILE_PATH]: [todo(1, "a")] },
			{ [FILE_PATH]: [todo(1, "a"), todo(2, "local")] },
			{ [FILE_PATH]: [todo(1, "a")] }
		);
		expect(localOnly.conflicts).toEqual([]);
		expect((localOnly.autoMerged[FILE_PATH] ?? []).map((t) => t.text)).toEqual(["a", "local"]);
	});
});
