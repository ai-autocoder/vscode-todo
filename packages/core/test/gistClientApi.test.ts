/**
 * The PWA's gist client beyond its caching directive (see gistClient.test.ts): what each call
 * sends, how GitHub's answers map onto {@link SyncErrorType}, and the reads the engine depends on.
 *
 * The mapping matters more than it looks. The engine treats exactly one error type —
 * `FileNotFoundError` — as "the file is absent, safe to create", so a client that reported a
 * deleted *gist*, a network drop or a rate limit that way would seed a file over content it never
 * saw. And the PWA's banner is chosen from the type, so a mis-mapped status tells the user to do
 * the wrong thing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GistClient } from "../src/gistClient";
import { SyncErrorType } from "../src/syncTypes";

const GIST_ID = "0123456789abcdef0123456789abcdef";
const FILE = "user-todos.json";

type Call = { url: string; init: RequestInit | undefined };
type Reply = { status?: number; body?: unknown; statusText?: string } | Error;

function stubFetch(respond: (url: string, init?: RequestInit) => Reply): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const reply = respond(url, init);
		if (reply instanceof Error) {
			throw reply;
		}
		const text =
			reply.body === undefined
				? ""
				: typeof reply.body === "string"
					? reply.body
					: JSON.stringify(reply.body);
		return new Response(text, { status: reply.status ?? 200, statusText: reply.statusText });
	});
	return calls;
}

const gist = (files: Record<string, { content?: string; truncated?: boolean; size?: number }>) => ({
	id: GIST_ID,
	files: Object.fromEntries(
		Object.entries(files).map(([name, f]) => [
			name,
			{ filename: name, raw_url: `https://raw.example/${name}`, size: f.size ?? 1, ...f },
		])
	),
});

describe("GistClient without a token", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reports an auth error from every call and never touches the network", async () => {
		const calls = stubFetch(() => ({ body: {} }));
		const client = new GistClient({ getToken: () => undefined });

		const results = await Promise.all([
			client.listGists(),
			client.fetchGist(GIST_ID),
			client.readFile(GIST_ID, FILE),
			client.writeFile(GIST_ID, FILE, "{}"),
			client.createGist("d", { [FILE]: "{}" }),
			client.listFiles(GIST_ID, "user"),
		]);

		for (const result of results) {
			expect(result.success).toBe(false);
			expect(result.error?.type).toBe(SyncErrorType.AuthError);
		}
		expect(calls).toHaveLength(0);
	});

	it("accepts an async token provider", async () => {
		const calls = stubFetch(() => ({ body: [] }));
		const client = new GistClient({ getToken: async () => "gho_async" });

		await client.listGists();

		expect((calls[0].init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer gho_async");
	});
});

describe("GistClient requests", () => {
	let client: GistClient;

	beforeEach(() => {
		client = new GistClient({ getToken: () => "gho_token", userAgent: "vsc-todo-tests" });
	});

	afterEach(() => vi.unstubAllGlobals());

	it("sends the API version, bearer token and user agent", async () => {
		const calls = stubFetch(() => ({ body: gist({}) }));

		await client.fetchGist(GIST_ID);

		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer gho_token");
		expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
		expect(headers["Accept"]).toBe("application/vnd.github+json");
		expect(headers["User-Agent"]).toBe("vsc-todo-tests");
	});

	it("rejects a malformed gist id before any request", async () => {
		const calls = stubFetch(() => ({ body: gist({}) }));

		const res = await client.fetchGist("not-a-gist-id");

		expect(res.error?.type).toBe(SyncErrorType.InvalidGistIdError);
		expect(calls).toHaveLength(0);
	});

	it("writes one file with a PATCH that names only that file", async () => {
		const calls = stubFetch(() => ({ body: gist({ [FILE]: { content: "{}" } }) }));

		const res = await client.writeFile(GIST_ID, FILE, '{"userTodos":[]}');

		expect(res.success).toBe(true);
		expect(calls[0].url).toBe(`https://api.github.com/gists/${GIST_ID}`);
		expect(calls[0].init?.method).toBe("PATCH");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			files: { [FILE]: { content: '{"userTodos":[]}' } },
		});
	});

	it.each(["", "   \n"])("refuses to write empty content (%j) — GitHub would delete the file", async (content) => {
		const calls = stubFetch(() => ({ body: {} }));

		const res = await client.writeFile(GIST_ID, FILE, content);

		expect(res.error?.type).toBe(SyncErrorType.ValidationError);
		expect(calls).toHaveLength(0);
	});

	it("creates a secret gist by default", async () => {
		const calls = stubFetch(() => ({ status: 201, body: gist({ [FILE]: { content: "{}" } }) }));

		const res = await client.createGist("VS Code Todo Sync", { [FILE]: "{}" });

		expect(res.success).toBe(true);
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			description: "VS Code Todo Sync",
			public: false,
			files: { [FILE]: { content: "{}" } },
		});
	});

	it("refuses to create a gist with no files, or with an empty one", async () => {
		const calls = stubFetch(() => ({ body: {} }));

		const none = await client.createGist("d", {});
		const blank = await client.createGist("d", { [FILE]: "{}", "user-b.json": " " });

		expect(none.error?.type).toBe(SyncErrorType.ValidationError);
		expect(blank.error?.type).toBe(SyncErrorType.ValidationError);
		expect(blank.error?.message).toContain("user-b.json");
		expect(calls).toHaveLength(0);
	});

	it("summarises the gist listing", async () => {
		stubFetch(() => ({
			body: [
				{ id: "a", description: "  VS Code Todo Sync  ", public: false, files: { x: {}, y: {} }, updated_at: "2026-01-01T00:00:00Z" },
				{ id: "b", description: null, public: true, files: {}, updated_at: "2026-01-02T00:00:00Z" },
			],
		}));

		const res = await client.listGists();

		expect(res.data).toEqual([
			{ id: "a", description: "VS Code Todo Sync", isPublic: false, filesCount: 2, updatedAt: "2026-01-01T00:00:00Z" },
			{ id: "b", description: "", isPublic: true, filesCount: 0, updatedAt: "2026-01-02T00:00:00Z" },
		]);
	});

	it("finds the most recently updated gist with the sync description", async () => {
		stubFetch(() => ({
			body: [
				{ id: "old", description: "VS Code Todo Sync", public: false, files: {}, updated_at: "2026-01-01T00:00:00Z" },
				{ id: "other", description: "Something else", public: false, files: {}, updated_at: "2026-03-01T00:00:00Z" },
				{ id: "new", description: "VS Code Todo Sync", public: false, files: {}, updated_at: "2026-02-01T00:00:00Z" },
			],
		}));

		const res = await client.findGistByDescription("VS Code Todo Sync");

		expect(res.success).toBe(true);
		expect(res.data?.id).toBe("new");
	});

	it("answers undefined, not an error, when no gist carries the description", async () => {
		stubFetch(() => ({ body: [] }));

		const res = await client.findGistByDescription("VS Code Todo Sync");

		expect(res.success).toBe(true);
		expect(res.data).toBeUndefined();
	});

	it("lists only the scope's .json files, with the prefix and extension stripped", async () => {
		stubFetch(() => ({
			body: gist({
				"user-todos.json": { size: 10 },
				"user-Work.json": { size: 20 },
				"workspace-app.json": { size: 30 },
				"user-notes.md": { size: 40 },
				"README.json": { size: 50 },
			}),
		}));

		const users = await client.listFiles(GIST_ID, "user");
		const workspaces = await client.listFiles(GIST_ID, "workspace");

		expect(users.data).toEqual([
			{ displayName: "todos", fullPath: "user-todos.json", size: 10 },
			{ displayName: "Work", fullPath: "user-Work.json", size: 20 },
		]);
		expect(workspaces.data).toEqual([{ displayName: "app", fullPath: "workspace-app.json", size: 30 }]);
	});

	it("builds the gist's web url", () => {
		expect(client.getGistUrl(GIST_ID)).toBe(`https://gist.github.com/${GIST_ID}`);
	});
});

describe("GistClient.readFile", () => {
	let client: GistClient;

	beforeEach(() => {
		client = new GistClient({ getToken: () => "gho_token" });
	});

	afterEach(() => vi.unstubAllGlobals());

	it("returns inline content without a second request", async () => {
		const calls = stubFetch(() => ({ body: gist({ [FILE]: { content: '{"userTodos":[]}' } }) }));

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.data).toBe('{"userTodos":[]}');
		expect(calls).toHaveLength(1);
	});

	it("reports a file missing from an existing gist as FileNotFoundError — the one 'safe to create' answer", async () => {
		stubFetch(() => ({ body: gist({ "user-other.json": { content: "{}" } }) }));

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.error?.type).toBe(SyncErrorType.FileNotFoundError);
	});

	it("reports a deleted gist as NotFoundError, never as a missing file", async () => {
		stubFetch(() => ({ status: 404, body: { message: "Not Found" } }));

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.error?.type).toBe(SyncErrorType.NotFoundError);
		expect(res.error?.type).not.toBe(SyncErrorType.FileNotFoundError);
	});

	it("fetches raw_url when the inline content is absent even though truncated is not set", async () => {
		const calls = stubFetch((url) =>
			url.startsWith("https://raw.example/") ? { body: '{"userTodos":[]}' } : { body: gist({ [FILE]: {} }) }
		);

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.data).toBe('{"userTodos":[]}');
		expect(calls.map((c) => c.url)).toContain(`https://raw.example/${FILE}`);
	});

	it("maps a failed raw_url download through the same error mapping", async () => {
		stubFetch((url) =>
			url.startsWith("https://raw.example/")
				? { status: 500, statusText: "Server Error" }
				: { body: gist({ [FILE]: { truncated: true } }) }
		);

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.success).toBe(false);
		expect(res.error?.type).toBe(SyncErrorType.UnknownError);
		expect(res.error?.retryable).toBe(true);
	});

	it("reports a thrown fetch as a retryable network error", async () => {
		stubFetch(() => new TypeError("Failed to fetch"));

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.error?.type).toBe(SyncErrorType.NetworkError);
		expect(res.error?.retryable).toBe(true);
		expect(res.error?.message).toBe("Failed to fetch");
	});
});

describe("GistClient error mapping", () => {
	let client: GistClient;

	beforeEach(() => {
		client = new GistClient({ getToken: () => "gho_token" });
	});

	afterEach(() => vi.unstubAllGlobals());

	it.each([
		[401, SyncErrorType.AuthError, true],
		[403, SyncErrorType.AuthError, true],
		[404, SyncErrorType.NotFoundError, false],
		[422, SyncErrorType.ValidationError, false],
		[429, SyncErrorType.RateLimitError, true],
		[500, SyncErrorType.UnknownError, true],
		[502, SyncErrorType.UnknownError, true],
	])("maps HTTP %i to %s (retryable: %s)", async (status, type, retryable) => {
		stubFetch(() => ({ status, body: { message: `status ${status}` } }));

		const res = await client.fetchGist(GIST_ID);

		expect(res.success).toBe(false);
		expect(res.error?.type).toBe(type);
		expect(res.error?.retryable).toBe(retryable);
		expect(res.error?.message).toBe(`status ${status}`);
	});

	it("appends GitHub's validation details to the message", async () => {
		stubFetch(() => ({
			status: 422,
			body: {
				message: "Validation Failed",
				errors: [{ message: "content is too big" }, { code: "missing_field" }, { resource: "Gist" }],
			},
		}));

		const res = await client.writeFile(GIST_ID, FILE, "{}");

		expect(res.error?.message).toBe(
			'Validation Failed - Details: content is too big, missing_field, {"resource":"Gist"}'
		);
	});

	it("falls back to the status line when the error body is not JSON", async () => {
		stubFetch(() => ({ status: 503, statusText: "Service Unavailable", body: "<html>down</html>" }));

		const res = await client.fetchGist(GIST_ID);

		expect(res.error?.type).toBe(SyncErrorType.UnknownError);
		expect(res.error?.message).toBe("HTTP 503: Service Unavailable");
	});

	it("logs the GitHub error through the configured logger", async () => {
		const logger = vi.fn();
		client = new GistClient({ getToken: () => "gho_token", logger });
		stubFetch(() => ({ status: 401, body: { message: "Bad credentials" } }));

		await client.fetchGist(GIST_ID);

		expect(logger).toHaveBeenCalledWith(expect.stringContaining("Bad credentials"));
	});
});
