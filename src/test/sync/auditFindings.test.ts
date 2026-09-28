/**
 * Defects found by the September 2026 audit on the extension side, reproduced through the real
 * code paths (the `SyncManager`, the real `StorageSyncManager` persist, the real engine) over a
 * fake gist.
 *
 * A `testKnownBug` case states the correct behaviour and passes only while the code still fails
 * it. When one starts failing the defect has been fixed: turn it into a plain `test`, and it
 * becomes the regression test. The other plain `test` cases are either controls or regression
 * tests for fixed findings; each one's comment says which.
 */

import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SyncManager } from "../../sync/SyncManager";
import { GitHubAuthManager } from "../../sync/GitHubAuthManager";
import { GistCache, StorageKeys, WorkspaceGistData } from "../../sync/syncTypes";
import StorageSyncManager from "../../storage/StorageSyncManager";
import TodoService from "../../todo/TodoService";
import createStore from "../../todo/store";
import { serialize } from "../../core";
import { CurrentFileSlice, Todo, TodoFilesData, TodoScope, TodoSlice } from "../../todo/todoTypes";

const GIST_ID = "b".repeat(32);
const FILE_PATH = process.platform === "win32" ? "C:\\audit\\repo\\a.ts" : "/audit/repo/a.ts";

/** The file name `SyncManager` derives for the workspace scope in this test instance. */
function workspaceFileName(): string {
	const configured = vscode.workspace.getConfiguration("vscodeTodo.sync").get<string>("github.workspaceFile");
	return configured || `workspace-${vscode.workspace.name || "default"}.json`;
}

function todo(id: number, text: string): Todo {
	return { id, text, completed: false, creationDate: "2026-01-01T00:00:00.000Z", isMarkdown: false, isNote: false };
}

function testKnownBug(name: string, check: () => Promise<void>): void {
	test(`KNOWN BUG — ${name}`, async () => {
		let failure: unknown;
		try {
			await check();
		} catch (error) {
			failure = error;
		}
		assert.ok(failure, "This defect appears to be fixed: turn this case into a plain test().");
	});
}

/** VS Code's memento semantics that matter here: `get` returns the stored object itself. */
function memento(map: Map<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
		update: async (key: string, value: unknown) => {
			map.set(key, value);
		},
		keys: () => [...map.keys()],
	};
}

class FakeWorkspaceGist {
	writes: string[] = [];
	/** Runs while a write is on the network: the content has been sent, the call not returned. */
	duringWrite: (() => Promise<void>) | undefined;

	constructor(public content: string) {}

	async readFile() {
		return { success: true as const, data: this.content };
	}

	async writeFile(_gistId: string, _fileName: string, content: string) {
		this.writes.push(content);
		this.content = content;
		const hook = this.duringWrite;
		this.duringWrite = undefined;
		await hook?.();
		return { success: true as const, data: {} };
	}

	fileTodos(): string[] {
		const data = JSON.parse(this.content) as WorkspaceGistData;
		return (data.filesData[FILE_PATH] ?? []).map((t: Todo) => t.text);
	}
}

