/**
 * Framework-agnostic sync engine. Reconciles one gist file at a time using the same
 * content-based three-way merge the VS Code extension uses, so the PWA is a well-behaved
 * peer that never clobbers the extension's edits.
 *
 * Per file it keeps a {@link GistCache}: `data` (last known good), `lastCleanRemoteData`
 * (the merge baseline — what we last saw clean on the remote), `lastSynced`, `isDirty`.
 * The cache is persisted through a pluggable {@link CacheStore} (IndexedDB in the PWA).
 */

import { isEqual } from "./pure";
import {
	threeWayMerge,
	threeWayMergeWorkspace,
	mergeWithPreservedPositions,
	ConflictSet,
} from "./threeWayMerge";
import {
	GistCache,
	GlobalGistData,
	WorkspaceGistData,
	FileConflictSet,
	SyncErrorType,
	SyncResult,
} from "./syncTypes";
import { Todo, TodoFilesData, TodoFilesDataPaths } from "./todoTypes";

/**
 * The subset of {@link GistClient} the engine needs. Depending on this structural interface
 * (rather than the concrete client) keeps the engine testable with an in-memory fake.
 */
export interface GistFileIO {
	readFile(gistId: string, fileName: string): Promise<SyncResult<string>>;
	writeFile(gistId: string, fileName: string, content: string): Promise<SyncResult<unknown>>;
}

/** Pluggable persistence for per-file sync caches (e.g. IndexedDB in the browser). */
export interface CacheStore {
	load<T>(key: string): Promise<GistCache<T> | undefined>;
	save<T>(key: string, cache: GistCache<T>): Promise<void>;
}

/** In-memory cache store. Useful for tests and as a non-persistent default. */
export class MemoryCacheStore implements CacheStore {
	private readonly map = new Map<string, GistCache<unknown>>();
	async load<T>(key: string): Promise<GistCache<T> | undefined> {
		return this.map.get(key) as GistCache<T> | undefined;
	}
	async save<T>(key: string, cache: GistCache<T>): Promise<void> {
		this.map.set(key, cache as GistCache<unknown>);
	}
}

/**
 * How to resolve true conflicts (the same item edited differently on both sides) when no
 * interactive resolver is supplied. Non-conflicting changes always auto-merge regardless.
 */
export type ConflictPolicy = "prefer-local" | "prefer-remote";

export interface GistSyncEngineOptions {
	client: GistFileIO;
	gistId: string;
	cacheStore?: CacheStore;
	/** Default policy for unresolved conflicts. Defaults to "prefer-local". */
	conflictPolicy?: ConflictPolicy;
	logger?: (message: string) => void;
}

/** Outcome of reconciling a single file. */
export interface ReconcileResult<T> {
	/** The reconciled data (already persisted to the gist when `pushed` is true). */
	data: T;
	/** True if the remote had changes we pulled/merged in. */
	changedRemotely: boolean;
	/** True if we wrote to the gist. */
	pushed: boolean;
	/** Todo-level conflicts that were auto-resolved by policy (surface these in the UI). */
	conflicts: ConflictSet[];
	/** File-level conflicts (workspace scope) auto-resolved by policy. */
	fileConflicts: FileConflictSet[];
}

const EMPTY_GLOBAL: GlobalGistData = { userTodos: [] };
const emptyWorkspace = (): WorkspaceGistData => ({ workspaceTodos: [], filesData: {}, filesDataPaths: {} });

export class GistSyncEngine {
	private readonly client: GistFileIO;
	private readonly gistId: string;
	private readonly store: CacheStore;
	private readonly policy: ConflictPolicy;
	private readonly logger?: (message: string) => void;

	constructor(options: GistSyncEngineOptions) {
		this.client = options.client;
		this.gistId = options.gistId;
		this.store = options.cacheStore ?? new MemoryCacheStore();
		this.policy = options.conflictPolicy ?? "prefer-local";
		this.logger = options.logger;
	}

	private cacheKey(scope: "global" | "workspace", fileName: string): string {
		return `gistCache_${scope}_${fileName}`;
	}

	/**
	 * Last known good data for a file, or undefined if this device has never synced it.
	 *
	 * A caller that keeps its own copy of the data between sessions MUST restore it from here
	 * before the first reconcile. The persisted cache also holds the merge baseline, so starting
	 * with empty local state against a populated baseline makes the reconcile read a deletion
	 * and push the empty state over the remote.
	 */
	public async loadCachedUser(fileName: string): Promise<GlobalGistData | undefined> {
		return (await this.store.load<GlobalGistData>(this.cacheKey("global", fileName)))?.data;
	}

	/** Workspace counterpart of {@link loadCachedUser}. */
	public async loadCachedWorkspace(fileName: string): Promise<WorkspaceGistData | undefined> {
		return (await this.store.load<WorkspaceGistData>(this.cacheKey("workspace", fileName)))?.data;
	}

