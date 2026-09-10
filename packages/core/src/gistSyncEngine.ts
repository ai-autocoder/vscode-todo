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
	assembleMerged,
	resolveFileConflict,
	ConflictSet,
} from "./threeWayMerge";
import {
	GistCache,
	GlobalGistData,
	WorkspaceGistData,
	FileConflictSet,
	SyncError,
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

/**
 * What an interactive {@link ConflictResolver} decided.
 *
 * Sparse on purpose: anything the resolver leaves out falls back to the engine's
 * {@link ConflictPolicy}, so a resolver may decide some conflicts and defer the rest (the VS
 * Code dialog's "Skip This Conflict" does exactly that).
 *
 * A `null` value means "keep no version of this item" — i.e. accept the deletion. Note this is
 * different from leaving the key out, which defers to the policy.
 */
export interface ConflictDecisions {
	/** Winning version per conflicting todo id. */
	todos?: Map<number, Todo | null>;
	/** Winning list per conflicting file path (workspace scope). */
	files?: Map<string, Todo[] | null>;
	/**
	 * Extra todos to add to the merged list, keyed by the conflicting todo id they were raised
	 * from — for a resolver that wants to keep *both* versions.
	 *
	 * An `id-collision` is the case that needs this: the two todos were created independently on
	 * the two devices and merely drew the same random id, so they are not versions of each other
	 * and picking a side destroys a real item. Keeping both means re-adding one under a fresh id,
	 * which no per-id decision can express. Ids must not already be in use — pick them with
	 * `generateUniqueId` over the `knownIds` the resolver was handed.
	 *
	 * Keyed rather than a flat list so each copy can be placed next to the item it came from.
	 * Appended at the end instead, a "keep both" splits the pair across the list and reads as an
	 * unrelated todo that appeared at the bottom.
	 */
	extraTodos?: Map<number, Todo[]>;
}

/**
 * Hook for a host that wants to ask the user instead of applying a policy.
 *
 * Called during a reconcile, before anything is written, whenever a merge produces conflicts.
 * Return `null` to abort the whole reconcile: nothing is pushed, the baseline is left alone,
 * and the caller gets a retryable {@link SyncErrorType.ConflictError} — so the next sync
 * presents the same decision rather than silently picking a side.
 *
 * May be called more than once per reconcile: if the remote moves during the write window the
 * engine re-merges against the fresh content, and genuinely new conflicts need deciding too.
 * Conflicts already settled do not come back — the previous decision is in the data being
 * re-merged, so the fresh remote has to disagree with *that* to conflict again.
 *
 * The PWA supplies none of this and keeps the policy path, recording what was decided for
 * after-the-fact review; the extension supplies one and blocks on a quick pick.
 */
export type ConflictResolver = (conflicts: {
	todos: ConflictSet[];
	files: FileConflictSet[];
	/**
	 * Every todo id this merge touched (base, local and remote sides of the list being merged).
	 * A resolver returning {@link ConflictDecisions.extraTodos} picks free ids against this.
	 */
	knownIds: number[];
}) => Promise<ConflictDecisions | null>;

export interface GistSyncEngineOptions {
	client: GistFileIO;
	gistId: string;
	cacheStore?: CacheStore;
	/** Default policy for unresolved conflicts. Defaults to "prefer-local". */
	conflictPolicy?: ConflictPolicy;
	/** Optional interactive resolver; anything it does not decide falls back to the policy. */
	conflictResolver?: ConflictResolver;
	logger?: (message: string) => void;
}

/** Raised internally when a {@link ConflictResolver} returns null. Never escapes the engine. */
class ConflictCancelled extends Error {
	constructor() {
		super("Conflict resolution cancelled");
		this.name = "ConflictCancelled";
	}
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

const emptyWorkspace = (): WorkspaceGistData => ({ workspaceTodos: [], filesData: {}, filesDataPaths: {} });

/** Union of the todo ids across the lists a merge saw; handed to a {@link ConflictResolver}. */
function idsIn(...lists: Todo[][]): number[] {
	return [...new Set(lists.flat().map((todo) => todo.id))];
}

/**
 * Deep copy of gist data. Everything the engine stores is JSON by construction — it is read
 * from and written to a gist file — so a JSON round trip is both sufficient and exact.
 */
function cloneData<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export class GistSyncEngine {
	private readonly client: GistFileIO;
	private readonly gistId: string;
	private readonly store: CacheStore;
	private readonly policy: ConflictPolicy;
	private readonly resolver?: ConflictResolver;
	private readonly logger?: (message: string) => void;

	constructor(options: GistSyncEngineOptions) {
		this.client = options.client;
		this.gistId = options.gistId;
		this.store = options.cacheStore ?? new MemoryCacheStore();
		this.policy = options.conflictPolicy ?? "prefer-local";
		this.resolver = options.conflictResolver;
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

	/**
	 * Records local data as an unsynced edit, without touching the merge baseline.
	 *
	 * Callers that debounce their pushes need this. Between the edit and the reconcile the only
	 * copy of the change lives in the caller's memory, so a reload in that window (on mobile,
	 * merely switching apps) loses it. Persisting here means the next session rehydrates the
	 * edit, and because `lastCleanRemoteData` is left alone the reconcile still reads it as a
	 * genuine local change and pushes it.
	 *
	 * No-op before the file's first reconcile: with no cache entry there is no baseline to
	 * preserve, and writing `data` alone would leave `lastCleanRemoteData` undefined — which the
	 * next reconcile reads as a cold cache and bootstraps from, exactly the safe path we want.
	 */
	public async persistLocalUser(fileName: string, localData: GlobalGistData): Promise<void> {
		await this.persistLocal(this.cacheKey("global", fileName), localData);
	}

	/** Workspace counterpart of {@link persistLocalUser}. */
	public async persistLocalWorkspace(fileName: string, localData: WorkspaceGistData): Promise<void> {
		await this.persistLocal(this.cacheKey("workspace", fileName), localData);
	}

	private async persistLocal<T extends object>(key: string, localData: T): Promise<void> {
		const cache = await this.store.load<T>(key);
		if (!cache) {
			return;
		}
		const base = cache.lastCleanRemoteData;
		await this.store.save<T>(key, {
			...cache,
			data: localData,
			isDirty: base === undefined || !isEqual(localData, base),
		});
	}

	/**
	 * Folds a completed reconcile's result back into local state that has moved on since the
	 * snapshot the reconcile was given.
	 *
	 * Callers debounce their pushes, so an edit can land while a reconcile is on the network. The
	 * result that comes back is then stale in one direction (it lacks the new edit) and ahead in
	 * the other (it carries whatever the remote contributed). Adopting it drops the edit; keeping
	 * local wholesale drops the remote's changes — and the engine has already moved its baseline
	 * to the reconciled data, so a dropped remote change reads as a local deletion on the next
	 * pass and gets pushed away.
	 *
	 * Both sides are kept by merging with the *snapshot* as the base: relative to it, the local
	 * edit and the remote's changes are each plain additions/edits, so the standard three-way
	 * merge combines them. The caller adopts the return value and schedules another push.
	 *
	 * Conflicts this second merge resolves are returned alongside the data: they are real
	 * conflicts between the user and the remote, and a caller that surfaces the first merge's
	 * conflicts must surface these too or the mid-flight path stays silent.
	 */
	public reconcileWithLocalEdits(
		snapshot: GlobalGistData,
		reconciled: GlobalGistData,
		currentLocal: GlobalGistData
	): { data: GlobalGistData; conflicts: ConflictSet[] } {
		const merge = threeWayMerge(snapshot.userTodos, currentLocal.userTodos, reconciled.userTodos);
		const { picks, extras } = this.resolve(merge.conflicts);
		return {
			data: { userTodos: assembleMerged(merge, picks, extras) },
			conflicts: merge.conflicts,
		};
	}

	/** Workspace counterpart of {@link reconcileWithLocalEdits}. */
	public reconcileWorkspaceWithLocalEdits(
		snapshot: WorkspaceGistData,
		reconciled: WorkspaceGistData,
		currentLocal: WorkspaceGistData
	): {
		data: WorkspaceGistData;
		conflicts: ConflictSet[];
		fileConflicts: FileConflictSet[];
	} {
		const result = threeWayMergeWorkspace(
			snapshot.workspaceTodos,
			currentLocal.workspaceTodos,
			reconciled.workspaceTodos,
			snapshot.filesData ?? {},
			currentLocal.filesData ?? {},
			reconciled.filesData ?? {},
			snapshot.filesDataPaths ?? {},
			currentLocal.filesDataPaths ?? {},
			reconciled.filesDataPaths ?? {}
		);
		const { picks, extras } = this.resolve(result.workspaceMerge.conflicts);
		const finalFilesData = this.resolveFiles(result.autoMergedFilesData, result.fileConflicts);
		return {
			data: {
				workspaceTodos: assembleMerged(result.workspaceMerge, picks, extras),
				filesData: finalFilesData,
				filesDataPaths: result.autoMergedFilesDataPaths,
			},
			conflicts: result.workspaceMerge.conflicts,
			fileConflicts: result.fileConflicts,
		};
	}

	/**
	 * Applies the active policy to file-level conflicts, on top of the files that auto-merged.
	 *
	 * Routed through `resolveFileConflict` rather than storing the winning side’s array: within
	 * one file only the genuinely conflicting ids are the policy’s to decide, and taking the raw
	 * array would discard everything the losing side added to that file.
	 */
	private resolveFiles(
		autoMerged: TodoFilesData,
		conflicts: FileConflictSet[],
		decisions?: ConflictDecisions
	): TodoFilesData {
		const prefer = this.policy === "prefer-remote" ? "remote" : "local";
		const finalFilesData: TodoFilesData = { ...autoMerged };
		for (const fc of conflicts) {
			const settled = decisions?.files?.has(fc.filePath)
				? decisions.files.get(fc.filePath) ?? null
				: resolveFileConflict(fc, prefer);
			if (settled) {
				finalFilesData[fc.filePath] = settled;
			} else {
				// The winning side has no version of this file, so the deletion stands. Deleted
				// explicitly rather than merely "not added": `autoMerged` never carries a
				// conflicting path, but a resolver may settle one that a *previous* merge pass in
				// the same reconcile had already written in.
				delete finalFilesData[fc.filePath];
			}
		}
		return finalFilesData;
	}

	/**
	 * Picks the winning side for each conflict; dropped if that side deleted.
	 *
	 * A {@link ConflictResolver}'s decision wins where it made one. Everything else falls back to
	 * the active policy — which is also the whole path when no resolver is configured.
	 */
	private resolve(
		conflicts: ConflictSet[],
		decisions?: ConflictDecisions
	): { picks: Map<number, Todo>; extras?: Map<number, Todo[]> } {
		const picks = new Map<number, Todo>();
		for (const c of conflicts) {
			const pick = decisions?.todos?.has(c.todoId)
				? decisions.todos.get(c.todoId) ?? null
				: this.policy === "prefer-remote"
					? c.remote
					: c.local;
			if (pick) {
				picks.set(c.todoId, pick);
			}
			// A pick of null is a deletion the winning side made: leave the id out entirely, and
			// `assembleMerged` leaves its slot unfilled.
		}
		// Keep-both copies ride along keyed by the conflict they came from, so they land beside it.
		return { picks, extras: decisions?.extraTodos };
	}

	/**
	 * Asks the resolver, if there is one and there is anything to ask about.
	 *
	 * Throws {@link ConflictCancelled} when the resolver declines, which `reconcile` turns into a
	 * retryable failure. Throwing rather than threading a null through every merge site keeps the
	 * abort from being silently dropped at one of them.
	 */
	private async decide(
		conflicts: ConflictSet[],
		fileConflicts: FileConflictSet[],
		knownIds: number[]
	): Promise<ConflictDecisions | undefined> {
		if (!this.resolver || (conflicts.length === 0 && fileConflicts.length === 0)) {
			return undefined;
		}
		const decisions = await this.resolver({ todos: conflicts, files: fileConflicts, knownIds });
		if (decisions === null) {
			throw new ConflictCancelled();
		}
		return decisions;
	}

	/**
	 * Reconcile the user/global file. Pass the app's current local data; receive the merged
	 * data that is now both local and on the gist.
	 */
	public async reconcileUser(fileName: string, localData: GlobalGistData): Promise<SyncResult<ReconcileResult<GlobalGistData>>> {
		return this.reconcile("global", fileName, localData, {
			empty: () => ({ userTodos: [] }),
			parse: parseGlobal,
			merge: async (base, local, remote) => {
				const merge = threeWayMerge(base.userTodos, local.userTodos, remote.userTodos);
				const decisions = await this.decide(
					merge.conflicts,
					[],
					idsIn(base.userTodos, local.userTodos, remote.userTodos)
				);
				const { picks, extras } = this.resolve(merge.conflicts, decisions);
				const finalTodos = assembleMerged(merge, picks, extras);
				return { merged: { userTodos: finalTodos }, conflicts: merge.conflicts, fileConflicts: [] };
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
			merge: async (base, local, remote) => {
				// `filesData` is defaulted like `filesDataPaths`, not dereferenced bare. A cached
				// baseline can lack it: the extension's old download path parsed the gist file
				// straight into the cache and normalized only `filesDataPaths`, so a workspace file
				// written without a `filesData` key — hand-edited, or produced by another tool —
				// was stored that way. `mergeFilesData` then threw on `Object.keys(undefined)`,
				// which the caller reports as an unknown error and the scope sits on Error until
				// someone clears the cache.
				const result = threeWayMergeWorkspace(
					base.workspaceTodos,
					local.workspaceTodos,
					remote.workspaceTodos,
					base.filesData ?? {},
					local.filesData ?? {},
					remote.filesData ?? {},
					base.filesDataPaths ?? {},
					local.filesDataPaths ?? {},
					remote.filesDataPaths ?? {}
				);
				// One prompt for the whole file: the workspace todo conflicts and the per-file ones
				// come out of a single merge, so asking twice would make the user answer half a
				// decision, then the other half.
				const decisions = await this.decide(
					result.workspaceMerge.conflicts,
					result.fileConflicts,
					// Per-file ids are included: a keep-both copy must be unique across everything
					// this gist file holds, not just the workspace list it was raised from.
					idsIn(
						base.workspaceTodos,
						local.workspaceTodos,
						remote.workspaceTodos,
						...Object.values(base.filesData ?? {}),
						...Object.values(local.filesData ?? {}),
						...Object.values(remote.filesData ?? {})
					)
				);
				const { picks, extras } = this.resolve(result.workspaceMerge.conflicts, decisions);
				const finalWorkspaceTodos = assembleMerged(result.workspaceMerge, picks, extras);
				const finalFilesData = this.resolveFiles(
					result.autoMergedFilesData,
					result.fileConflicts,
					decisions
				);
				const merged: WorkspaceGistData = {
					workspaceTodos: finalWorkspaceTodos,
					filesData: finalFilesData,
					filesDataPaths: result.autoMergedFilesDataPaths,
				};
				return {
					merged,
					conflicts: result.workspaceMerge.conflicts,
					fileConflicts: result.fileConflicts,
				};
			},
		});
	}

	private async reconcile<T extends object>(
		scope: "global" | "workspace",
		fileName: string,
		localData: T,
		strategy: {
			empty: () => T;
			parse: (raw: string) => ParseResult<T>;
			merge: (base: T, local: T, remote: T) => Promise<{ merged: T; conflicts: ConflictSet[]; fileConflicts: FileConflictSet[] }>;
		}
	): Promise<SyncResult<ReconcileResult<T>>> {
		try {
			return await this.reconcileInner(scope, fileName, localData, strategy);
		} catch (error) {
			// A resolver that declined. Nothing was written and the baseline is untouched, so the
			// next sync re-derives the same conflicts and asks again — which is what "decide
			// later" has to mean if the item is not to quietly vanish.
			if (error instanceof ConflictCancelled) {
				return {
					success: false,
					error: {
						type: SyncErrorType.ConflictError,
						message: `Conflict resolution for ${fileName} was cancelled; nothing was synced.`,
						timestamp: new Date().toISOString(),
						retryable: true,
					},
				};
			}
			throw error;
		}
	}

	private async reconcileInner<T extends object>(
		scope: "global" | "workspace",
		fileName: string,
		localData: T,
		strategy: {
			empty: () => T;
			parse: (raw: string) => ParseResult<T>;
			merge: (base: T, local: T, remote: T) => Promise<{ merged: T; conflicts: ConflictSet[]; fileConflicts: FileConflictSet[] }>;
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
			// A file we cannot understand stops the reconcile here, before any merge and before
			// any write. Cache and baseline are left exactly as they were, so nothing is lost on
			// this device and the next sync of a restored file behaves as if this never happened.
			const parsed = strategy.parse(remoteRead.data ?? "");
			if (!parsed.ok) {
				return { success: false, error: unreadableError(fileName, parsed.reason) };
			}
			remoteData = parsed.data;
		} else if (remoteRead.error?.type === SyncErrorType.FileNotFoundError) {
			remoteData = null;
		} else {
			return { success: false, error: remoteRead.error };
		}

		// 2. Remote file doesn't exist yet → seed it with our local data. Re-read first: if the
		// other peer created the same file in the meantime (both sides picking "new file" for the
		// same scope), writing our local data straight out would replace their content and record
		// the clobbered state as the clean baseline, so it would never be pulled back. Merging
		// against an *empty* base makes both sides read as additions, so neither is deleted.
		if (remoteData === null) {
			const recheck = await this.client.readFile(this.gistId, fileName);
			if (recheck.success) {
				// Content we cannot parse is not permission to overwrite it — it is a file with
				// something in it that this device does not understand.
				const parsed = strategy.parse(recheck.data ?? "");
				if (!parsed.ok) {
					return { success: false, error: unreadableError(fileName, parsed.reason) };
				}
				const created = parsed.data;
				const { merged, conflicts, fileConflicts } = await strategy.merge(
					strategy.empty(),
					localData,
					created
				);
				return this.pushVerified(key, fileName, created, merged, true, conflicts, fileConflicts, strategy);
			}
			// Only a genuine "still absent" clears us to seed. Any other failure (network, rate
			// limit, auth) leaves us unable to tell an absent file from a peer's fresh content, and
			// writing localData out would clobber content we never saw. Surface the error and let
			// the next reconcile retry.
			if (recheck.error?.type !== SyncErrorType.FileNotFoundError) {
				return { success: false, error: recheck.error };
			}
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
			return this.pushVerified(key, fileName, remoteData, localData, false, [], [], strategy);
		}

		// 3d. Both changed → three-way merge, then push the merged result.
		const { merged, conflicts, fileConflicts } = await strategy.merge(base, localData, remoteData);
		return this.pushVerified(key, fileName, remoteData, merged, true, conflicts, fileConflicts, strategy);
	}

	/**
	 * Writes `outgoing`, but first re-reads the file to make sure the remote has not moved since
	 * the read this reconcile started from.
	 *
	 * The gist API has no compare-and-swap, so the read→merge→write sequence is a TOCTOU window:
	 * a push from another peer (typically the VS Code extension) that lands inside it used to be
	 * overwritten wholesale, and `saveCache` then recorded our stale result as the clean
	 * baseline — so the next reconcile saw remote == base and the lost change was never pulled
	 * back. Silent, permanent loss of an edit the user made in the extension.
	 *
	 * On detecting a moved remote we merge our outgoing data against the fresh remote, using the
	 * remote we originally read as the base (it is a genuine common ancestor of both sides), and
	 * retry. Bounded so a busy file cannot spin forever; giving up leaves the remote intact and
	 * the baseline untouched, so the next reconcile simply tries again.
	 */
	private async pushVerified<T extends object>(
		key: string,
		fileName: string,
		readRemote: T,
		outgoing: T,
		changedRemotely: boolean,
		conflicts: ConflictSet[],
		fileConflicts: FileConflictSet[],
		strategy: {
			parse: (raw: string) => ParseResult<T>;
			merge: (base: T, local: T, remote: T) => Promise<{ merged: T; conflicts: ConflictSet[]; fileConflicts: FileConflictSet[] }>;
		}
	): Promise<SyncResult<ReconcileResult<T>>> {
		let base = readRemote;
		let data = outgoing;
		let allConflicts = conflicts;
		let allFileConflicts = fileConflicts;
		let pulledConcurrent = changedRemotely;

		for (let attempt = 0; attempt < 3; attempt++) {
			const recheck = await this.client.readFile(this.gistId, fileName);

			// Only a genuine "the file is not there" clears us to write without comparing. A file
			// that vanished mid-flight is not a concurrent edit to merge with, so fall through and
			// let the write recreate it.
			//
			// Any OTHER failure — a network drop, a 5xx, a rate limit — leaves us unable to tell
			// an absent file from a peer's fresh content, and this is the one check standing
			// between the write and an overwrite. Treating it as "absent" would push our data over
			// whatever is really there and then record it as the clean baseline, so the next
			// reconcile would see remote == base and never pull the lost change back: precisely
			// the silent, permanent loss this verified write exists to prevent. Give up instead —
			// the remote is untouched and the baseline unmoved, so the next sync simply retries.
			// (The seeding path in `reconcileInner` already makes this distinction.)
			if (!recheck.success && recheck.error?.type !== SyncErrorType.FileNotFoundError) {
				return { success: false, error: recheck.error };
			}

			// Same rule as the reconcile's first read: unparseable content is not a concurrent
			// edit to merge with, and it is certainly not an empty file to write over. Bail with
			// the remote and the baseline untouched.
			let current: T | undefined;
			if (recheck.success) {
				const parsed = strategy.parse(recheck.data ?? "");
				if (!parsed.ok) {
					return { success: false, error: unreadableError(fileName, parsed.reason) };
				}
				current = parsed.data;
			}

			if (current !== undefined && !isEqual(current, base)) {
				this.logger?.(
					`[GistSyncEngine] remote moved during reconcile of ${fileName}; re-merging (attempt ${attempt + 1})`
				);
				const remerged = await strategy.merge(base, data, current);
				data = remerged.merged;
				allConflicts = [...allConflicts, ...remerged.conflicts];
				allFileConflicts = [...allFileConflicts, ...remerged.fileConflicts];
				base = current;
				pulledConcurrent = true;
				continue;
			}

			const write = await this.client.writeFile(this.gistId, fileName, serialize(data));
			if (!write.success) {
				return { success: false, error: write.error };
			}
			await this.saveCache(key, data, data);
			return this.ok({
				data,
				changedRemotely: pulledConcurrent,
				pushed: true,
				conflicts: allConflicts,
				fileConflicts: allFileConflicts,
			});
		}

		return {
			success: false,
			error: {
				type: SyncErrorType.ConflictError,
				message: `Remote ${fileName} kept changing during reconcile; will retry on the next sync.`,
				timestamp: new Date().toISOString(),
				retryable: true,
			},
		};
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
			parse: (raw: string) => ParseResult<T>;
			merge: (base: T, local: T, remote: T) => Promise<{ merged: T; conflicts: ConflictSet[]; fileConflicts: FileConflictSet[] }>;
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

		const { merged, conflicts, fileConflicts } = await strategy.merge(empty, localData, remoteData);
		// Same TOCTOU window as the ordinary push paths, so the same verified write.
		return this.pushVerified(key, fileName, remoteData, merged, true, conflicts, fileConflicts, strategy);
	}

	/**
	 * Persists `data` and the baseline it was reconciled against.
	 *
	 * Every caller passes the SAME object for both — the reconciled result is also the new
	 * baseline — so the baseline is cloned before it is stored. Without that, `data` and
	 * `lastCleanRemoteData` are one object in the saved cache, and any {@link CacheStore} that
	 * persists by reference lets a later in-place edit of `data` silently move the baseline with
	 * it. The merge then has no record of what the remote looked like: local always equals base,
	 * so a genuine local edit reads as "nothing to push", the untouched remote reads as a remote
	 * change, and the edit is pulled away and deleted.
	 *
	 * That is not hypothetical — it is exactly what the VS Code extension does. Its cache lives
	 * in a memento, whose `get` hands back the live stored object, and `SyncStorageManager`
	 * records an edit with `cache.data.userTodos = todos`, in place.
	 */
	private async saveCache<T>(key: string, data: T, lastCleanRemoteData: T): Promise<void> {
		await this.store.save<T>(key, {
			data,
			lastCleanRemoteData: cloneData(lastCleanRemoteData),
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

/**
 * A gist file that was read, or the reason it could not be understood.
 *
 * The distinction is the whole point. These parsers used to answer "unreadable" with an empty
 * list, and an empty list is indistinguishable from the other device having deleted everything —
 * so a damaged file was synced as a deletion: pulled over healthy local todos, and, where this
 * device had edits of its own, merged as "remote deleted all of these" and pushed back over the
 * damaged file, destroying whatever the revision history had not yet lost.
 */
type ParseResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/**
 * Checks a list read from a gist file is one the merge can actually key by id.
 *
 * Only `id` is required, not the whole {@link Todo} shape: the merge is keyed by id and nothing
 * else, an item without one silently collapses into its neighbours, and every other field has a
 * sane absence. Validating the rest would mean rejecting files written by a version of the app
 * whose model has moved on, which is a worse failure than rendering a todo with no text.
 *
 * And "usable" is the test, not "numeric" — deliberately, and it must stay that way.
 *
 * The model says `id: number`, but for years the import path replaced only a *falsy* id, so a
 * string in a hand-written import file survived onto the gist. Files written by those builds are
 * still out there, which is what makes the tolerance necessary — `initMissingTodoProperties` no
 * longer mints them, but it cannot go back and fix the ones already written. A string keys a
 * `Map` perfectly well and both peers read it the same way, whereas rejecting one would kill the
 * sync permanently, with no recovery — the offending todo is in local state too, so restoring
 * the file from the revision history only gets it pushed back out again.
 *
 * So: do not tighten this to `number` on the grounds that the importer is now strict. The
 * importer being strict is about new data; this is about data that already exists.
 *
 * @returns the reason the list is unusable, or null when it is fine
 */
function invalidListReason(list: unknown, label: string): string | null {
	if (!Array.isArray(list)) {
		return `"${label}" is missing or is not a list`;
	}
	for (let i = 0; i < list.length; i++) {
		const item = list[i] as Partial<Todo> | null;
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return `"${label}" holds something that is not a todo (item ${i + 1})`;
		}
		const id: unknown = item.id;
		const usableId =
			(typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id !== "");
		if (!usableId) {
			return `a todo in "${label}" has no usable id (item ${i + 1})`;
		}
	}
	return null;
}

/** True for a JSON object — the shape every gist file and every map inside one has. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the JSON envelope shared by both scopes.
 *
 * An empty file counts as damage, not as an empty list: neither peer can produce one, because
 * both clients refuse to write empty content (GitHub requires at least one byte, and a file
 * emptied through the API is removed rather than blanked). So whatever emptied it was not a
 * sync, and reading it as "everything was deleted" would finish the job.
 */
function parseEnvelope(raw: string): ParseResult<Record<string, unknown>> {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return { ok: false, reason: "the file is empty" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, reason: "it is not valid JSON" };
	}
	if (!isPlainObject(parsed)) {
		return { ok: false, reason: "it does not hold a JSON object" };
	}
	return { ok: true, data: parsed };
}

function parseGlobal(raw: string): ParseResult<GlobalGistData> {
	const envelope = parseEnvelope(raw);
	if (!envelope.ok) {
		return envelope;
	}
	// Bracketed because the envelope is an index signature: the webview build turns on
	// `noPropertyAccessFromIndexSignature`, and it compiles this file too.
	const userTodos = envelope.data["userTodos"];
	const reason = invalidListReason(userTodos, "userTodos");
	if (reason) {
		return { ok: false, reason };
	}
	return { ok: true, data: { userTodos: userTodos as Todo[] } };
}

function parseWorkspace(raw: string): ParseResult<WorkspaceGistData> {
	const envelope = parseEnvelope(raw);
	if (!envelope.ok) {
		return envelope;
	}
	const { workspaceTodos, filesData, filesDataPaths } = envelope.data;

	const listReason = invalidListReason(workspaceTodos, "workspaceTodos");
	if (listReason) {
		return { ok: false, reason: listReason };
	}

	// `filesData` and `filesDataPaths` may be absent — a workspace file written by an older
	// build, or hand-edited, legitimately lacks them, and an absent map is an empty one. Present
	// but not a map is damage.
	if (filesData !== undefined && !isPlainObject(filesData)) {
		return { ok: false, reason: `"filesData" is not a map of file paths` };
	}
	for (const [path, todos] of Object.entries(filesData ?? {})) {
		const reason = invalidListReason(todos, `filesData["${path}"]`);
		if (reason) {
			return { ok: false, reason };
		}
	}

	if (filesDataPaths !== undefined && !isPlainObject(filesDataPaths)) {
		return { ok: false, reason: `"filesDataPaths" is not a map of file paths` };
	}
	for (const [path, entry] of Object.entries(filesDataPaths ?? {})) {
		if (!isPlainObject(entry)) {
			return { ok: false, reason: `"filesDataPaths[\\"${path}\\"]" is not a path alias entry` };
		}
		for (const key of ["absPaths", "relPaths"] as const) {
			const paths = entry[key];
			// Iterated bare by `mergeFilesDataPaths`, so anything but a list of strings throws
			// there instead of failing here, where it can be explained.
			if (paths !== undefined && (!Array.isArray(paths) || paths.some((p) => typeof p !== "string"))) {
				return { ok: false, reason: `"filesDataPaths[\\"${path}\\"].${key}" is not a list of paths` };
			}
		}
	}

	return {
		ok: true,
		data: {
			workspaceTodos: workspaceTodos as Todo[],
			filesData: (filesData as TodoFilesData) ?? {},
			filesDataPaths: (filesDataPaths as TodoFilesDataPaths) ?? {},
		},
	};
}

/**
 * The failure a damaged remote file produces.
 *
 * Not retryable: re-reading the same bytes gets the same answer, and the only fix is a person
 * restoring the file, so a client that backs off and tries again is just hiding the problem.
 */
function unreadableError(fileName: string, reason: string): SyncError {
	return {
		type: SyncErrorType.CorruptDataError,
		message:
			`Could not read ${fileName} from the gist: ${reason}. Nothing was synced, and your ` +
			`todos on this device are untouched. Restore the file from the gist's revision history on github.com.`,
		timestamp: new Date().toISOString(),
		retryable: false,
	};
}
