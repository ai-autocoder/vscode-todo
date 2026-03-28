/**
 * GitHub OAuth Device Flow CORS proxy (Cloudflare Worker).
 *
 * The PWA cannot call GitHub's device-flow endpoints directly: they live on `github.com`
 * (not `api.github.com`) and send no CORS headers, so the browser blocks them. This Worker
 * forwards ONLY those two POSTs to GitHub and adds CORS headers. It holds no secrets — the
 * device flow is a public-client flow keyed by a public `client_id` — so it is purely a CORS
 * shim, deliberately scoped to two exact paths so it can never be used as an open proxy.
 *
 * Gist read/write is NOT proxied here: `api.github.com` already allows CORS, so the PWA
 * talks to it directly with the token.
 */

export interface Env {
	/** Comma-separated allowlist of browser origins, or "*". Defaults to "*". */
	ALLOWED_ORIGINS?: string;
	/** Optional: when set, only requests carrying this client_id are forwarded. */
	CLIENT_ID?: string;
}

const GITHUB_BASE = "https://github.com";
const ALLOWED_PATHS = new Set(["/login/oauth/device/code", "/login/oauth/access_token"]);

function resolveAllowedOrigin(env: Env, requestOrigin: string | null): string {
	const configured = (env.ALLOWED_ORIGINS ?? "*").trim();
	if (configured === "*" || !requestOrigin) {
		return "*";
	}
	const allowlist = configured.split(",").map((o) => o.trim()).filter(Boolean);
	return allowlist.includes(requestOrigin) ? requestOrigin : allowlist[0] ?? "*";
}

function corsHeaders(allowOrigin: string): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": allowOrigin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Accept",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

function json(body: unknown, status: number, allowOrigin: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...corsHeaders(allowOrigin) },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const allowOrigin = resolveAllowedOrigin(env, request.headers.get("Origin"));

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
		}

		if (request.method !== "POST") {
			return json({ error: "method_not_allowed" }, 405, allowOrigin);
		}

		if (!ALLOWED_PATHS.has(url.pathname)) {
			return json({ error: "not_found" }, 404, allowOrigin);
		}

		// Read the body once so we can optionally validate client_id, then re-send it.
		let bodyText = "";
		try {
			bodyText = await request.text();
		} catch {
			return json({ error: "invalid_request" }, 400, allowOrigin);
		}

		if (env.CLIENT_ID) {
			const sentClientId = extractClientId(bodyText, request.headers.get("Content-Type"));
			if (sentClientId && sentClientId !== env.CLIENT_ID) {
				return json({ error: "forbidden_client" }, 403, allowOrigin);
			}
		}

		try {
			const upstream = await fetch(`${GITHUB_BASE}${url.pathname}`, {
				method: "POST",
				headers: {
					"Content-Type": request.headers.get("Content-Type") ?? "application/json",
					Accept: "application/json",
					"User-Agent": "vsc-todo-auth-proxy",
				},
				body: bodyText,
			});

			const text = await upstream.text();
			return new Response(text, {
				status: upstream.status,
				headers: {
					"Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
					...corsHeaders(allowOrigin),
				},
			});
		} catch {
			return json({ error: "upstream_unreachable" }, 502, allowOrigin);
		}
	},
};

/** Best-effort client_id extraction from a JSON or form-encoded body. */
function extractClientId(body: string, contentType: string | null): string | null {
	try {
		if (contentType?.includes("application/json")) {
			return (JSON.parse(body) as { client_id?: string }).client_id ?? null;
		}
		return new URLSearchParams(body).get("client_id");
	} catch {
		return null;
	}
}
