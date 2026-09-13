/**
 * Seeds the PWA with a connected session and one of every conflict card, so the review screen
 * can be exercised without a GitHub login.
 *
 * Every bit of PWA state lives in IndexedDB, and `GistGateway.restoreSession()` reaches phase
 * "connected" from a token + gist id + file names alone — it makes no network call on that path.
 * So writing those keys directly is enough to get past the connect screen. The token here is a
 * placeholder: the reconcile that runs on load will 401 and land on the retry path, which is
 * harmless and leaves the seeded state on screen.
 *
 * Usage:
 *   1. npm run start:webview:pwa
 *   2. open http://localhost:4200 with DevTools in device emulation (a phone preset — the mobile
 *      rules key off `pointer: coarse`, not viewport width)
 *   3. paste this whole file into the console, then reload
 *
 * To get back to a clean slate: indexedDB.deleteDatabase("vsc-todo-pwa") and reload.
 */
(async () => {
	const DB = "vsc-todo-pwa";
	const USER_FILE = "user-todos.json";
	const WS_FILE = "workspace-default.json";
	const NOW = new Date().toISOString();

	const todo = (id, text, o = {}) => ({
		id,
		text,
		completed: false,
		creationDate: "2026-08-01T09:00:00.000Z",
		isMarkdown: false,
		isNote: false,
		...o,
	});

	// Ids here line up with the conflict records below; changing one means changing both.
	const userTodos = [
		todo(101, "Buy oat milk"),
		todo(102, "Book the dentist"),
		todo(103, "Renew passport"),
		todo(999, "Renew driving licence"), // the copy keep-both added for the id collision
		todo(104, "Water the plants — moved to Friday"), // edited after the sync => stale card
	];
	const wsTodos = [todo(201, "Ship the conflict review"), todo(202, "Write release notes")];
	const filesData = { "src/sync/SyncManager.ts": [todo(301, "drop the duplicated merge")] };

	const pending = [
		// Plain edit-edit: both versions exist, so this is the card that offers a field merge.
		{
			kind: "todo",
			key: "user:101",
			scope: "user",
			todoId: 101,
			conflictType: "edit-edit",
			base: todo(101, "Buy milk"),
			local: todo(101, "Buy oat milk"),
			remote: todo(101, "Buy almond milk", {
				completed: true,
				completionDate: NOW,
				tags: ["shopping"],
			}),
			resolvedValue: todo(101, "Buy oat milk"),
			syncedAt: NOW,
		},
		// resolvedValue no longer matches the list above, so this one renders as stale and asks
		// for a second tap before it will overwrite.
		{
			kind: "todo",
			key: "user:104",
			scope: "user",
			todoId: 104,
			conflictType: "edit-edit",
			base: todo(104, "Water the plants"),
			local: todo(104, "Water the plants"),
			remote: todo(104, "Water the plants twice a week"),
			resolvedValue: todo(104, "Water the plants"),
			syncedAt: NOW,
		},
		// Deleted here, edited there: prefer-local dropped it, so choosing the other device has to
		// put it back — the insert-by-id path.
		{
			kind: "todo",
			key: "user:200",
			scope: "user",
			todoId: 200,
			conflictType: "delete-edit",
			base: todo(200, "Cancel the gym"),
			local: null,
			remote: todo(200, "Cancel the gym membership before the 30th"),
			resolvedValue: null,
			syncedAt: NOW,
		},
		// Id collision, already settled by keeping both. Informational card with an undo.
		{
			kind: "kept-both",
			key: "user:103",
			scope: "user",
			todoId: 103,
			local: todo(103, "Renew passport"),
			remote: todo(103, "Renew driving licence"),
			newId: 999,
			syncedAt: NOW,
		},
		// Whole per-file list, for a path the PWA itself never renders.
		{
			kind: "file",
			key: "file:src/sync/SyncManager.ts",
			filePath: "src/sync/SyncManager.ts",
			conflictType: "file-edit-edit",
			base: [],
			local: [todo(301, "drop the duplicated merge")],
			remote: [todo(302, "unify the conflict UX"), todo(303, "add a regression test")],
			resolvedValue: [todo(301, "drop the duplicated merge")],
			syncedAt: NOW,
		},
	];

	const cache = (data) => ({ data, lastCleanRemoteData: data, lastSynced: NOW, isDirty: false });

	await new Promise((res, rej) => {
		const del = indexedDB.deleteDatabase(DB);
		del.onsuccess = res;
		del.onerror = rej;
		del.onblocked = res;
	});

	// Create all three stores in one upgrade. KeyValueStore can add them one at a time on demand,
	// but doing it up front keeps the seed a single transaction-per-write afterwards.
	const db = await new Promise((res, rej) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => {
			for (const store of ["sync-cache", "auth", "conflicts"]) {
				req.result.createObjectStore(store);
			}
		};
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});

	const put = (store, key, value) =>
		new Promise((res, rej) => {
			const r = db.transaction(store, "readwrite").objectStore(store).put(value, key);
			r.onsuccess = res;
			r.onerror = () => rej(r.error);
		});

	await put("auth", "github-token", "seed-only-not-a-real-token");
	await put("auth", "gist-id", "0123456789abcdef0123456789abcdef");
	await put("auth", "user-file", USER_FILE);
	await put("auth", "workspace-file", WS_FILE);
	await put("sync-cache", `gistCache_global_${USER_FILE}`, cache({ userTodos }));
	await put(
		"sync-cache",
		`gistCache_workspace_${WS_FILE}`,
		cache({ workspaceTodos: wsTodos, filesData, filesDataPaths: {} })
	);
	await put("conflicts", "pending", pending);
	db.close();

	console.log(`Seeded ${pending.length} conflicts. Reload to see the banner.`);
})();
