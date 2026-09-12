/**
 * Puts the PWA in front of a REAL, engine-produced sync conflict, so the up-front conflict
 * dialog can be exercised without a GitHub login and without a second device.
 *
 * Its sibling, seed-pwa-conflicts.js, seeds finished `PendingConflict` records: it exercises the
 * after-the-fact review screen but never runs the merge. This one is the other half. It sets up
 * a genuine three-way divergence (a baseline, a local edit, a different remote edit) and lets
 * `threeWayMerge` find the conflict itself, which is the only way to see what the user actually
 * gets.
 *
 * Two pastes, because the fake remote is a `fetch` shim and a shim cannot survive the reload
 * that puts the seeded local state into memory:
 *
 *   1. npm run start:webview:pwa, open http://localhost:4200, paste this file.
 *      It seeds the session and the sync cache, then reloads the page itself.
 *   2. Paste it again. It installs the fake gist API and fires `focus`, which is what the PWA
 *      syncs on. The reconcile reads the fake remote, the merge conflicts, and the dialog opens.
 *
 * Clean slate: indexedDB.deleteDatabase("vsc-todo-pwa"), sessionStorage.clear(), reload.
 */
(async () => {
	const DB = "vsc-todo-pwa";
	const GIST_ID = "0123456789abcdef0123456789abcdef";
	const USER_FILE = "user-todos.json";
	const WS_FILE = "workspace-default.json";
	const STEP_KEY = "seed-pwa-conflict-prompt";
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

	/**
	 * One list, three ways. Todo 401 is edited differently on each side (edit-edit), 402 is
	 * edited here and deleted there (edit-delete), and 403/404 exist only on one side each, so
	 * they auto-merge and prove the dialog only asks about what is genuinely in dispute.
	 */
	const base = [todo(401, "Pick a venue"), todo(402, "Send the invites"), todo(405, "Order a cake")];
	const local = [
		todo(401, "Pick a venue in the old town"),
		todo(402, "Send the invites by Friday"),
		todo(405, "Order a cake"),
		todo(403, "Book the photographer"),
	];
	const remote = [
		todo(401, "Pick a venue near the station"),
		todo(405, "Order a cake"),
		todo(404, "Confirm the playlist"),
	];

	// Same shape the sync engine writes: `data` is this device's list, `lastCleanRemoteData` is
	// the merge baseline. Making them differ is what marks the local edit as an edit.
	const userCache = {
		data: { userTodos: local },
		lastCleanRemoteData: { userTodos: base },
		lastSynced: NOW,
		isDirty: true,
	};
	const wsData = { workspaceTodos: [], filesData: {}, filesDataPaths: {} };
	const wsCache = { data: wsData, lastCleanRemoteData: wsData, lastSynced: NOW, isDirty: false };

	const serialize = (value) => JSON.stringify(value, null, 2);

	// --- step 2: fake the gist API and trigger a sync -------------------------------------
	if (sessionStorage.getItem(STEP_KEY) === "seeded") {
		sessionStorage.removeItem(STEP_KEY);

		const files = {
			[USER_FILE]: serialize({ userTodos: remote }),
			[WS_FILE]: serialize(wsData),
		};
		const gistBody = () => ({
			id: GIST_ID,
			description: "Fake gist (seed-pwa-conflict-prompt.js)",
			files: Object.fromEntries(
				Object.entries(files).map(([name, content]) => [
					name,
					{ filename: name, content, truncated: false, raw_url: `https://example.invalid/${name}` },
				])
			),
		});
		const json = (body) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const realFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input.url;
			if (!url.startsWith("https://api.github.com/gists/")) {
				return realFetch(input, init);
			}
			const method = (init && init.method) || "GET";
			if (method === "PATCH") {
				const body = JSON.parse(init.body);
				for (const [name, file] of Object.entries(body.files)) {
					files[name] = file.content;
					console.log(`[fake gist] wrote ${name}:\n${file.content}`);
				}
				return json(gistBody());
			}
			return json(gistBody());
		};

		console.log("Fake gist installed. Firing focus to start a sync...");
		// What the PWA actually syncs on; see the focus handler in pwa-shell.component.ts.
		window.dispatchEvent(new Event("focus"));
		console.log(
			"The dialog should open with 2 conflicts (401 edit-edit, 402 edit-delete).\n" +
				"403 and 404 auto-merge and are deliberately not shown.\n" +
				"Every PATCH is logged above, so you can see exactly what each choice pushes."
		);
		return;
	}

	// --- step 1: seed the session and the sync cache --------------------------------------
	await new Promise((res, rej) => {
		const del = indexedDB.deleteDatabase(DB);
		del.onsuccess = res;
		del.onerror = rej;
		del.onblocked = res;
	});

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
	await put("auth", "gist-id", GIST_ID);
	await put("auth", "user-file", USER_FILE);
	await put("auth", "workspace-file", WS_FILE);
	await put("sync-cache", `gistCache_global_${USER_FILE}`, userCache);
	await put("sync-cache", `gistCache_workspace_${WS_FILE}`, wsCache);
	db.close();

	sessionStorage.setItem(STEP_KEY, "seeded");
	console.log("Seeded. Reloading; paste this file again once the list is on screen.");
	location.reload();
})();
