/**
 * The interactive {@link ConflictResolver} hook.
 *
 * The VS Code extension resolves conflicts by asking the user; the PWA applies a policy and
 * offers after-the-fact review. Both drive this one engine, so the hook has to leave the policy
 * path untouched and has to get the two destructive edge cases right:
 *
 *  - a conflict the resolver does NOT decide keeps the local version. The extension's dialog has
 *    a "Skip This Conflict — decide later" option, and the implementation behind it used to
 *    return a *list* of resolved todos. A three-way merge deliberately omits conflicting ids
 *    from its auto-merged output, so a skipped item was in neither the list nor the auto-merge:
 *    it was uploaded as absent and deleted on both devices, under a menu entry promising to ask
 *    again. Absent from the decision map must mean "policy decides", never "delete".
 *  - a resolver that declines writes nothing at all, and leaves the baseline alone, so the same
 *    conflict is raised next sync rather than silently settled.
 */

import { describe, expect, it } from "vitest";
import {
	ConflictDecisions,
	ConflictResolver,
	GistSyncEngine,
	MemoryCacheStore,
	serialize,
} from "../src/index";
import { GlobalGistData, SyncErrorType } from "../src/syncTypes";
import { Todo } from "../src/todoTypes";

const todo = (id: number, text: string, extra: Partial<Todo> = {}): Todo => ({
	id,
	text,
	completed: false,
	creationDate: "2026-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...extra,
});

/** In-memory gist with one file, so a reconcile can be driven end to end. */
class FakeGist {
	public writes = 0;
	constructor(private content: string | undefined) {}

	get raw(): string | undefined {
		return this.content;
	}

	async readFile() {
		return this.content === undefined
			? { success: false as const, error: undefined }
			: { success: true as const, data: this.content };
	}

	async writeFile(_gistId: string, _fileName: string, content: string) {
		this.writes++;
		this.content = content;
		return { success: true as const, data: {} };
	}
}

/**
 * A file both sides have edited: base has one todo, local renamed it one way, remote another.
 * Returns everything a test needs to drive one reconcile over that state.
 */
async function bothEdited(resolver?: ConflictResolver) {
	const base: GlobalGistData = { userTodos: [todo(1, "base"), todo(2, "untouched")] };
	const remote: GlobalGistData = { userTodos: [todo(1, "remote edit"), todo(2, "untouched")] };
	const local: GlobalGistData = { userTodos: [todo(1, "local edit"), todo(2, "untouched")] };

	const gist = new FakeGist(serialize(remote));
	const store = new MemoryCacheStore();
	await store.save("gistCache_global_todos.json", {
		data: local,
		lastCleanRemoteData: base,
		lastSynced: new Date(0).toISOString(),
		isDirty: true,
	});

	const engine = new GistSyncEngine({
		client: gist,
		gistId: "g",
		cacheStore: store,
		conflictResolver: resolver,
	});

	return { engine, gist, store, base, local, remote };
}

