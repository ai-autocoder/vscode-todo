/**
 * {@link CacheStore} over VS Code's mementos, so the shared {@link GistSyncEngine} persists its
 * per-file sync caches where the extension has always kept them.
 *
 * The engine addresses caches by the key `gistCache_<scope>_<fileName>` — byte-for-byte the
 * strings {@link StorageKeys.globalGistCache} and {@link StorageKeys.workspaceGistCache} build.
 * That is deliberate, not luck: it means adopting the engine reads the caches an installed
 * extension already has, so nobody re-downloads, re-bootstraps, or loses a merge baseline on
 * upgrade. Do not "tidy" either side's key format without migrating the other.
 *
 * The scope has to be recovered from the key because {@link CacheStore} is a flat key/value
 * interface, and the two scopes live in different mementos: global caches are per-profile
 * (`globalState`), workspace caches are per-folder (`workspaceState`). Routing both to one store
 * would leak one workspace's baseline into another.
 */

import * as vscode from "vscode";
import { CacheStore, GistCache } from "../core";

const GLOBAL_PREFIX = "gistCache_global_";
const WORKSPACE_PREFIX = "gistCache_workspace_";

/** Deep copy. Cache contents are JSON by construction — they are gist file contents. */
function cloneData<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export class MementoCacheStore implements CacheStore {
	/**
	 * The `data` each key held when this store first overwrote it.
	 *
	 * This is how a reconcile recovers an edit the user made while it was on the network. The
	 * extension's local truth for a synced list *is* `cache.data` — `persistSlice` writes the
	 * edit there (see `SyncStorageManager.setGlobalTodos`), and for per-file lists there is no
	 * other live copy at all. A finishing reconcile replaces the whole cache entry with its
	 * merged result, so by the time it returns, that edit is gone from the only place it lived,
	 * and reading "current local state" afterwards just reads the merge back.
	 *
	 * Capturing what the write displaced hands the caller exactly that lost value, without
	 * threading the Redux store into the sync layer or teaching the engine about mid-flight
	 * edits (the PWA has an in-memory slice for this; the extension does not). Only the FIRST
	 * displacement per key is kept, so a caller's own follow-up `persistLocal` does not
	 * overwrite the observation it is based on.
	 */
	private readonly displaced = new Map<string, unknown>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	async load<T>(key: string): Promise<GistCache<T> | undefined> {
		return this.memento(key).get<GistCache<T>>(key);
	}

	async save<T>(key: string, cache: GistCache<T>): Promise<void> {
		if (!this.displaced.has(key)) {
			const previous = this.memento(key).get<GistCache<T>>(key);
			if (previous !== undefined) {
				// Cloned so this is a snapshot of local state *at the moment of the write*, and
				// stays one. The object it came from is still live — a memento's `get` returns
				// what it holds — so an edit landing afterwards would otherwise mutate this record
				// under the caller and make "what was displaced" mean something different
				// depending on timing. Edits that land after the write are found by re-reading
				// the cache instead; see SyncManager's use of displacedData.
				this.displaced.set(key, cloneData(previous.data));
			}
		}
		// Stored as a copy, never as the caller's live object. A memento's `get` returns the
		// object it holds, not a copy, so anything still holding a reference to what was saved
		// can mutate the persisted cache from underneath the sync — and `SyncStorageManager`
		// does exactly that, recording an edit with `cache.data.userTodos = todos` in place.
		// Cloning here keeps that edit confined to `data` instead of also moving the merge
		// baseline, which would make the edit read as "nothing to push" and get pulled away.
		// (The engine de-aliases the two fields as well; this is the same guarantee held at the
		// boundary where VS Code's storage semantics actually make it load-bearing.)
		await this.memento(key).update(key, cloneData(cache));
	}

	/**
	 * The `data` this store displaced for `key`, or undefined if it has not written to it (or
	 * the key held nothing). See {@link displaced}.
	 *
	 * One store instance is built per sync, so this only ever reports that sync's own write.
	 */
	public displacedData<T>(key: string): T | undefined {
		return this.displaced.get(key) as T | undefined;
	}

	/**
	 * Workspace caches go to `workspaceState`, everything else to `globalState`.
	 *
	 * An unrecognised key falling through to `globalState` is the safe default: a global memento
	 * is always available, whereas `workspaceState` outside a folder is a no-op store that would
	 * silently drop the baseline and make every reconcile look like a cold cache.
	 */
	private memento(key: string): vscode.Memento {
		if (key.startsWith(WORKSPACE_PREFIX)) {
			return this.context.workspaceState;
		}
		if (!key.startsWith(GLOBAL_PREFIX)) {
			console.warn(`[MementoCacheStore] unrecognised cache key "${key}"; using globalState`);
		}
		return this.context.globalState;
	}
}
