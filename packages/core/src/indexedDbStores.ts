/**
 * IndexedDB-backed persistence for the PWA: the sync cache and the GitHub token.
 *
 * - {@link IndexedDbCacheStore} implements the engine's {@link CacheStore} so per-file sync
 *   state (`data`, `lastCleanRemoteData`, `lastSynced`, `isDirty`) survives reloads — this is
 *   what lets the PWA detect real remote changes after being closed.
 * - {@link IndexedDbTokenStore} keeps the `gist`-scoped OAuth token (and the gist id) so the
 *   user stays connected across sessions.
 *
 * Both are thin wrappers over {@link KeyValueStore}. The token is stored in IndexedDB rather
 * than localStorage so it is not exposed to synchronous, same-origin script as readily; it is
 * still plaintext at rest — an accepted PWA trade-off, mitigated by the `gist`-only scope and
 * an explicit disconnect (see {@link IndexedDbTokenStore.clear}).
 */

import type { CacheStore } from "./gistSyncEngine";
import type { GistCache } from "./syncTypes";
import { KeyValueStore, IdbEnv } from "./indexedDb";

/** Default IndexedDB database name for the PWA. */
export const PWA_DB_NAME = "vsc-todo-pwa";
/** Object store holding per-file {@link GistCache} entries. */
export const CACHE_STORE_NAME = "sync-cache";
/** Object store holding the auth token and gist id. */
export const AUTH_STORE_NAME = "auth";

/**
 * Persists {@link GistCache} entries in IndexedDB, keyed by the engine's own cache key
 * (`gistCache_<scope>_<fileName>`). Drop-in {@link CacheStore} for {@link GistSyncEngine}.
 */
export class IndexedDbCacheStore implements CacheStore {
	private readonly kv: KeyValueStore;

	constructor(env?: IdbEnv, dbName: string = PWA_DB_NAME, storeName: string = CACHE_STORE_NAME) {
		this.kv = KeyValueStore.open(dbName, storeName, env);
	}

	async load<T>(key: string): Promise<GistCache<T> | undefined> {
		return this.kv.get<GistCache<T>>(key);
	}

	async save<T>(key: string, cache: GistCache<T>): Promise<void> {
		await this.kv.set<GistCache<T>>(key, cache);
	}

	/** Removes every cached file (used when disconnecting or switching gists). */
	async clear(): Promise<void> {
		const keys = await this.kv.keys();
		await Promise.all(keys.map((k) => this.kv.delete(k)));
	}
}

const TOKEN_KEY = "github-token";
const GIST_ID_KEY = "gist-id";

/**
 * Stores the GitHub `gist`-scoped token and the selected gist id for the PWA. A single
 * IndexedDB object store with two well-known keys; reads return `undefined` when disconnected.
 */
export class IndexedDbTokenStore {
	private readonly kv: KeyValueStore;

	constructor(env?: IdbEnv, dbName: string = PWA_DB_NAME, storeName: string = AUTH_STORE_NAME) {
		this.kv = KeyValueStore.open(dbName, storeName, env);
	}

	async getToken(): Promise<string | undefined> {
		return this.kv.get<string>(TOKEN_KEY);
	}

	async setToken(token: string): Promise<void> {
		await this.kv.set<string>(TOKEN_KEY, token);
	}

	async getGistId(): Promise<string | undefined> {
		return this.kv.get<string>(GIST_ID_KEY);
	}

	async setGistId(gistId: string): Promise<void> {
		await this.kv.set<string>(GIST_ID_KEY, gistId);
	}

	/** Clears the token and gist id — the "Disconnect" action. */
	async clear(): Promise<void> {
		await this.kv.delete(TOKEN_KEY);
		await this.kv.delete(GIST_ID_KEY);
	}
}