describe("GistSyncEngine conflict resolver", () => {
	it("applies the side the resolver picked", async () => {
		const { engine, gist } = await bothEdited(async () => ({
			todos: new Map([[1, todo(1, "remote edit")]]),
		}));

		const res = await engine.reconcileUser("todos.json", {
			userTodos: [todo(1, "local edit"), todo(2, "untouched")],
		});

		expect(res.success).toBe(true);
		expect(res.data!.data.userTodos.find((t) => t.id === 1)!.text).toBe("remote edit");
		// And the choice reached the gist, not just local state.
		expect(JSON.parse(gist.raw!).userTodos.find((t: Todo) => t.id === 1).text).toBe("remote edit");
	});

	it("keeps the local version for a conflict the resolver skipped, instead of deleting it", async () => {
		// An empty map is exactly what the dialog returns when every conflict is skipped.
		const { engine, gist } = await bothEdited(async () => ({ todos: new Map() }));

		const res = await engine.reconcileUser("todos.json", {
			userTodos: [todo(1, "local edit"), todo(2, "untouched")],
		});

		expect(res.success).toBe(true);
		const ids = res.data!.data.userTodos.map((t) => t.id);
		expect(ids).toContain(1);
		expect(res.data!.data.userTodos.find((t) => t.id === 1)!.text).toBe("local edit");
		// The regression: the todo must still be on the gist too.
		expect(JSON.parse(gist.raw!).userTodos.map((t: Todo) => t.id)).toContain(1);
	});

	it("reports the conflict even when it was skipped, so the next sync asks again", async () => {
		const { engine } = await bothEdited(async () => ({ todos: new Map() }));

		const res = await engine.reconcileUser("todos.json", {
			userTodos: [todo(1, "local edit"), todo(2, "untouched")],
		});

		expect(res.data!.conflicts).toHaveLength(1);
		expect(res.data!.conflicts[0].todoId).toBe(1);
	});

	it("writes nothing and keeps the baseline when the resolver declines", async () => {
		const { engine, gist, store, base } = await bothEdited(async () => null);

		const res = await engine.reconcileUser("todos.json", {
			userTodos: [todo(1, "local edit"), todo(2, "untouched")],
		});

		expect(res.success).toBe(false);
		expect(res.error!.retryable).toBe(true);
		expect(gist.writes).toBe(0);
		// The baseline is what makes the conflict re-derivable. Moving it would settle the
		// conflict by accident: local would then match base and read as "nothing to push".
		const cache = await store.load<GlobalGistData>("gistCache_global_todos.json");
		expect(cache!.lastCleanRemoteData).toEqual(base);
	});

	it("raises the same conflict again on the sync after a decline", async () => {
		// Declines once, then answers — the "decide later, then decide" sequence.
		let calls = 0;
		const { engine } = await bothEdited(async ({ todos }) => {
			calls++;
			return calls === 1 ? null : { todos: new Map([[todos[0].todoId, todos[0].remote]]) };
		});
		const local = { userTodos: [todo(1, "local edit"), todo(2, "untouched")] };

		const first = await engine.reconcileUser("todos.json", local);
		expect(first.success).toBe(false);

		const second = await engine.reconcileUser("todos.json", local);

		expect(second.success).toBe(true);
		expect(calls).toBe(2);
		// The conflict was still there to be asked about, which is the whole point of leaving the
		// baseline untouched on a decline.
		expect(second.data!.conflicts).toHaveLength(1);
		expect(second.data!.data.userTodos.find((t) => t.id === 1)!.text).toBe("remote edit");
	});

	it("keeps both sides when the resolver returns an extra todo", async () => {
		// An id collision: the two todos were created independently and drew the same id, so
		// neither is a version of the other and picking a side destroys a real item.
		const remote: GlobalGistData = { userTodos: [todo(7, "written on the phone")] };
		const local: GlobalGistData = { userTodos: [todo(7, "written in VS Code")] };
		const gist = new FakeGist(serialize(remote));
		const store = new MemoryCacheStore();
		await store.save("gistCache_global_todos.json", {
			data: local,
			// Empty base: neither side had this id before, which is what makes it a collision.
			lastCleanRemoteData: { userTodos: [] },
			lastSynced: new Date(0).toISOString(),
			isDirty: true,
		});

		let seenIds: number[] = [];
		const engine = new GistSyncEngine({
			client: gist,
			gistId: "g",
			cacheStore: store,
			conflictResolver: async ({ todos, knownIds }) => {
				seenIds = knownIds;
				const collision = todos[0];
				return {
					todos: new Map([[collision.todoId, collision.local]]),
					// Keyed by the conflict it was raised from, so it lands beside that item.
					extraTodos: new Map([[collision.todoId, [{ ...collision.remote!, id: 999 }]]]),
				} satisfies ConflictDecisions;
			},
		});

		const res = await engine.reconcileUser("todos.json", local);

		expect(res.success).toBe(true);
		const texts = res.data!.data.userTodos.map((t) => t.text).sort();
		expect(texts).toEqual(["written in VS Code", "written on the phone"]);
		expect(res.data!.data.userTodos.map((t) => t.id).sort()).toEqual([7, 999]);
		// The resolver needs the ids in play to pick a free one.
		expect(seenIds).toContain(7);
	});

	it("leaves the policy path alone when no resolver is configured", async () => {
		const { engine, gist } = await bothEdited();

		const res = await engine.reconcileUser("todos.json", {
			userTodos: [todo(1, "local edit"), todo(2, "untouched")],
		});

		// prefer-local is the default, and it still applies with nobody to ask.
		expect(res.data!.data.userTodos.find((t) => t.id === 1)!.text).toBe("local edit");
		expect(gist.writes).toBe(1);
	});

	it("stores the baseline as its own object, not an alias of data", async () => {
		// Every success path calls `saveCache(key, X, X)` — the reconciled result IS the new
		// baseline — so without a clone the two fields are one object in the stored cache. A
		// CacheStore that persists by reference (VS Code's mementos do) then lets an in-place
		// edit of `data` move the merge baseline with it, and the next reconcile sees
		// local === base, treats the untouched remote as a remote change, and deletes the edit.
		const remote: GlobalGistData = { userTodos: [todo(1, "one")] };
		const gist = new FakeGist(serialize(remote));
		const store = new MemoryCacheStore();
		const engine = new GistSyncEngine({ client: gist, gistId: "g", cacheStore: store });

		await engine.reconcileUser("todos.json", { userTodos: [] });

		const cache = await store.load<GlobalGistData>("gistCache_global_todos.json");
		expect(cache!.data).not.toBe(cache!.lastCleanRemoteData);

		// And prove the consequence, not just the identity: mutating `data` in place must leave
		// the baseline alone.
		cache!.data.userTodos.push(todo(2, "added locally"));
		expect(cache!.lastCleanRemoteData!.userTodos.map((t) => t.id)).toEqual([1]);
	});

	it("does not write when the verifying re-read fails for a reason other than 'absent'", async () => {
		// The re-read is the only thing standing between the write and an overwrite. A network
		// drop or a 5xx leaves us unable to tell an absent file from a peer's fresh content, so
		// writing anyway would push over it AND record the result as the clean baseline — after
		// which the next reconcile sees remote == base and never pulls the lost change back.
		const base: GlobalGistData = { userTodos: [todo(1, "one")] };
		const local: GlobalGistData = { userTodos: [todo(1, "one, edited here")] };
		const gist = new FakeGist(serialize(base));
		const store = new MemoryCacheStore();
		await store.save("gistCache_global_todos.json", {
			data: local,
			lastCleanRemoteData: base,
			lastSynced: new Date(0).toISOString(),
			isDirty: true,
		});

		let reads = 0;
		const flaky = {
			readFile: async (...args: [string, string]) => {
				reads++;
				// The first read succeeds (the reconcile's own); the verifying re-read fails.
				return reads === 1
					? gist.readFile(...args)
					: {
							success: false as const,
							error: {
								type: SyncErrorType.NetworkError,
								message: "socket hang up",
								timestamp: new Date().toISOString(),
								retryable: true,
							},
						};
			},
			writeFile: gist.writeFile.bind(gist),
		};

		const engine = new GistSyncEngine({ client: flaky, gistId: "g", cacheStore: store });
		const res = await engine.reconcileUser("todos.json", local);

		expect(res.success).toBe(false);
		expect(res.error?.type).toBe(SyncErrorType.NetworkError);
		expect(gist.writes).toBe(0);
		// The baseline must not have moved, or the next reconcile cannot tell it still owes a push.
		const cache = await store.load<GlobalGistData>("gistCache_global_todos.json");
		expect(cache!.lastCleanRemoteData).toEqual(base);
	});

	it("still recreates a file that genuinely vanished mid-flight", async () => {
		// The companion to the test above: a real "not found" IS safe to write through, and must
		// not be caught by the new guard.
		const base: GlobalGistData = { userTodos: [todo(1, "one")] };
		const local: GlobalGistData = { userTodos: [todo(1, "one, edited here")] };
		const gist = new FakeGist(serialize(base));
		const store = new MemoryCacheStore();
		await store.save("gistCache_global_todos.json", {
			data: local,
			lastCleanRemoteData: base,
			lastSynced: new Date(0).toISOString(),
			isDirty: true,
		});

		let reads = 0;
		const vanishing = {
			readFile: async (...args: [string, string]) => {
				reads++;
				return reads === 1
					? gist.readFile(...args)
					: {
							success: false as const,
							error: {
								type: SyncErrorType.FileNotFoundError,
								message: "gone",
								timestamp: new Date().toISOString(),
								retryable: false,
							},
						};
			},
			writeFile: gist.writeFile.bind(gist),
		};

		const engine = new GistSyncEngine({ client: vanishing, gistId: "g", cacheStore: store });
		const res = await engine.reconcileUser("todos.json", local);

		expect(res.success).toBe(true);
		expect(gist.writes).toBe(1);
		expect(JSON.parse(gist.raw!).userTodos[0].text).toBe("one, edited here");
	});

	it("does not call the resolver when the merge is clean", async () => {
		// Only the remote moved, and on a todo local never touched: nothing to decide.
		const base: GlobalGistData = { userTodos: [todo(1, "one")] };
		const remote: GlobalGistData = { userTodos: [todo(1, "one"), todo(2, "added remotely")] };
		const gist = new FakeGist(serialize(remote));
		const store = new MemoryCacheStore();
		await store.save("gistCache_global_todos.json", {
			data: base,
			lastCleanRemoteData: base,
			lastSynced: new Date(0).toISOString(),
			isDirty: false,
		});

		let asked = 0;
		const engine = new GistSyncEngine({
			client: gist,
			gistId: "g",
			cacheStore: store,
			conflictResolver: async () => {
				asked++;
				return {};
			},
		});

		await engine.reconcileUser("todos.json", base);

		expect(asked).toBe(0);
	});
});
