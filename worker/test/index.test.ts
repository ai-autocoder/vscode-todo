/**
 * The device-flow CORS proxy. It is small, but it is the one piece of the system reachable by
 * anybody on the internet, so its gates are pinned here: which methods and paths it forwards,
 * what it forwards, the CORS answer per origin, and the optional client-id allowlist.
 *
 * Runs on Node's own test runner with its built-in TypeScript stripping (Node 22.18+ / 23.6+),
 * so the worker needs no test dependency: `npm --prefix worker test`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/index.ts";

type Forwarded = { url: string; init: RequestInit };

const PAGES = "https://plans-app.pages.dev";
const ENV: Env = { ALLOWED_ORIGINS: PAGES };

let forwarded: Forwarded[];
let upstream: () => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
	forwarded = [];
	upstream = () =>
		new Response(JSON.stringify({ device_code: "dc" }), {
			status: 200,
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		forwarded.push({ url: String(input), init: init ?? {} });
		return upstream();
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function request(
	path: string,
	{
		method = "POST",
		origin = PAGES,
		body = JSON.stringify({ client_id: "Iv1.app", scope: "gist" }),
		contentType = "application/json",
	}: { method?: string; origin?: string | null; body?: string | null; contentType?: string | null } = {}
): Request {
	const headers = new Headers();
	if (origin) headers.set("Origin", origin);
	if (contentType) headers.set("Content-Type", contentType);
	return new Request(`https://proxy.example${path}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : body ?? undefined,
	});
}

describe("methods and paths", () => {
	it("answers a preflight with 204 and the CORS headers, forwarding nothing", async () => {
		const res = await worker.fetch(request("/login/device/code", { method: "OPTIONS" }), ENV);

		assert.equal(res.status, 204);
		assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
		assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
		assert.equal(res.headers.get("Vary"), "Origin");
		assert.equal(forwarded.length, 0);
	});

	for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
		it(`refuses ${method} with 405`, async () => {
			const res = await worker.fetch(request("/login/device/code", { method }), ENV);

			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
			assert.equal(forwarded.length, 0);
		});
	}

	for (const path of ["/", "/login/device", "/login/oauth/authorize", "/login/device/code/", "/gists", "/LOGIN/DEVICE/CODE"]) {
		it(`refuses to forward ${path} (not an open proxy)`, async () => {
			const res = await worker.fetch(request(path), ENV);

			assert.equal(res.status, 404);
			assert.equal(forwarded.length, 0);
		});
	}
});

describe("forwarding", () => {
	it("forwards the device-code POST to github.com with the body unchanged", async () => {
		const body = JSON.stringify({ client_id: "Iv1.app", scope: "gist" });
		const res = await worker.fetch(request("/login/device/code", { body }), ENV);

		assert.equal(res.status, 200);
		assert.equal(forwarded.length, 1);
		assert.equal(forwarded[0].url, "https://github.com/login/device/code");
		assert.equal(forwarded[0].init.method, "POST");
		assert.equal(forwarded[0].init.body, body);
		const headers = forwarded[0].init.headers as Record<string, string>;
		assert.equal(headers["Accept"], "application/json");
		assert.equal(headers["Content-Type"], "application/json");
		assert.equal(headers["User-Agent"], "agent-plans-auth-proxy");
	});

	it("forwards the token POST, and never the query string", async () => {
		await worker.fetch(request("/login/oauth/access_token?client_id=someone-else"), ENV);

		assert.equal(forwarded[0].url, "https://github.com/login/oauth/access_token");
	});

	it("forwards no credentials or cookies from the caller", async () => {
		const req = request("/login/device/code");
		req.headers.set("Cookie", "session=secret");
		req.headers.set("Authorization", "Bearer gho_secret");

		await worker.fetch(req, ENV);

		const headers = forwarded[0].init.headers as Record<string, string>;
		assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Content-Type", "User-Agent"]);
	});

	it("passes GitHub's status and body through with CORS headers added", async () => {
		upstream = () =>
			new Response(JSON.stringify({ error: "authorization_pending" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});

		const res = await worker.fetch(request("/login/oauth/access_token"), ENV);

		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "authorization_pending" });
		assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
	});

	it("answers 502 upstream_unreachable when github.com cannot be reached", async () => {
		upstream = () => {
			throw new TypeError("network down");
		};

		const res = await worker.fetch(request("/login/device/code"), ENV);

		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: "upstream_unreachable" });
	});
});

describe("CORS origin", () => {
	it("echoes an allowlisted origin", async () => {
		const env = { ALLOWED_ORIGINS: `http://localhost:4200, ${PAGES}` };
		const res = await worker.fetch(request("/login/device/code", { origin: PAGES }), env);

		assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
	});

	it("names the first listed origin for any other origin, so the browser refuses the response", async () => {
		const res = await worker.fetch(
			request("/login/device/code", { origin: "https://abc123.plans-app.pages.dev" }),
			ENV
		);

		assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
	});

	it("answers * to a caller that sends no Origin (not a browser)", async () => {
		const res = await worker.fetch(request("/login/device/code", { origin: null }), ENV);

		assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
	});

	it("answers * when no allowlist is configured", async () => {
		const res = await worker.fetch(request("/login/device/code", { origin: "https://anywhere.example" }), {});

		assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
	});
});

describe("CLIENT_ID allowlist", () => {
	const env: Env = { ...ENV, CLIENT_ID: "Iv1.app" };

	it("forwards the configured client id", async () => {
		const res = await worker.fetch(request("/login/device/code"), env);

		assert.equal(res.status, 200);
		assert.equal(forwarded.length, 1);
	});

	it("refuses another client id in a JSON body", async () => {
		const res = await worker.fetch(
			request("/login/device/code", { body: JSON.stringify({ client_id: "Iv1.other" }) }),
			env
		);

		assert.equal(res.status, 403);
		assert.deepEqual(await res.json(), { error: "forbidden_client" });
		assert.equal(forwarded.length, 0);
	});

	it("refuses another client id in a form-encoded body", async () => {
		const res = await worker.fetch(
			request("/login/device/code", {
				body: "client_id=Iv1.other&scope=gist",
				contentType: "application/x-www-form-urlencoded",
			}),
			env
		);

		assert.equal(res.status, 403);
	});

	/**
	 * AUDIT: the allowlist trusts its own parse of the body, and GitHub parses it differently.
	 * `extractClientId` reads JSON only when the Content-Type contains the lower-case string
	 * `application/json`, and otherwise takes the FIRST `client_id` of a form body. GitHub treats
	 * MIME types case-insensitively and (Rails) takes the LAST of a repeated form parameter. So
	 * both requests below are checked as "no client id" / "the right client id" here and reach
	 * GitHub as another app's. Low impact — the allowlist is optional hardening, off in
	 * wrangler.toml — but it does not do what it says. Expected: 403 for both.
	 */
	it("AUDIT (known bypass): an upper-case JSON content type skips the check", { todo: "known bypass — see comment" }, async () => {
		const res = await worker.fetch(
			request("/login/device/code", {
				body: JSON.stringify({ client_id: "Iv1.other" }),
				contentType: "Application/JSON",
			}),
			env
		);

		assert.equal(res.status, 403);
	});

	it("AUDIT (known bypass): a repeated form parameter is checked on its first value only", { todo: "known bypass — see comment" }, async () => {
		const res = await worker.fetch(
			request("/login/device/code", {
				body: "client_id=Iv1.app&client_id=Iv1.other",
				contentType: "application/x-www-form-urlencoded",
			}),
			env
		);

		assert.equal(res.status, 403);
	});

	it("AUDIT (known gap): a body with no client id at all is forwarded", { todo: "harmless: GitHub rejects it" }, async () => {
		const res = await worker.fetch(request("/login/device/code", { body: JSON.stringify({ scope: "gist" }) }), env);

		assert.equal(res.status, 403);
	});
});
