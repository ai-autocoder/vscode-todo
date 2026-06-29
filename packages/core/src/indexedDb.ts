/**
 * Tiny promise-wrapped IndexedDB key-value helper for the standalone PWA.
 *
 * This is the one place that touches the raw IndexedDB API; the sync cache
 * ({@link IndexedDbCacheStore}) and the auth token ({@link IndexedDbTokenStore}) are both
 * built on top of it. It is deliberately minimal — a single object store keyed by string —
 * because that is all the PWA needs, and a small surface is easy to reason about and test
 * (with `fake-indexeddb` under vitest, or a real browser).
 *
 * The implementation depends only on the standard `indexedDB` global (no runtime deps), so
 * it lives in the framework-agnostic core alongside the {@link CacheStore} interface it
 * implements, rather than in any one UI.
 */

/** The `indexedDB` factory to use. Defaults to the global; overridable for tests. */
export interface IdbEnv {
	indexedDB: IDBFactory;
}

const defaultEnv = (): IdbEnv => {
	if (typeof indexedDB === "undefined") {
		throw new Error("IndexedDB is not available in this environment.");
	}
	return { indexedDB };
};

/** Wraps an IDBRequest in a promise. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/**
 * A single-store IndexedDB database exposing string-keyed get/set/delete/keys. Open it once
 * with {@link KeyValueStore.open} and reuse the instance; the underlying connection is opened
 * lazily on first use and cached.
 */
export class KeyValueStore {
	private dbPromise: Promise<IDBDatabase> | undefined;

	private constructor(
		private readonly dbName: string,
		private readonly storeName: string,
		private readonly env: IdbEnv
	) {}

	/**
	 * Create a store handle. Does not open the connection yet — that happens lazily on the
	 * first operation, so constructing this is safe even before the page is interactive.
	 */
	static open(dbName: string, storeName: string, env: IdbEnv = defaultEnv()): KeyValueStore {
		return new KeyValueStore(dbName, storeName, env);
	}

	private getDb(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
				const request = this.env.indexedDB.open(this.dbName, 1);
				request.onupgradeneeded = () => {
					const db = request.result;
					if (!db.objectStoreNames.contains(this.storeName)) {
						db.createObjectStore(this.storeName);
					}
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
			});
		}
		return this.dbPromise;
	}

	private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
		const db = await this.getDb();
		return db.transaction(this.storeName, mode).objectStore(this.storeName);
	}

	async get<T>(key: string): Promise<T | undefined> {
		const store = await this.tx("readonly");
		const value = await requestToPromise(store.get(key));
		return value as T | undefined;
	}

	async set<T>(key: string, value: T): Promise<void> {
		const store = await this.tx("readwrite");
		// Out-of-line key: the store was created without a keyPath, so the key is passed
		// alongside the value rather than read from it.
		await requestToPromise(store.put(value, key));
	}

	async delete(key: string): Promise<void> {
		const store = await this.tx("readwrite");
		await requestToPromise(store.delete(key));
	}

	async keys(): Promise<string[]> {
		const store = await this.tx("readonly");
		const keys = await requestToPromise(store.getAllKeys());
		return (keys as IDBValidKey[]).map((k) => String(k));
	}

	/** Closes the underlying connection (mainly for tests / teardown). */
	async close(): Promise<void> {
		if (this.dbPromise) {
			const db = await this.dbPromise;
			db.close();
			this.dbPromise = undefined;
		}
	}
}