	/** Picks the winning side for each conflict per the active policy; dropped if that side deleted. */
	private resolve(conflicts: ConflictSet[]): Todo[] {
		const resolved: Todo[] = [];
		for (const c of conflicts) {
			const pick = this.policy === "prefer-remote" ? c.remote : c.local;
			if (pick) {
				resolved.push(pick);
			}
		}
		return resolved;
	}

	/**
	 * Reconcile the user/global file. Pass the app's current local data; receive the merged
	 * data that is now both local and on the gist.
	 */
	public async reconcileUser(fileName: string, localData: GlobalGistData): Promise<SyncResult<ReconcileResult<GlobalGistData>>> {
		return this.reconcile("global", fileName, localData, {
			empty: () => ({ userTodos: [] }),
			parse: parseGlobal,
			merge: (base, local, remote) => {
				const { autoMerged, conflicts } = threeWayMerge(base.userTodos, local.userTodos, remote.userTodos);
				const resolved = this.resolve(conflicts);
				const finalTodos = mergeWithPreservedPositions(autoMerged, resolved, base.userTodos);
				return { merged: { userTodos: finalTodos }, conflicts, fileConflicts: [] };
			},
		});
	}

	/** Reconcile a workspace file (workspaceTodos + per-file todos). */
	public async reconcileWorkspace(
		fileName: string,
		localData: WorkspaceGistData
	): Promise<SyncResult<ReconcileResult<WorkspaceGistData>>> {
		return this.reconcile("workspace", fileName, localData, {
			empty: emptyWorkspace,
			parse: parseWorkspace,
			merge: (base, local, remote) => {
				const result = threeWayMergeWorkspace(
					base.workspaceTodos,
					local.workspaceTodos,
					remote.workspaceTodos,
					base.filesData,
					local.filesData,
					remote.filesData,
					base.filesDataPaths ?? {},
					local.filesDataPaths ?? {},
					remote.filesDataPaths ?? {}
				);
				const resolvedWs = this.resolve(result.workspaceConflicts);
				const finalWorkspaceTodos = mergeWithPreservedPositions(
					result.autoMergedWorkspaceTodos,
					resolvedWs,
					base.workspaceTodos
				);
				const finalFilesData: TodoFilesData = { ...result.autoMergedFilesData };
				for (const fc of result.fileConflicts) {
					const pick = this.policy === "prefer-remote" ? fc.remote : fc.local;
					if (pick) {
						finalFilesData[fc.filePath] = pick;
					}
				}
				const merged: WorkspaceGistData = {
					workspaceTodos: finalWorkspaceTodos,
					filesData: finalFilesData,
					filesDataPaths: result.autoMergedFilesDataPaths,
				};
				return { merged, conflicts: result.workspaceConflicts, fileConflicts: result.fileConflicts };
			},
		});
	}

	private async reconcile<T extends object>(
		scope: "global" | "workspace",
		fileName: string,
		localData: T,
		strategy: {
			empty: () => T;
			parse: (raw: string) => T;
			merge: (base: T, local: T, remote: T) => { merged: T; conflicts: ConflictSet[]; fileConflicts: FileConflictSet[] };
		}
	): Promise<SyncResult<ReconcileResult<T>>> {
		const key = this.cacheKey(scope, fileName);
		const cache = (await this.store.load<T>(key)) ?? {
			data: localData,
			lastCleanRemoteData: undefined,
			lastSynced: new Date(0).toISOString(),
			isDirty: false,
		};

		// 1. Read the remote file. A missing file means we need to create it.
		const remoteRead = await this.client.readFile(this.gistId, fileName);
		let remoteData: T | null;
		if (remoteRead.success) {
			remoteData = strategy.parse(remoteRead.data ?? "");
		} else if (remoteRead.error?.type === SyncErrorType.FileNotFoundError) {
			remoteData = null;
		} else {
			return { success: false, error: remoteRead.error };
		}

		// 2. Remote file doesn't exist yet → seed it with our local data.
		if (remoteData === null) {
			const write = await this.client.writeFile(this.gistId, fileName, serialize(localData));
			if (!write.success) {
				return { success: false, error: write.error };
			}
			await this.saveCache(key, localData, localData);
			return this.ok({ data: localData, changedRemotely: false, pushed: true, conflicts: [], fileConflicts: [] });
		}

		// No baseline means we have never seen this file before on this device (fresh install,
		// cleared storage, or a cache reset after switching gists). There is no evidence that a
		// local/remote difference is a local *edit*, so a push here would destroy remote content
		// the user never touched. Bootstrap instead: adopt the remote, and merge rather than
		// overwrite if we happen to be holding local data too.
		if (cache.lastCleanRemoteData === undefined) {
			return this.bootstrap(key, fileName, remoteData, localData, strategy);
		}

		const base = cache.lastCleanRemoteData;
		const remoteChanged = !isEqual(remoteData, base);
		const localChanged = !isEqual(localData, base);

		// 3a. Nothing changed on either side.
		if (!remoteChanged && !localChanged) {
			await this.saveCache(key, remoteData, remoteData);
			return this.ok({ data: remoteData, changedRemotely: false, pushed: false, conflicts: [], fileConflicts: [] });
		}

		// 3b. Only remote changed → pull.
		if (remoteChanged && !localChanged) {
			await this.saveCache(key, remoteData, remoteData);
			return this.ok({ data: remoteData, changedRemotely: true, pushed: false, conflicts: [], fileConflicts: [] });
		}

		// 3c. Only local changed → push.
		if (!remoteChanged && localChanged) {
			const write = await this.client.writeFile(this.gistId, fileName, serialize(localData));
			if (!write.success) {
				return { success: false, error: write.error };
			}
			await this.saveCache(key, localData, localData);
			return this.ok({ data: localData, changedRemotely: false, pushed: true, conflicts: [], fileConflicts: [] });
		}

		// 3d. Both changed → three-way merge, then push the merged result.
		const { merged, conflicts, fileConflicts } = strategy.merge(base, localData, remoteData);
		const write = await this.client.writeFile(this.gistId, fileName, serialize(merged));
		if (!write.success) {
			return { success: false, error: write.error };
		}
		await this.saveCache(key, merged, merged);
		return this.ok({ data: merged, changedRemotely: true, pushed: true, conflicts, fileConflicts });
	}

