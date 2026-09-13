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

	/** Opens `dbName`, creating `storeName` if the upgrade transaction runs. */
	private openAt(version?: number): Promise<IDBDatabase> {
		return new Promise<IDBDatabase>((resolve, reject) => {
			const request =
				version === undefined
					? this.env.indexedDB.open(this.dbName)
					: this.env.indexedDB.open(this.dbName, version);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName);
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				// Another KeyValueStore on this database may need to add its own store, which
				// requires a version bump. Without this, our open connection blocks that upgrade
				// indefinitely and the other store hangs on its first operation.
				db.onversionchange = () => {
					db.close();
					this.dbPromise = undefined;
				};
				resolve(db);
			};
			request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
			request.onblocked = () =>
				reject(new Error(`IndexedDB upgrade for '${this.dbName}' is blocked by another tab.`));
		});
	}

	/**
	 * Opens the database, guaranteeing `storeName` exists.
	 *
	 * Several stores share one database (the sync cache and the auth token), each opened
	 * through its own {@link KeyValueStore}. Whichever opens first runs `onupgradeneeded` and
	 * creates only *its* store, so a later store would find the database already at that
	 * version, never get an upgrade transaction, and fail with `NotFoundError` on first use.
	 * Opening with no version first tells us the current version; if our store is missing we
	 * reopen at version+1 to add it. This also repairs databases created before the fix.
	 */
	private getDb(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			this.dbPromise = (async () => {
				// No version: opens the existing database at whatever version it has, or creates
				// it at version 1 (running onupgradeneeded, which makes our store).
				let db = await this.openAt();
				if (!db.objectStoreNames.contains(this.storeName)) {
					const next = db.version + 1;
					db.close();
					db = await this.openAt(next);
				}
				return db;
			})();
			// Don't cache a rejected promise — a retry should be able to reopen.
			this.dbPromise.catch(() => {
				this.dbPromise = undefined;
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