suite("Audit: per-file edits during a workspace push", () => {
	let workspaceStore: Map<string, unknown>;
	let context: vscode.ExtensionContext;
	let manager: SyncManager;
	let gist: FakeWorkspaceGist;
	let wsFile: string;

	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance = undefined;
	}

	/** Baseline and gist hold `[one]`; this device holds an unpushed `[one, two]`. */
	setup(() => {
		resetAuthSingleton();
		wsFile = workspaceFileName();
		const base: WorkspaceGistData = { workspaceTodos: [], filesData: { [FILE_PATH]: [todo(1, "one")] }, filesDataPaths: {} };
		workspaceStore = new Map<string, unknown>([
			["syncMode", "github"],
			[
				StorageKeys.workspaceGistCache(wsFile),
				{
					data: { workspaceTodos: [], filesData: { [FILE_PATH]: [todo(1, "one"), todo(2, "two")] }, filesDataPaths: {} },
					lastCleanRemoteData: base,
					lastSynced: "2026-01-01T00:00:00.000Z",
					isDirty: true,
				},
			],
		]);
		gist = new FakeWorkspaceGist(serialize(base));
		context = {
			globalState: memento(new Map([["syncMode", "profile-local"]])),
			workspaceState: memento(workspaceStore),
			secrets: { get: () => Promise.resolve("token") },
		} as unknown as vscode.ExtensionContext;
		manager = new SyncManager(context);
		(manager as unknown as { apiClient: unknown }).apiClient = gist;
	});

	teardown(() => {
		manager.dispose();
		resetAuthSingleton();
	});

	function runWorkspaceSync(): Promise<{ success: boolean }> {
		return (manager as unknown as { syncWorkspace(id: string): Promise<{ success: boolean }> }).syncWorkspace(GIST_ID);
	}

	/** The user edits the open file's list: exactly what the store subscriber does, via persistSlice. */
	async function editOpenFile(todos: Todo[]): Promise<void> {
		const slice: CurrentFileSlice = {
			todos,
			lastActionType: "currentFile/addTodo",
			numberOfTodos: todos.length,
			numberOfNotes: 0,
			scope: TodoScope.currentFile,
			filePath: FILE_PATH,
			isPinned: false,
		};
		await new StorageSyncManager(context, {} as never).persistSlice(slice);
	}

	test("control: an edit made before the push reaches the gist", async () => {
		await editOpenFile([todo(1, "one"), todo(2, "two"), todo(3, "three")]);

		await runWorkspaceSync();
		await runWorkspaceSync();

		assert.deepStrictEqual(gist.fileTodos(), ["one", "two", "three"]);
	});

	/**
	 * Regression test for C1 (fixed). `readLocalWorkspace` used to hand the engine
	 * `cache.data.filesData` — the live memento object — and the GitHub branch of `persistSlice`
	 * edited that same object in place (`filesData[key] = todos`). An edit landing while the
	 * PATCH was in flight therefore mutated the snapshot the engine was pushing: the gist got the
	 * old bytes, the baseline the new content, `editedDuringSync` compared the mutated snapshot
	 * with itself, and the follow-up sync read the edit as "the remote deleted it". Now
	 * `SyncStorageManager` reads and writes copies, and the engine reconciles its own copy.
	 */
	test("an edit to the open file's list during the push survives the next sync", async () => {
		gist.duringWrite = () => editOpenFile([todo(1, "one"), todo(2, "two"), todo(3, "three")]);

		await runWorkspaceSync(); // pushes [one, two]; "three" lands mid-PATCH
		await runWorkspaceSync(); // the re-run the edit's debounce would have queued

		assert.deepStrictEqual(gist.fileTodos(), ["one", "two", "three"], "the edit must reach the gist");
	});
});

/**
 * Regression tests for overlapping persists. `persistSlice` read what was stored, changed it and
 * wrote it back across several awaits, and persists overlap: the store subscriber does not wait
 * for its own, and concurrent MCP calls each wait only for theirs. Two overlapping persists both
 * read the same state, and the later write dropped the earlier one's change. Persists now run one
 * at a time per storage, and a per-file write reaches the `TodoFilesData` memento at the call.
 */
