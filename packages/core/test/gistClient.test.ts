import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GistClient } from "../src/gistClient";

const GIST_ID = "0123456789abcdef0123456789abcdef";
const FILE = "user-todos.json";

type Call = { url: string; init: RequestInit | undefined };

/**
 * Records every request the client makes and answers it with canned JSON, so a test can assert
 * on the `RequestInit` rather than on the response.
 */
function stubFetch(respond: (url: string) => unknown): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const payload = respond(url);
		return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return calls;
}

const gistWith = (content: string) => ({
	id: GIST_ID,
	files: { [FILE]: { filename: FILE, content, truncated: false, raw_url: "https://raw.example/x" } },
});

describe("GistClient HTTP caching", () => {
	let client: GistClient;

	beforeEach(() => {
		client = new GistClient({ getToken: () => "gho_token" });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/**
	 * The regression this guards. GitHub answers a gist GET with `Cache-Control: max-age=60`, so
	 * in a browser — the PWA is the only peer running this client in one — the HTTP cache would
	 * serve a minute-old copy of the gist with no network request at all. The engine then reads
	 * `remote === base`, treats a peer's edit as "only local changed", and pushes straight over
	 * it with no merge and no conflict prompt. Node has no HTTP cache, which is why the extension
	 * never had the bug and why nothing else in the suite would catch its return here.
	 */
	it("should revalidate every gist read rather than let the browser serve a cached copy", async () => {
		const calls = stubFetch(() => gistWith("{}"));

		await client.fetchGist(GIST_ID);

		expect(calls).toHaveLength(1);
		expect(calls[0].init?.cache).toBe("no-cache");
	});

	it("should revalidate the gist read behind readFile", async () => {
		const calls = stubFetch(() => gistWith('{"userTodos":[]}'));

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.success).toBe(true);
		expect(calls.every((c) => c.init?.cache === "no-cache")).toBe(true);
	});

	it("should revalidate the raw_url fallback for a truncated file", async () => {
		// raw.githubusercontent.com is cached harder than the API (max-age=300), so the fallback
		// path needs the same treatment as the inline one.
		const calls = stubFetch((url) =>
			url.startsWith("https://raw.example/")
				? '{"userTodos":[]}'
				: {
						id: GIST_ID,
						files: {
							[FILE]: { filename: FILE, truncated: true, raw_url: "https://raw.example/x" },
						},
					}
		);

		const res = await client.readFile(GIST_ID, FILE);

		expect(res.success).toBe(true);
		const raw = calls.find((c) => c.url.startsWith("https://raw.example/"));
		expect(raw?.init?.cache).toBe("no-cache");
	});

	it("should revalidate the gist listing", async () => {
		const calls = stubFetch(() => []);

		await client.listGists();

		expect(calls[0].init?.cache).toBe("no-cache");
	});
});
