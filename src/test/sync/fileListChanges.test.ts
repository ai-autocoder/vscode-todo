/**
 * Renaming, deleting and importing change the per-file lists outside the current-file slice.
 * They used to write only the `TodoFilesData` memento, and the next per-file persist rebuilt the
 * lists from the storage (`workspaceData.json`'s cache, or the gist cache) and wrote that back
 * over it. Renaming the open file deleted its list, left it under the old path or kept it under
 * both, depending on which file that persist was for; an import kept only the open file's part.
 *
 * These run the real store, `StorageSyncManager` and handlers, with a subscriber that persists
 * each slice change the way the extension's `store.subscribe` does.
 */

import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import StorageSyncManager from "../../storage/StorageSyncManager";
import createStore, {
	actionTrackerActions,
	currentFileActions,
	editorFocusAndRecordsActions,
} from "../../todo/store";
import { importCommand } from "../../todo/importer";
import { removeDataForDeletedFile, updateDataForRenamedFile } from "../../todo/todoUtils";
import { GistCache, StorageKeys, WorkspaceGistData } from "../../sync/syncTypes";
import { isEqual } from "../../core";
import {
	ImportFormats,
	Slices,
	StoreState,
	Todo,
	TodoFilesChange,
	TodoFilesData,
} from "../../todo/todoTypes";

const root = process.platform === "win32" ? "C:\\work\\lists" : "/work/lists";
const A = path.join(root, "src", "a.ts");
const B = path.join(root, "src", "b.ts");
const C = path.join(root, "src", "c.ts");
const D = path.join(root, "src", "d.ts");

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

function workspaceFileName(): string {
	const configured = vscode.workspace
		.getConfiguration("vscodeTodo.sync")
		.get<string>("github.workspaceFile");
	return configured || `workspace-${vscode.workspace.name || "default"}.json`;
}

function texts(filesData: TodoFilesData, filePath: string): string[] | undefined {
	return filesData[filePath]?.map((t) => t.text);
}

/** Persists every slice change, as the extension's store subscriber does. */
function persistSliceChanges(
	store: EnhancedStore<StoreState>,
	storage: StorageSyncManager
): Promise<void>[] {
	const persists: Promise<void>[] = [];
	store.subscribe(() => {
		const state = store.getState();
		const slice = state.actionTracker.lastSliceName;
		if (slice === Slices.unset || slice === Slices.actionTracker) {
			return;
		}
		store.dispatch(actionTrackerActions.resetLastSliceName());
		if (slice === Slices.user || slice === Slices.workspace || slice === Slices.currentFile) {
			persists.push(storage.persistSlice(state[slice]));
		}
	});
	return persists;
}

type Harness = {
	store: EnhancedStore<StoreState>;
	storage: StorageSyncManager;
	context: vscode.ExtensionContext;
	workspaceStore: Map<string, unknown>;
	/** The per-file lists where the next write rebuilds them from. */
	stored(): TodoFilesData;
	/** The per-file lists the rest of the extension reads. */
	shown(): TodoFilesData;
	/** Waits for every persist and file-list change so far. */
	settle(): Promise<void>;
	/** The editor shows `filePath`: the slice is loaded with its list, as a tab switch does. */
	open(filePath: string): void;
	dispose(): void;
};