suite("Overlapping per-file writes", () => {
	const root = process.platform === "win32" ? "C:\\work\\plans" : "/work/plans";
	const X = path.join(root, "src", "x.ts");
	const Y = path.join(root, "src", "y.ts");

	function fileSlice(filePath: string, todos: Todo[]): CurrentFileSlice {
		return {
			todos,
			lastActionType: "todo/update",
			numberOfTodos: todos.length,
			numberOfNotes: 0,
			scope: TodoScope.currentFile,
			filePath,
			isPinned: false,
		};
	}

	function texts(filesData: TodoFilesData | undefined, filePath: string): string[] {
		return (filesData?.[filePath] ?? []).map((t) => t.text);
	}

	function emptyGistCache(): GistCache<WorkspaceGistData> {
		const empty: WorkspaceGistData = { workspaceTodos: [], filesData: {}, filesDataPaths: {} };
		return { data: empty, lastCleanRemoteData: empty, lastSynced: "2026-01-01T00:00:00.000Z", isDirty: false };
	}

	/** A workspace in GitHub mode whose gist cache holds no lists. */
	function githubWorkspace(workspaceStore: Map<string, unknown>) {
		workspaceStore.set("syncMode", "github");
		workspaceStore.set(StorageKeys.workspaceGistCache(workspaceFileName()), emptyGistCache());
		return {
			globalState: memento(new Map([["syncMode", "profile-local"]])),
			workspaceState: memento(workspaceStore),
		} as unknown as vscode.ExtensionContext;
	}

	function gistFiles(workspaceStore: Map<string, unknown>): TodoFilesData {
		const cache = workspaceStore.get(StorageKeys.workspaceGistCache(workspaceFileName())) as
			| GistCache<WorkspaceGistData>
			| undefined;
		return cache?.data.filesData ?? {};
	}

	test("GitHub mode: two files persisted at once both reach the gist cache", async () => {
		const workspaceStore = new Map<string, unknown>();
		const storage = new StorageSyncManager(githubWorkspace(workspaceStore), {} as never);

		await Promise.all([
			storage.persistSlice(fileSlice(X, [todo(1, "x")])),
			storage.persistSlice(fileSlice(Y, [todo(1, "y")])),
		]);

		assert.deepStrictEqual(texts(gistFiles(workspaceStore), X), ["x"], "the first write was dropped");
		assert.deepStrictEqual(texts(gistFiles(workspaceStore), Y), ["y"]);
		const shown = workspaceStore.get("TodoFilesData") as TodoFilesData;
		assert.deepStrictEqual([texts(shown, X), texts(shown, Y)], [["x"], ["y"]]);
	});

	test("local mode: overlapping file and workspace writes all reach workspaceData.json", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-todo-persist-"));
		const workspaceStore = new Map<string, unknown>([["syncMode", "local"]]);
		const context = {
			globalState: memento(new Map([["syncMode", "profile-local"]])),
			workspaceState: memento(workspaceStore),
			globalStorageUri: vscode.Uri.file(path.join(dir, "global")),
			storageUri: vscode.Uri.file(path.join(dir, "workspace")),
			subscriptions: [] as vscode.Disposable[],
		} as unknown as vscode.ExtensionContext;
		const storage = new StorageSyncManager(context, createStore());
		try {
			await storage.initialize();
			const workspaceSlice: TodoSlice = {
				todos: [todo(1, "w")],
				lastActionType: "workspace/addTodo",
				numberOfTodos: 1,
				numberOfNotes: 0,
				scope: TodoScope.workspace,
			};

			await Promise.all([
				storage.persistSlice(fileSlice(X, [todo(1, "x")])),
				storage.persistSlice(workspaceSlice),
				storage.persistSlice(fileSlice(Y, [todo(1, "y")])),
			]);

			const onDisk = JSON.parse(
				fs.readFileSync(path.join(dir, "workspace", "workspaceData.json"), "utf8")
			) as WorkspaceGistData;
			assert.deepStrictEqual(texts(onDisk.filesData, X), ["x"], "the first file write was dropped");
			assert.deepStrictEqual(texts(onDisk.filesData, Y), ["y"]);
			assert.deepStrictEqual(
				onDisk.workspaceTodos.map((t) => t.text),
				["w"],
				"a file write put the old workspace list back"
			);
			const shown = workspaceStore.get("TodoFilesData") as TodoFilesData;
			assert.deepStrictEqual([texts(shown, X), texts(shown, Y)], [["x"], ["y"]]);
		} finally {
			context.subscriptions.forEach((disposable) => disposable.dispose());
			// Windows can hold the directory for a moment after the watchers go. A leftover temp
			// directory is harmless; an error here would hide the test's own failure.
			try {
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
			} catch {
				// Left for the OS to clean up.
			}
		}
	});

	test("the per-file lists show a queued write at once, and keep showing it while earlier ones finish", async () => {
		// The gist cache writes wait on a gate, so the persists queue up behind each other.
		const workspaceStore = new Map<string, unknown>();
		const context = githubWorkspace(workspaceStore);
		const gistKey = StorageKeys.workspaceGistCache(workspaceFileName());
		const held: Array<() => void> = [];
		let gateOpen = false;
		const plain = context.workspaceState;
		(context as { workspaceState: unknown }).workspaceState = {
			get: plain.get,
			keys: plain.keys,
			update: (key: string, value: unknown) => {
				void plain.update(key, value);
				return key === gistKey && !gateOpen ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve();
			},
		};
		const storage = new StorageSyncManager(context, {} as never);

		// Both are accepted before the first starts, so its memento write must not hide the
		// second, which is still waiting.
		const persists = [
			storage.persistSlice(fileSlice(X, [todo(1, "one"), todo(2, "two")])),
			storage.persistSlice(fileSlice(X, [todo(1, "one"), todo(2, "two"), todo(3, "three")])),
		];
		for (let i = 0; i < 50 && held.length === 0; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.strictEqual(held.length, 1, "the first persist should be waiting on its gist cache write");
		assert.deepStrictEqual(
			texts(workspaceStore.get("TodoFilesData") as TodoFilesData, X),
			["one", "two", "three"],
			"a tab switch now would load an old list"
		);

		// Accepted while the first is still writing: it shows before its turn comes.
		persists.push(storage.persistSlice(fileSlice(Y, [todo(1, "y")])));
		assert.deepStrictEqual(texts(workspaceStore.get("TodoFilesData") as TodoFilesData, Y), ["y"]);

		gateOpen = true;
		held.splice(0).forEach((release) => release());
		await Promise.all(persists);

		assert.deepStrictEqual(texts(gistFiles(workspaceStore), X), ["one", "two", "three"]);
		assert.deepStrictEqual(texts(gistFiles(workspaceStore), Y), ["y"]);
		const settled = workspaceStore.get("TodoFilesData") as TodoFilesData;
		assert.deepStrictEqual([texts(settled, X), texts(settled, Y)], [["one", "two", "three"], ["y"]]);
	});

	suite("through the MCP tools", () => {
		let originalFolders: PropertyDescriptor | undefined;
		let originalGetWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder;
		const folder = { uri: vscode.Uri.file(root), name: "plans", index: 0 } as vscode.WorkspaceFolder;

		// File scopes need an open folder, and the test host has none.
		suiteSetup(() => {
			originalFolders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
			Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, get: () => [folder] });
			originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
			(vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }).getWorkspaceFolder =
				(uri: vscode.Uri) => (uri.fsPath.startsWith(folder.uri.fsPath) ? folder : undefined);
		});

		suiteTeardown(() => {
			if (originalFolders) {
				Object.defineProperty(vscode.workspace, "workspaceFolders", originalFolders);
			} else {
				delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;
			}
			(vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }).getWorkspaceFolder =
				originalGetWorkspaceFolder;
		});

		function writableService(workspaceStore: Map<string, unknown>): TodoService {
			const context = githubWorkspace(workspaceStore);
			const store = createStore();
			const service = new TodoService(context, store, new StorageSyncManager(context, store));
			service.updateAccess(false, ["user", "workspace", "file"]);
			return service;
		}

		test("adds to two files at once are both stored", async () => {
			const workspaceStore = new Map<string, unknown>();
			const service = writableService(workspaceStore);

			await Promise.all([
				service.addTodo(TodoScope.currentFile, "x", { filePath: X }),
				service.addTodo(TodoScope.currentFile, "y", { filePath: Y }),
			]);

			assert.deepStrictEqual(texts(gistFiles(workspaceStore), X), ["x"], "the first add was dropped");
			assert.deepStrictEqual(texts(gistFiles(workspaceStore), Y), ["y"]);
		});

		test("edits to two items of one file at once are both stored", async () => {
			const workspaceStore = new Map<string, unknown>();
			const service = writableService(workspaceStore);
			await service.addTodos(TodoScope.currentFile, [{ text: "a" }, { text: "b" }], {
				filePath: X,
				position: "bottom",
			});
			const [a, b] = service.listTodos(TodoScope.currentFile, { filePath: X }).todos;

			await Promise.all([
				service.setCompleted(TodoScope.currentFile, a.id, true, { filePath: X }),
				service.setCompleted(TodoScope.currentFile, b.id, true, { filePath: X }),
			]);

			const stored = gistFiles(workspaceStore)[X] ?? [];
			assert.deepStrictEqual(
				stored.map((t) => [t.text, t.completed]),
				[
					["a", true],
					["b", true],
				],
				"the first edit was dropped"
			);
		});
	});
});

suite("Audit: poll interval validation", () => {
	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance = undefined;
	}

	/**
	 * `Math.max(30, Math.min(NaN, 600))` is NaN, and `setInterval(fn, NaN)` runs every
	 * millisecond. A non-numeric `vscodeTodo.sync.pollInterval` (hand-edited settings) turns
	 * polling into a request storm against the gist API.
	 */
	testKnownBug("a non-numeric poll interval falls back to a sane cadence", async () => {
		resetAuthSingleton();
		const context = {
			globalState: memento(new Map([["syncMode", "github"]])),
			workspaceState: memento(new Map([["syncMode", "local"]])),
			secrets: { get: () => Promise.resolve("token") },
		} as unknown as vscode.ExtensionContext;
		const manager = new SyncManager(context);
		let syncs = 0;
		(manager as unknown as { sync: () => Promise<{ success: boolean }> }).sync = async () => {
			syncs++;
			return { success: true };
		};
		try {
			manager.startPolling("user", Number.NaN);
			await new Promise((resolve) => setTimeout(resolve, 60));
		} finally {
			manager.stopPolling("user");
			manager.dispose();
			resetAuthSingleton();
		}
		assert.ok(syncs <= 1, `expected only the initial sync, got ${syncs}`);
	});
});
