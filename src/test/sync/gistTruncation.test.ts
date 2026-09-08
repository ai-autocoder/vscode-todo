/**
 * `GitHubApiClient.readFile` and GitHub's truncated gist content.
 *
 * The gist API embeds a file's `content` inline only up to a size cap. Past it, it still sends a
 * `content` field — a cut-off prefix of the file — and sets `truncated: true`, expecting the
 * client to fetch `raw_url` instead. This client used to return the inline content
 * unconditionally, so a large todo list reached the reconcile as a JSON fragment: either a parse
 * failure reported as "failed to parse remote gist data", or worse, a parse that succeeded on a
 * prefix and read as a remote that had lost most of its todos. The shared core's `GistClient`
 * has always made this check; this copy had not.
 */

import * as assert from "assert";
import { GitHubApiClient } from "../../sync/GitHubApiClient";
import { GitHubAuthManager } from "../../sync/GitHubAuthManager";

const GIST_ID = "a".repeat(32);
const FILE = "user-todos.json";
const FULL = JSON.stringify({ userTodos: [{ id: 1, text: "complete" }] });
/** What GitHub would embed: valid-looking, but cut off. */
const TRUNCATED = FULL.slice(0, 20);
/** Host the fake raw_url points at, so the stub can tell the two requests apart. */
const RAW_HOST = "gist.githubusercontent.com";

suite("Gist content truncation", () => {
	let originalFetch: typeof globalThis.fetch;
	let rawUrlFetches: string[];

	/** `GitHubAuthManager` is a process-wide singleton that binds the first context it is given. */
	function resetAuthSingleton(): void {
		(GitHubAuthManager as unknown as { instance: GitHubAuthManager | undefined }).instance =
			undefined;
	}

	/**
	 * A client whose gist serves `file` as its one entry, with `raw_url` serving the whole thing.
	 * Every request is answered locally — nothing here may reach api.github.com.
	 */
	function clientWithGistFile(file: Record<string, unknown>): GitHubApiClient {
		resetAuthSingleton();
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes(RAW_HOST)) {
				rawUrlFetches.push(url);
				return new Response(FULL, { status: 200 });
			}
			return new Response(JSON.stringify({ id: GIST_ID, files: { [FILE]: file } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		// A token, so readFile gets past the auth check.
		return new GitHubApiClient({
			secrets: { get: () => Promise.resolve("token") },
		} as never);
	}

	setup(() => {
		originalFetch = globalThis.fetch;
		rawUrlFetches = [];
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
		resetAuthSingleton();
	});

	test("returns inline content when the API says it is complete", async () => {
		const client = clientWithGistFile({
			filename: FILE,
			content: FULL,
			truncated: false,
			raw_url: `https://${RAW_HOST}/raw/${FILE}`,
		});

		const result = await client.readFile(GIST_ID, FILE);

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.data, FULL);
		assert.deepStrictEqual(rawUrlFetches, [], "no need to fetch the raw url");
	});

	test("fetches the raw url when the inline content is truncated", async () => {
		const client = clientWithGistFile({
			filename: FILE,
			content: TRUNCATED,
			truncated: true,
			raw_url: `https://${RAW_HOST}/raw/${FILE}`,
		});

		const result = await client.readFile(GIST_ID, FILE);

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.data, FULL, "must be the whole file, not the embedded prefix");
		assert.notStrictEqual(result.data, TRUNCATED);
		assert.strictEqual(rawUrlFetches.length, 1, "raw url fetched exactly once");
	});

	test("still fetches the raw url when no content is embedded at all", async () => {
		const client = clientWithGistFile({
			filename: FILE,
			truncated: false,
			raw_url: `https://${RAW_HOST}/raw/${FILE}`,
		});

		const result = await client.readFile(GIST_ID, FILE);

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.data, FULL);
	});
});
