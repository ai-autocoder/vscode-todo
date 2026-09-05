import { MessageActionsToWebview } from "../../../../src/panels/message";
import { GistGateway } from "../data/gist-gateway";
import { ViewPreferencesStore } from "./view-preferences.store";

/**
 * Regression cover for the audit finding "Wide View and Show Tags reset on every launch".
 *
 * Both toggles used to write only to the gateway's in-memory `Config`, which is rebuilt from
 * `DEFAULT_CONFIG` on every construction — so they survived exactly as long as the tab. The
 * extension keeps them in `vscodeTodo.*` settings; the PWA now keeps them in IndexedDB beside
 * the sync cache.
 *
 * The store tests run against a real IndexedDB (Karma is a real browser) under a throwaway
 * database name, because the thing being fixed *is* the persistence — stubbing it out would
 * leave the actual round trip untested.
 */
describe("PWA view preferences", () => {
	describe("ViewPreferencesStore", () => {
		let dbName: string;
		let store: ViewPreferencesStore;

		beforeEach(() => {
			dbName = `vsc-todo-pwa-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			store = new ViewPreferencesStore(undefined, dbName);
		});

		afterEach(async () => {
			await new Promise<void>((resolve) => {
				const request = indexedDB.deleteDatabase(dbName);
				request.onsuccess = () => resolve();
				request.onerror = () => resolve();
				request.onblocked = () => resolve();
			});
		});

		it("round-trips both preferences", async () => {
			await store.save({ enableWideView: true, showTags: true });

			expect(await store.load()).toEqual({ enableWideView: true, showTags: true });
		});

		it("round-trips false as a real value, not as absent", async () => {
			// The distinction matters: `load()` returns a partial that the caller spreads over the
			// defaults, so a `false` that came back as `undefined` would be indistinguishable from
			// "never set" — which is fine while the default is false, and silently wrong the moment
			// a default changes.
			await store.save({ enableWideView: false, showTags: false });

			expect(await store.load()).toEqual({ enableWideView: false, showTags: false });
		});

		it("reports nothing when no preferences have been stored", async () => {
			expect(await store.load()).toEqual({});
		});

		it("omits keys of the wrong type rather than coercing them", async () => {
			// A record written by a future build, or a hand-edited one. Coercing `"yes"` to `true`
			// would silently turn a corrupt value into a preference the user never set.
			const other = new ViewPreferencesStore(undefined, dbName);
			await other.save({ enableWideView: true, showTags: false });
			await writeRaw(dbName, { enableWideView: "yes", showTags: false });

			expect(await store.load()).toEqual({ showTags: false });
		});

		it("survives a browser that refuses IndexedDB", async () => {
			// Private-mode Safari and a few locked-down Android browsers throw here. Losing a layout
			// toggle is cosmetic; taking the app's startup down over one is not acceptable.
			const broken = new ViewPreferencesStore({
				indexedDB: {
					open: () => {
						throw new DOMException("denied", "SecurityError");
					},
				} as unknown as IDBFactory,
			});

			await expectAsync(broken.save({ enableWideView: true, showTags: true })).toBeResolved();
			expect(await broken.load()).toEqual({});
		});
	});

	describe("GistGateway integration", () => {
		interface Internals {
			tokenStore: unknown;
			cacheStore: unknown;
			conflictStore: unknown;
			viewPreferencesStore: Pick<ViewPreferencesStore, "load" | "save">;
			config: { enableWideView: boolean; showTags: boolean };
		}

		let gateway: GistGateway;
		let internals: Internals;
		let saved: Array<{ enableWideView: boolean; showTags: boolean }>;

		/** Stands in for the real store so these tests assert wiring, not IndexedDB. */
		function withStoredPreferences(stored: Partial<Record<string, boolean>>): void {
			internals.viewPreferencesStore = {
				load: () => Promise.resolve(stored),
				save: (prefs) => {
					saved.push(prefs);
					return Promise.resolve();
				},
			};
		}

		beforeEach(() => {
			gateway = new GistGateway({
				clientId: "test-client",
				deviceFlowProxyUrl: "https://example.invalid",
				pushDebounceMs: 60_000,
			});
			internals = gateway as unknown as Internals;
			saved = [];
			// No session: `restoreSession` then skips the cache and conflict reads, so nothing here
			// touches a real database.
			internals.tokenStore = {
				getToken: () => Promise.resolve(undefined),
				getGistId: () => Promise.resolve(undefined),
				getUserFile: () => Promise.resolve(undefined),
				getWorkspaceFile: () => Promise.resolve(undefined),
				clear: () => Promise.resolve(),
			};
			// `disconnectGitHub` clears these three. Stubbed so the assertion that it leaves the
			// *preferences* alone is about the gateway's choice, not about which stores happen to
			// exist in this browser.
			internals.cacheStore = { clear: () => Promise.resolve() };
			internals.conflictStore = { clear: () => Promise.resolve(), load: () => Promise.resolve([]) };
			withStoredPreferences({});
		});

		it("sends the stored preferences in the first reloadWebview", async () => {
			// The whole point of loading them inside `restoreSession`: `TodoService` seeds its Wide
			// View and Show Tags observables from `reloadWebview`'s config, so arriving later would
			// render one frame of the defaults and then jump.
			withStoredPreferences({ enableWideView: true, showTags: true });
			await gateway.restoreSession();

			const configs: Array<{ enableWideView: boolean; showTags: boolean }> = [];
			gateway.messages.subscribe((message) => {
				if (message.type === MessageActionsToWebview.reloadWebview) {
					configs.push(message.config as never);
				}
			});
			await gateway.ready();

			expect(configs.length).toBeGreaterThan(0);
			expect(configs[0].enableWideView).toBe(true);
			expect(configs[0].showTags).toBe(true);
		});

		it("leaves a preference at its default when only the other was stored", async () => {
			withStoredPreferences({ showTags: true });

			await gateway.restoreSession();

			expect(internals.config.showTags).toBe(true);
			expect(internals.config.enableWideView).toBe(false);
		});

		it("persists both preferences whenever either is toggled", () => {
			gateway.setWideViewEnabled(true);
			gateway.setShowTagsEnabled(true);

			// Each write carries the whole record, so the second toggle must not drop the first.
			expect(saved).toEqual([
				{ enableWideView: true, showTags: false },
				{ enableWideView: true, showTags: true },
			]);
		});

		it("keeps preferences across a disconnect", async () => {
			// These describe the device, not the account — the same reasoning as a browser's zoom
			// level. `disconnectGitHub` clears the token, gist, cache and conflicts; wiping the
			// layout with them would be a surprise.
			withStoredPreferences({ enableWideView: true });
			await gateway.restoreSession();
			await gateway.disconnectGitHub();

			expect(internals.config.enableWideView).toBe(true);
		});
	});
});

/** Writes a raw value under the store's own key, bypassing `save`'s typing. */
async function writeRaw(dbName: string, value: unknown): Promise<void> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	await new Promise<void>((resolve, reject) => {
		const request = db.transaction("preferences", "readwrite").objectStore("preferences").put(value, "view");
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
	db.close();
}
