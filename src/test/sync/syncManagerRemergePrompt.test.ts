/**
 * The extension's half of "a conflict is shown, not settled behind your back".
 *
 * `reconcileWithLocalEdits` folds a finished reconcile into local state that moved on while the
 * reconcile was on the network. It used to settle its conflicts by policy with no dialog, on the
 * grounds that the write had already gone out — but both versions in that merge are the user's,
 * so keeping local silently is the same overwrite the resolver exists to prevent.
 *
 * Three things have to hold once it asks:
 *
 *  - the resolver is told *which* merge is asking, because backing out of an after-write dialog
 *    cannot call off a write that has already happened, and every piece of copy that says
 *    otherwise is a lie;
 *  - a conflict the user actually decided is not then reported as settled automatically;
 *  - an edit typed while that dialog is open is not overwritten by the merge underneath it —
 *    the dialog is an unbounded await, and `ignoreFocusOut` keeps it up while the user clicks
 *    back into the Todo view.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { SyncManager } from "../../sync/SyncManager";
import { SyncStorageManager } from "../../sync/SyncStorageManager";
import { GitHubAuthManager } from "../../sync/GitHubAuthManager";
import { ConflictResolutionUI } from "../../sync/ConflictResolutionUI";
import { GlobalSyncMode, StorageKeys, WorkspaceSyncMode } from "../../sync/syncTypes";
import { serialize, ConflictDecisions, ConflictPhase, ConflictSet } from "../../core";
import { Todo } from "../../todo/todoTypes";

const GIST_ID = "b".repeat(32);
const FILE = "user-todos.json";
// Derived exactly as `SyncManager.workspaceFileName` derives it: a fixed name here would
// miss the cache this test seeds, and the sync would bootstrap instead of conflicting.
const WS_FILE = `workspace-${vscode.workspace.name || "default"}.json`;

function todo(id: number, text: string): Todo {
	return {
		id,
		text,
		completed: false,
		creationDate: "2026-01-01T00:00:00.000Z",
		isMarkdown: false,
		isNote: false,
	};
}

/** See syncManagerConcurrency.test.ts — same fake, same reason. */
class FakeGistFile {
	public reads = 0;
	public onRead: ((reads: number) => void) | undefined;

	constructor(public content: string | undefined) {}

	async readFile(_gistId: string, _fileName: string) {
		this.reads++;
		const snapshot = this.content;
		this.onRead?.(this.reads);
		if (snapshot === undefined) {
			return {
				success: false as const,
				error: { type: "file-not-found", message: "", timestamp: "", retryable: false },
			};
		}
		return { success: true as const, data: snapshot };
	}

	async writeFile(_gistId: string, _fileName: string, content: string) {
		this.content = content;
		return { success: true as const, data: {} };
	}
}

function memento(map: Map<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
		update: async (key: string, value: unknown) => {
			map.set(key, value);
		},
	};
}