	/**
	 * First reconcile of a file on this device, with no baseline to diff against.
	 *
	 * Never treats the local state as authoritative: without a baseline we cannot tell a local
	 * edit from simply not having pulled yet, and guessing wrong destroys remote data. If local
	 * is empty (the common case: fresh install, or the cache was reset when switching gists) the
	 * remote is adopted verbatim and nothing is written. If we do hold local data, it is merged
	 * against an *empty* base so both sides read as additions and neither is deleted.
	 */
	private async bootstrap<T extends object>(
		key: string,
		fileName: string,
		remoteData: T,
		localData: T,
		strategy: {
			empty: () => T;
			merge: (base: T, local: T, remote: T) => { merged: T; conflicts: ConflictSet[]; fileConflicts: FileConflictSet[] };
		}
	): Promise<SyncResult<ReconcileResult<T>>> {
		const empty = strategy.empty();

		// Nothing of our own to contribute → pull, seeding the baseline for later reconciles.
		if (isEqual(localData, empty) || isEqual(localData, remoteData)) {
			await this.saveCache(key, remoteData, remoteData);
			return this.ok({
				data: remoteData,
				changedRemotely: !isEqual(localData, remoteData),
				pushed: false,
				conflicts: [],
				fileConflicts: [],
			});
		}

		const { merged, conflicts, fileConflicts } = strategy.merge(empty, localData, remoteData);
		const write = await this.client.writeFile(this.gistId, fileName, serialize(merged));
		if (!write.success) {
			return { success: false, error: write.error };
		}
		await this.saveCache(key, merged, merged);
		return this.ok({ data: merged, changedRemotely: true, pushed: true, conflicts, fileConflicts });
	}

	private async saveCache<T>(key: string, data: T, lastCleanRemoteData: T): Promise<void> {
		await this.store.save<T>(key, {
			data,
			lastCleanRemoteData,
			lastSynced: new Date().toISOString(),
			isDirty: false,
		});
	}

	private ok<T>(result: ReconcileResult<T>): SyncResult<ReconcileResult<T>> {
		this.logger?.(
			`[GistSyncEngine] reconciled: pushed=${result.pushed} changedRemotely=${result.changedRemotely} ` +
				`conflicts=${result.conflicts.length} fileConflicts=${result.fileConflicts.length}`
		);
		return { success: true, data: result };
	}
}

/** Serializes gist data exactly as the extension does (pretty-printed, 2-space). */
export function serialize(data: unknown): string {
	// Keys are written in sorted order so identical content always produces identical bytes,
	// matching how the extension writes filesData (sortByFileName) and keeping gist revisions
	// free of diffs that are pure key reordering. Array order is preserved — it is meaningful.
	return JSON.stringify(data, (_key, value) => sortObjectKeys(value), 2);
}

/** Returns plain objects with keys in sorted order; arrays and primitives pass through. */
function sortObjectKeys(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		sorted[key] = source[key];
	}
	return sorted;
}

function parseGlobal(raw: string): GlobalGistData {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return { ...EMPTY_GLOBAL };
	}
	try {
		const parsed = JSON.parse(trimmed) as Partial<GlobalGistData>;
		return { userTodos: Array.isArray(parsed.userTodos) ? (parsed.userTodos as Todo[]) : [] };
	} catch {
		return { ...EMPTY_GLOBAL };
	}
}

function parseWorkspace(raw: string): WorkspaceGistData {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return emptyWorkspace();
	}
	try {
		const parsed = JSON.parse(trimmed) as Partial<WorkspaceGistData>;
		return {
			workspaceTodos: Array.isArray(parsed.workspaceTodos) ? (parsed.workspaceTodos as Todo[]) : [],
			filesData: (parsed.filesData as TodoFilesData) ?? {},
			filesDataPaths: (parsed.filesDataPaths as TodoFilesDataPaths) ?? {},
		};
	} catch {
		return emptyWorkspace();
	}
}
