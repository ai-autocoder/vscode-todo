/**
 * IndexedDB persistence for pending conflicts.
 *
 * Conflicts have to outlive the page: sync runs when the app regains focus, which on a phone is
 * routinely the moment before it gets backgrounded and torn down again. A conflict held only in
 * memory would be resolved silently and then forgotten, which is the behaviour this feature
 * exists to end.
 *
 * Stored as a single array under one key — the list is capped and tiny, and reading it whole is
 * what the review screen wants anyway. Lives in its own object store beside the sync cache and
 * the auth token; {@link KeyValueStore} adds it to the existing database on first use.
 */

import { KeyValueStore, PWA_DB_NAME, type IdbEnv } from "@vsc-todo/core";
import type { PendingConflict } from "./conflict-types";

/** Object store holding the pending-conflict list. */
export const CONFLICT_STORE_NAME = "conflicts";

const PENDING_KEY = "pending";

/**
 * Upper bound on unreviewed conflicts. A device that has been offline for a long time can come
 * back to a large merge, and an unbounded list would grow a review screen nobody will finish.
 * Oldest records are dropped first — the newest are the ones the user still remembers making.
 */
export const MAX_PENDING_CONFLICTS = 50;

export class PendingConflictStore {
	private readonly kv: KeyValueStore;

	constructor(env?: IdbEnv, dbName: string = PWA_DB_NAME, storeName: string = CONFLICT_STORE_NAME) {
		this.kv = KeyValueStore.open(dbName, storeName, env);
	}

	async load(): Promise<PendingConflict[]> {
		return (await this.kv.get<PendingConflict[]>(PENDING_KEY)) ?? [];
	}

	/** Persists the list newest-first, trimmed to {@link MAX_PENDING_CONFLICTS}. */
	async save(conflicts: PendingConflict[]): Promise<void> {
		await this.kv.set<PendingConflict[]>(PENDING_KEY, conflicts.slice(0, MAX_PENDING_CONFLICTS));
	}

	/** Drops every record. Used when switching gists or disconnecting. */
	async clear(): Promise<void> {
		await this.kv.delete(PENDING_KEY);
	}
}
