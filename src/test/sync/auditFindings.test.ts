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
import * as vscode from "vscode";
import { SyncManager } from "../../sync/SyncManager";
import { GitHubAuthManager } from "../../sync/GitHubAuthManager";
import { StorageKeys, WorkspaceGistData } from "../../sync/syncTypes";
import StorageSyncManager from "../../storage/StorageSyncManager";
import { serialize } from "../../core";
import { CurrentFileSlice, Todo, TodoScope } from "../../todo/todoTypes";

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