suite("Per-file lists: rename, delete and import", () => {
	let originalFolders: PropertyDescriptor | undefined;
	let originalGetWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder;
	const folder = { uri: vscode.Uri.file(root), name: "lists", index: 0 } as vscode.WorkspaceFolder;

	// Relative aliases and import need an open folder, and the test host has none.
	suiteSetup(() => {
		originalFolders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			get: () => [folder],
		});
		originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
		(
			vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }
		).getWorkspaceFolder = (uri: vscode.Uri) =>
			uri.fsPath.startsWith(folder.uri.fsPath) ? folder : undefined;
	});

	suiteTeardown(() => {
		if (originalFolders) {
			Object.defineProperty(vscode.workspace, "workspaceFolders", originalFolders);
		} else {
			delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;
		}
		(
			vscode.workspace as { getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder }
		).getWorkspaceFolder = originalGetWorkspaceFolder;
	});

	function harness(
		workspaceStore: Map<string, unknown>,
		stored: () => TodoFilesData,
		extra: object = {}
	): Harness {
		const context = {
			globalState: memento(new Map([["syncMode", "profile-local"]])),
			workspaceState: memento(workspaceStore),
			subscriptions: [] as vscode.Disposable[],
			...extra,
		} as unknown as vscode.ExtensionContext;
		const store = createStore();
		const storage = new StorageSyncManager(context, store);
		const persists = persistSliceChanges(store, storage);
		const changes: Promise<void>[] = [];
		const updateFiles = storage.updateFiles.bind(storage);
		storage.updateFiles = (change: TodoFilesChange) => {
			const written = updateFiles(change);
			changes.push(written);
			return written;
		};
		return {
			store,
			storage,
			context,
			workspaceStore,
			stored,
			shown: () => (workspaceStore.get("TodoFilesData") as TodoFilesData) ?? {},
			settle: async () => {
				await Promise.all([...persists, ...changes]);
			},
			open: (filePath: string) => {
				store.dispatch(editorFocusAndRecordsActions.setCurrentFile(filePath));
				const shown = (workspaceStore.get("TodoFilesData") as TodoFilesData) ?? {};
				store.dispatch(currentFileActions.loadData({ filePath, data: shown[filePath] ?? [] }));
			},
			dispose: () => context.subscriptions.forEach((disposable) => disposable.dispose()),
		};
	}

	/** Local mode, over a real `workspaceData.json`; `files` is what it holds at the start. */
	async function localWorkspace(files: TodoFilesData): Promise<Harness & { dir: string }> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-todo-file-lists-"));
		const workspaceStore = new Map<string, unknown>([
			["syncMode", "local"],
			["TodoFilesData", files],
		]);
		const dataFile = path.join(dir, "workspace", "workspaceData.json");
		const h = harness(
			workspaceStore,
			() => (JSON.parse(fs.readFileSync(dataFile, "utf8")) as WorkspaceGistData).filesData,
			{
				globalStorageUri: vscode.Uri.file(path.join(dir, "global")),
				storageUri: vscode.Uri.file(path.join(dir, "workspace")),
			}
		);
		await h.storage.initialize();
		const dispose = h.dispose;
		return {
			...h,
			dir,
			dispose: () => {
				dispose();
				// Windows can hold the directory for a moment after the watchers go.
				try {
					fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
				} catch {
					// Left for the OS to clean up.
				}
			},
		};
	}

	function gistCache(workspaceStore: Map<string, unknown>): GistCache<WorkspaceGistData> {
		return workspaceStore.get(
			StorageKeys.workspaceGistCache(workspaceFileName())
		) as GistCache<WorkspaceGistData>;
	}

	/** GitHub mode: the gist cache is clean and holds `files`, and the memento shows them. */
	function githubWorkspace(files: TodoFilesData): Harness {
		const data: WorkspaceGistData = { workspaceTodos: [], filesData: files, filesDataPaths: {} };
		const workspaceStore = new Map<string, unknown>([
			["syncMode", "github"],
			["TodoFilesData", structuredClone(files)],
			[
				StorageKeys.workspaceGistCache(workspaceFileName()),
				{
					data: structuredClone(data),
					lastCleanRemoteData: structuredClone(data),
					lastSynced: "2026-01-01T00:00:00.000Z",
					isDirty: false,
				},
			],
		]);
		return harness(workspaceStore, () => gistCache(workspaceStore).data.filesData);
	}

	function rename(h: Harness, oldPath: string, newPath: string): void {
		updateDataForRenamedFile({
			oldPath,
			newPath,
			context: h.context,
			store: h.store,
			storage: h.storage,
		});
	}

	function remove(h: Harness, filePath: string): void {
		removeDataForDeletedFile({ filePath, context: h.context, store: h.store, storage: h.storage });
	}

	function assertOnlyUnder(h: Harness, list: string[], filePath: string, gone: string): void {
		for (const [where, files] of [
			["storage", h.stored()],
			["memento", h.shown()],
		] as const) {
			assert.deepStrictEqual(
				texts(files, filePath),
				list,
				`${where}: the list is not under the new path`
			);
			assert.strictEqual(
				texts(files, gone),
				undefined,
				`${where}: the list is still under the old path`
			);
		}
	}

	suite("renaming the open file", () => {
		test("keeps its list when the editor still shows the old path", async () => {
			const h = await localWorkspace({ [A]: [todo(1, "one")] });
			try {
				h.open(A);
				await h.settle();

				rename(h, A, B);
				await h.settle();

				assertOnlyUnder(h, ["one"], B, A);
				assert.strictEqual(
					h.store.getState().currentFile.filePath,
					B,
					"the slice should follow the file"
				);
				assert.deepStrictEqual(
					h.store.getState().currentFile.todos.map((t) => t.text),
					["one"]
				);
			} finally {
				h.dispose();
			}
		});

		test("does not keep a copy under the old path when the editor already shows the new one", async () => {
			const h = await localWorkspace({ [A]: [todo(1, "one")] });
			try {
				h.open(A);
				h.open(B);
				await h.settle();

				rename(h, A, B);
				await h.settle();

				assertOnlyUnder(h, ["one"], B, A);
			} finally {
				h.dispose();
			}
		});

		test("moves the list while the slice shows another file", async () => {
			const h = await localWorkspace({ [A]: [todo(1, "one")], [C]: [todo(3, "three")] });
			try {
				h.open(C);
				await h.settle();

				rename(h, A, B);
				await h.settle();

				assertOnlyUnder(h, ["one"], B, A);
				assert.deepStrictEqual(texts(h.stored(), C), ["three"]);
				assert.strictEqual(h.store.getState().currentFile.filePath, C);
			} finally {
				h.dispose();
			}
		});

		test("GitHub mode: moves the list in the gist cache and leaves it owing a push", async () => {
			const h = githubWorkspace({ [A]: [todo(1, "one")] });
			h.open(A);
			await h.settle();

			rename(h, A, B);
			await h.settle();

			assertOnlyUnder(h, ["one"], B, A);
			assert.strictEqual(gistCache(h.workspaceStore).isDirty, true);
		});
	});

	test("GitHub mode: renaming a file with no list leaves the gist cache as it was", async () => {
		const h = githubWorkspace({ [A]: [todo(1, "one")] });
		const before = structuredClone(gistCache(h.workspaceStore));

		rename(h, C, D);
		await h.settle();

		assert.deepStrictEqual(gistCache(h.workspaceStore), before);
	});

	test("GitHub mode: a change to the stored lists is announced for a push, with no file shown", async () => {
		const h = githubWorkspace({ [A]: [todo(1, "one")] });
		let announced = 0;
		h.storage.onDidUpdateFiles(() => announced++);

		rename(h, C, D);
		await h.settle();
		assert.strictEqual(announced, 0, "a rename that moved nothing has nothing to push");

		rename(h, A, B);
		await h.settle();
		assert.strictEqual(h.store.getState().currentFile.filePath, "", "the test needs no file shown");
		assert.strictEqual(announced, 1, "the moved list would wait for the next poll");

		h.open(B);
		h.store.dispatch(currentFileActions.addTodo({ text: "two" } as never));
		await h.settle();
		assert.strictEqual(announced, 1, "a slice edit is pushed by the store subscriber, not announced");
	});

	suite("deleting a file", () => {
		test("drops the open file's list", async () => {
			const h = await localWorkspace({ [A]: [todo(1, "one")], [C]: [todo(3, "three")] });
			try {
				h.open(A);
				await h.settle();

				remove(h, A);
				await h.settle();

				for (const files of [h.stored(), h.shown()]) {
					assert.strictEqual(texts(files, A), undefined);
					assert.deepStrictEqual(texts(files, C), ["three"]);
				}
			} finally {
				h.dispose();
			}
		});

		test("does not bring the list back with the next edit to another file", async () => {
			const h = githubWorkspace({ [A]: [todo(1, "one")], [C]: [todo(3, "three")] });
			h.open(C);
			await h.settle();

			remove(h, A);
			h.store.dispatch(currentFileActions.addTodo({ text: "four" } as never));
			await h.settle();

			for (const files of [h.stored(), h.shown()]) {
				assert.strictEqual(texts(files, A), undefined, "the deleted file's list came back");
				assert.ok(texts(files, C)?.includes("four"));
			}
		});
	});

	suite("importing per-file lists", () => {
		let dir: string;
		let originalFindFiles: typeof vscode.workspace.findFiles;
		let originalShowQuickPick: typeof vscode.window.showQuickPick;

		setup(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-todo-import-"));
			originalFindFiles = vscode.workspace.findFiles;
			originalShowQuickPick = vscode.window.showQuickPick;
		});

		teardown(() => {
			(vscode.workspace as { findFiles: unknown }).findFiles = originalFindFiles;
			(vscode.window as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick;
			fs.rmSync(dir, { recursive: true, force: true });
		});

		/** Runs the JSON import command on a file holding `content`, picked in the quick pick. */
		async function importJson(h: Harness, content: object): Promise<void> {
			const file = path.join(dir, "import.json");
			fs.writeFileSync(file, JSON.stringify(content), "utf8");
			(vscode.workspace as { findFiles: unknown }).findFiles = async () => [vscode.Uri.file(file)];
			(vscode.window as { showQuickPick: unknown }).showQuickPick = async (
				items: readonly vscode.QuickPickItem[]
			) => items[0];
			await importCommand(h.context, ImportFormats.JSON, h.store, h.storage);
		}

		test("stores every imported file, not only the open one", async () => {
			const h = githubWorkspace({ [A]: [todo(1, "one")] });
			h.open(A);
			await h.settle();

			await importJson(h, { files: { [A]: [{ text: "imported a" }], [D]: [{ text: "imported d" }] } });
			await h.settle();

			for (const [where, files] of [
				["storage", h.stored()],
				["memento", h.shown()],
			] as const) {
				assert.deepStrictEqual(texts(files, A), ["one", "imported a"], where);
				assert.deepStrictEqual(
					texts(files, D),
					["imported d"],
					`${where}: another file's import was dropped`
				);
			}
		});

		test("shows at once the same todos it stores", async () => {
			const h = githubWorkspace({ [A]: [todo(1, "one")] });
			let shownAtOnce: TodoFilesData | undefined;
			const updateFiles = h.storage.updateFiles;
			h.storage.updateFiles = (change: TodoFilesChange) => {
				const written = updateFiles(change);
				shownAtOnce = structuredClone(h.shown());
				return written;
			};

			await importJson(h, { files: { [D]: [{ text: "d1" }, { text: "d2", completed: true }] } });
			await h.settle();

			assert.ok(shownAtOnce, "the import did not go through the storage");
			assert.ok(
				isEqual(shownAtOnce[D], h.stored()[D]),
				"new ids and dates must not differ between what is shown and what is stored"
			);
		});
	});
});
