import { EnhancedStore } from "@reduxjs/toolkit";
import StorageSyncManager from "../../storage/StorageSyncManager";
import createStore, { actionTrackerActions } from "../../todo/store";
import { Slices, StoreState } from "../../todo/todoTypes";

export interface StoreHarness {
	store: EnhancedStore<StoreState>;
	storage: StorageSyncManager;
	/** Slices loaded since the harness was built: a sync showing its result loads them. */
	loads: string[];
	/** Waits for every persist so far. */
	settle(): Promise<unknown>;
}

/**
 * A real store over `context`, loaded by `load` with the lists activation would load, and a
 * subscriber that persists every slice change through a real `StorageSyncManager` the way the
 * extension's `store.subscribe` does. Hand `storage` to a `SyncManager` to have it show its
 * results there.
 */
export function storeHarness(
	context: never,
	load: (store: EnhancedStore<StoreState>) => void
): StoreHarness {
	const store = createStore() as EnhancedStore<StoreState>;
	// Loaded before the subscriber is attached, as activation does.
	load(store);
	store.dispatch(actionTrackerActions.resetLastSliceName());
	const storage = new StorageSyncManager(context, store);
	const persists: Promise<void>[] = [];
	const loads: string[] = [];
	store.subscribe(() => {
		const state = store.getState();
		const slice = state.actionTracker.lastSliceName;
		if (slice !== Slices.user && slice !== Slices.workspace && slice !== Slices.currentFile) {
			return;
		}
		store.dispatch(actionTrackerActions.resetLastSliceName());
		if (state[slice].lastActionType.endsWith("/loadData")) {
			loads.push(slice);
		}
		persists.push(storage.persistSlice(state[slice]));
	});
	return { store, storage, loads, settle: () => Promise.all(persists) };
}