suite("SyncManager after-write conflict prompt", () => {
	let globalStore: Map<string, unknown>;
	let wsStore: Map<string, unknown>;
	let manager: SyncManager;
	let gist: FakeGistFile;
	let context: never;

	/** Every call the manager made into the conflict UI, in order. */
	let asked: Array<{ phase: ConflictPhase; conflicts: ConflictSet[] }>;
	/** What the stubbed dialog answers, per call. */
	let answer: (conflicts: ConflictSet[], phase: ConflictPhase) => Promise<ConflictDecisions | null>;
	let warnings: string[];

	const realResolve = ConflictResolutionUI.resolve;
	const realWarn = vscode.window.showWarningMessage;

	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance =
			undefined;
	}

	/**
	 * Remote has moved on, this device has not. The reconcile is then a pure pull, so any conflict
	 * that turns up belongs to the re-merge and nothing else — which is the whole point here.
	 */
	function setUp(remote: Todo[], baseAndLocal: Todo[]): void {
		resetAuthSingleton();
		globalStore = new Map<string, unknown>([
			["syncMode", "github"],
			[
				StorageKeys.globalGistCache(FILE),
				{
					data: { userTodos: baseAndLocal },
					lastCleanRemoteData: { userTodos: baseAndLocal },
					lastSynced: "2026-01-01T00:00:00.000Z",
					isDirty: false,
				},
			],
		]);
		gist = new FakeGistFile(serialize({ userTodos: remote }));
		context = {
			globalState: memento(globalStore),
			workspaceState: memento(new Map([["syncMode", "local"]])),
			secrets: { get: () => Promise.resolve("token") },
		} as never;
		manager = new SyncManager(context);
		(manager as unknown as { apiClient: unknown }).apiClient = gist;
	}

	/** A local edit through the real storage path, exactly as `persistSlice` does. */
	async function editLocally(todos: Todo[]): Promise<void> {
		await new SyncStorageManager(context).setGlobalTodos(GlobalSyncMode.GitHub, todos, FILE);
	}

	function runUserSync(): Promise<{ success: boolean }> {
		return (
			manager as unknown as { syncUser(gistId: string): Promise<{ success: boolean }> }
		).syncUser(GIST_ID);
	}

	/** Workspace counterpart of `setUp`. */
	function setUpWorkspace(remote: Todo[], baseAndLocal: Todo[]): void {
		resetAuthSingleton();
		const workspaceStore = new Map<string, unknown>([
			["syncMode", "github"],
			[
				StorageKeys.workspaceGistCache(WS_FILE),
				{
					data: { workspaceTodos: baseAndLocal, filesData: {}, filesDataPaths: {} },
					lastCleanRemoteData: {
						workspaceTodos: baseAndLocal,
						filesData: {},
						filesDataPaths: {},
					},
					lastSynced: "2026-01-01T00:00:00.000Z",
					isDirty: false,
				},
			],
		]);
		wsStore = workspaceStore;
		gist = new FakeGistFile(serialize({ workspaceTodos: remote, filesData: {}, filesDataPaths: {} }));
		context = {
			globalState: memento(new Map<string, unknown>([["syncMode", "local"]])),
			workspaceState: memento(workspaceStore),
			secrets: { get: () => Promise.resolve("token") },
		} as never;
		manager = new SyncManager(context);
		(manager as unknown as { apiClient: unknown }).apiClient = gist;
	}

	async function editWorkspaceLocally(todos: Todo[]): Promise<void> {
		await new SyncStorageManager(context).setWorkspaceTodos(WorkspaceSyncMode.GitHub, todos, WS_FILE);
	}

	function runWorkspaceSync(): Promise<{ success: boolean }> {
		return (
			manager as unknown as { syncWorkspace(gistId: string): Promise<{ success: boolean }> }
		).syncWorkspace(GIST_ID);
	}

	function cachedWorkspaceTodos(): Todo[] {
		const cache = wsStore.get(StorageKeys.workspaceGistCache(WS_FILE)) as {
			data: { workspaceTodos: Todo[] };
		};
		return cache.data.workspaceTodos;
	}

	function cachedTodos(): Todo[] {
		const cache = globalStore.get(StorageKeys.globalGistCache(FILE)) as {
			data: { userTodos: Todo[] };
		};
		return cache.data.userTodos;
	}

	setup(() => {
		asked = [];
		warnings = [];
		answer = async () => ({ todos: new Map() });
		// The real UI would block on a quick pick forever under test.
		(ConflictResolutionUI as unknown as { resolve: unknown }).resolve = async (
			conflicts: ConflictSet[],
			_files: unknown,
			_knownIds: number[],
			phase: ConflictPhase
		) => {
			asked.push({ phase, conflicts });
			return answer(conflicts, phase);
		};
		(vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = ((
			message: string
		) => {
			warnings.push(message);
			return Promise.resolve(undefined);
		}) as unknown;
	});

	teardown(() => {
		manager.dispose();
		resetAuthSingleton();
		(ConflictResolutionUI as unknown as { resolve: unknown }).resolve = realResolve;
		(vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = realWarn;
	});

	test("asks about a conflict raised by an edit made during the sync", async () => {
		setUp([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editLocally([todo(1, "typed here")]);
			}
		};

		await runUserSync();

		// One prompt, and it knows it is the after-write one — which is what lets its copy stop
		// promising to undo a write that has already gone out.
		assert.strictEqual(asked.length, 1, "the re-merge must ask");
		assert.strictEqual(asked[0].phase, "after-write");
		assert.strictEqual(asked[0].conflicts[0].todoId, 1);
	});

	test("applies the version the user picked rather than the policy's", async () => {
		setUp([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editLocally([todo(1, "typed here")]);
			}
		};
		answer = async (conflicts) => ({
			todos: new Map(conflicts.map((c) => [c.todoId, c.remote])),
		});

		await runUserSync();

		// Before the prompt existed this path always kept local. "changed on the phone" is only
		// reachable by asking.
		assert.strictEqual(cachedTodos().find((t) => t.id === 1)!.text, "changed on the phone");
	});

	test("does not report a conflict the user decided as settled automatically", async () => {
		setUp([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editLocally([todo(1, "typed here")]);
			}
		};
		answer = async (conflicts) => ({
			todos: new Map(conflicts.map((c) => [c.todoId, c.remote])),
		});

		await runUserSync();

		// The engine reports every conflict its re-merge saw, decided or not, so without the
		// caller filtering them someone who had just chosen "Keep All Remote" was told their
		// conflicts had been settled automatically by keeping this device's version.
		const settled = warnings.filter((w) => w.includes("settled automatically"));
		assert.deepStrictEqual(settled, [], "a decided conflict must not be reported as automatic");
	});

	test("still reports a conflict the user left undecided", async () => {
		setUp([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editLocally([todo(1, "typed here")]);
			}
		};
		// An empty map is what the dialog returns when every conflict is skipped.
		answer = async () => ({ todos: new Map() });

		await runUserSync();

		const settled = warnings.filter((w) => w.includes("settled automatically"));
		assert.strictEqual(settled.length, 1, "an undecided conflict is still worth saying out loud");
	});

	test("keeps an edit typed while the conflict dialog is open", async () => {
		setUp([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editLocally([todo(1, "typed here")]);
			}
		};
		// The dialog is an unbounded await and `ignoreFocusOut` keeps it up while the user clicks
		// back into the Todo view, so anything typed there lands in the same storage the fold read
		// from. Folding once against the pre-dialog copy wrote the merge straight over it.
		let typedDuringPrompt = false;
		answer = async (conflicts) => {
			if (!typedDuringPrompt) {
				typedDuringPrompt = true;
				await editLocally([todo(1, "typed here"), todo(9, "typed while deciding")]);
			}
			return { todos: new Map(conflicts.map((c) => [c.todoId, c.local])) };
		};

		await runUserSync();

		const texts = new Map(cachedTodos().map((t) => [t.id, t.text]));
		assert.strictEqual(
			texts.get(9),
			"typed while deciding",
			"an edit made while the dialog was up must survive the write-back"
		);
		assert.strictEqual(texts.get(1), "typed here", "and the choice must still apply");
	});
	/**
	 * The workspace scope has its own copy of the fold loop, its own `fileConflicts` filtering and
	 * its own `AfterWriteAnswers`, and nothing exercised any of it — the suite above is all
	 * `syncUser`. A `// See syncUser.` comment is not test coverage.
	 */
	test("asks about a workspace conflict raised by an edit made during the sync", async () => {
		setUpWorkspace([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editWorkspaceLocally([todo(1, "typed here")]);
			}
		};
		answer = async (conflicts) => ({
			todos: new Map(conflicts.map((c) => [c.todoId, c.remote])),
		});

		await runWorkspaceSync();

		assert.strictEqual(asked.length, 1, "the workspace re-merge must ask too");
		assert.strictEqual(asked[0].phase, "after-write");
		assert.strictEqual(
			cachedWorkspaceTodos().find((t) => t.id === 1)!.text,
			"changed on the phone",
			"and the workspace scope must apply the picked version"
		);
		const settled = warnings.filter((w) => w.includes("settled automatically"));
		assert.deepStrictEqual(settled, [], "a decided workspace conflict is not automatic either");
	});

	test("keeps a workspace edit typed while the conflict dialog is open", async () => {
		setUpWorkspace([todo(1, "changed on the phone")], [todo(1, "one")]);
		gist.onRead = (reads) => {
			if (reads === 1) {
				void editWorkspaceLocally([todo(1, "typed here")]);
			}
		};
		let typedDuringPrompt = false;
		answer = async (conflicts) => {
			if (!typedDuringPrompt) {
				typedDuringPrompt = true;
				await editWorkspaceLocally([todo(1, "typed here"), todo(9, "typed while deciding")]);
			}
			return { todos: new Map(conflicts.map((c) => [c.todoId, c.local])) };
		};

		await runWorkspaceSync();

		const texts = new Map(cachedWorkspaceTodos().map((t) => [t.id, t.text]));
		assert.strictEqual(texts.get(9), "typed while deciding", "the workspace fold must loop too");
		assert.strictEqual(texts.get(1), "typed here");
	});
});
