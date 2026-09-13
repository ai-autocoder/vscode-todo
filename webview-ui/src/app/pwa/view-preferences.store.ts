/**
 * IndexedDB persistence for the PWA's view preferences.
 *
 * The extension keeps Wide View and Show Tags in `vscodeTodo.*` settings, so they survive a
 * restart. The PWA has no settings host: the gateway builds its `Config` from `DEFAULT_CONFIG`
 * on every construction, so before this the toggles lasted exactly as long as the tab. On a
 * phone, where the app cold-starts constantly, that made them effectively unsettable.
 *
 * These are *device* preferences, not account data — how this screen is laid out, not what is
 * on it. So they live beside the sync cache rather than in it: they are never written to the
 * gist, never merged, and deliberately survive both a disconnect and a gist switch, the same
 * way a browser's zoom level would.
 *
 * Unlike {@link PendingConflictStore}, every operation here swallows its errors. Losing a
 * conflict record silently is the exact bug that feature exists to prevent, so it lets
 * failures propagate; losing a layout toggle is a cosmetic annoyance, and a private-mode
 * browser that refuses IndexedDB must not take the app down over one.
 */

import { KeyValueStore, PWA_DB_NAME, type IdbEnv } from "@vsc-todo/core";

/** Object store holding the view preferences. */
export const PREFERENCES_STORE_NAME = "preferences";

const VIEW_KEY = "view";

/** The subset of `Config` the PWA lets the user change, and therefore has to remember. */
export interface ViewPreferences {
	enableWideView: boolean;
	showTags: boolean;
}

export class ViewPreferencesStore {
	private readonly kv: KeyValueStore;

	constructor(
		env?: IdbEnv,
		dbName: string = PWA_DB_NAME,
		storeName: string = PREFERENCES_STORE_NAME
	) {
		this.kv = KeyValueStore.open(dbName, storeName, env);
	}

	/**
	 * Reads the stored preferences, omitting anything absent or of the wrong type.
	 *
	 * Returns a partial rather than a filled-in object so the caller can spread it over the
	 * defaults: a record written by an older build that only knew one of these keys must leave
	 * the other at its default, not reset it to `false`.
	 */
	async load(): Promise<Partial<ViewPreferences>> {
		let stored: unknown;
		try {
			stored = await this.kv.get<unknown>(VIEW_KEY);
		} catch {
			return {};
		}
		if (!stored || typeof stored !== "object") {
			return {};
		}
		const record = stored as Record<string, unknown>;
		const prefs: Partial<ViewPreferences> = {};
		if (typeof record["enableWideView"] === "boolean") {
			prefs.enableWideView = record["enableWideView"];
		}
		if (typeof record["showTags"] === "boolean") {
			prefs.showTags = record["showTags"];
		}
		return prefs;
	}

	/** Writes both preferences. Never rejects — see the note at the top of this file. */
	async save(prefs: ViewPreferences): Promise<void> {
		try {
			await this.kv.set<ViewPreferences>(VIEW_KEY, {
				enableWideView: prefs.enableWideView,
				showTags: prefs.showTags,
			});
		} catch {
			// Deliberately ignored: a toggle that fails to persist still applies to this session.
		}
	}
}
