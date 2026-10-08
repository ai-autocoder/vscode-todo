/**
 * The PWA's sign-in: GitHub's OAuth device flow (RFC 8628) through the CORS proxy.
 *
 * Nothing else exercises this client — the PWA shell drives it against the real proxy — so
 * these pin the protocol it speaks: what it posts, how it waits, and which GitHub answers end
 * the poll. Timers are faked so the intervals (seconds, in the real flow) cost nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	DeviceFlowClient,
	DeviceFlowError,
	DEVICE_CODE_PATH,
	ACCESS_TOKEN_PATH,
	DEVICE_GRANT_TYPE,
} from "../src/deviceFlow";

type Call = { url: string; body: Record<string, unknown> };

/** A fetch that answers each call from `replies` in turn, recording what was posted. */
function scriptedFetch(replies: Array<{ status?: number; body: unknown } | Error>) {
	const calls: Call[] = [];
	let next = 0;
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
		const reply = replies[Math.min(next++, replies.length - 1)];
		if (reply instanceof Error) {
			throw reply;
		}
		const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
		return new Response(text, { status: reply.status ?? 200 });
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const client = (fetchImpl: typeof fetch, over: Partial<{ scope: string; proxyBaseUrl: string }> = {}) =>
	new DeviceFlowClient({
		clientId: "Iv1.public",
		proxyBaseUrl: over.proxyBaseUrl ?? "https://proxy.example/",
		scope: over.scope,
		fetchImpl,
	});

/** Lets the poll loop run through `seconds` of fake time, one interval's worth at a time. */
async function advance(seconds: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(seconds * 1000);
}

describe("DeviceFlowClient.requestDeviceCode", () => {
	it("posts the public client id and the gist scope to the proxy, without a doubled slash", async () => {
		const { impl, calls } = scriptedFetch([
			{
				body: {
					device_code: "dc",
					user_code: "ABCD-1234",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: 5,
				},
			},
		]);

		const code = await client(impl).requestDeviceCode();

		expect(code.user_code).toBe("ABCD-1234");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`https://proxy.example${DEVICE_CODE_PATH}`);
		expect(calls[0].body).toEqual({ client_id: "Iv1.public", scope: "gist" });
	});

	it("sends a custom scope when one is configured", async () => {
		const { impl, calls } = scriptedFetch([{ body: { device_code: "dc", interval: 5 } }]);

		await client(impl, { scope: "gist read:user" }).requestDeviceCode();

		expect(calls[0].body["scope"]).toBe("gist read:user");
	});

	it("rejects with http_error when the proxy answers with a failure status", async () => {
		const { impl } = scriptedFetch([{ status: 502, body: { error: "upstream_unreachable" } }]);

		const error = await client(impl).requestDeviceCode().catch((e) => e);

		expect(error).toBeInstanceOf(DeviceFlowError);
		expect(error.code).toBe("http_error");
		expect(error.message).toContain("502");
	});

	it("surfaces a GitHub error carried in a 200 body, preferring its description", async () => {
		const { impl } = scriptedFetch([
			{ body: { error: "unauthorized_client", error_description: "Device flow is disabled" } },
		]);

		const error = await client(impl).requestDeviceCode().catch((e) => e);

		expect(error).toBeInstanceOf(DeviceFlowError);
		expect(error.code).toBe("unauthorized_client");
		expect(error.message).toBe("Device flow is disabled");
	});
});

describe("DeviceFlowClient.pollForToken", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits one interval before the first poll, then returns the token", async () => {
		const { impl, calls } = scriptedFetch([{ body: { access_token: "gho_abc", token_type: "bearer" } }]);

		const token = client(impl).pollForToken("dc", 5);
		await advance(4);
		expect(calls).toHaveLength(0);
		await advance(1);

		await expect(token).resolves.toBe("gho_abc");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`https://proxy.example${ACCESS_TOKEN_PATH}`);
		expect(calls[0].body).toEqual({
			client_id: "Iv1.public",
			device_code: "dc",
			grant_type: DEVICE_GRANT_TYPE,
		});
	});

	it("keeps polling on authorization_pending, reporting the time left each time", async () => {
		const { impl, calls } = scriptedFetch([
			{ body: { error: "authorization_pending" } },
			{ body: { error: "authorization_pending" } },
			{ body: { access_token: "gho_abc" } },
		]);
		const onPending = vi.fn();

		const token = client(impl).pollForToken("dc", 5, { onPending });
		await advance(15);

		await expect(token).resolves.toBe("gho_abc");
		expect(calls).toHaveLength(3);
		expect(onPending).toHaveBeenCalledTimes(2);
		const [{ secondsRemaining }] = onPending.mock.calls[0];
		expect(secondsRemaining).toBeGreaterThan(0);
		expect(secondsRemaining).toBeLessThanOrEqual(15 * 60);
	});

	it("backs off by five seconds on slow_down", async () => {
		const { impl, calls } = scriptedFetch([
			{ body: { error: "slow_down" } },
			{ body: { access_token: "gho_abc" } },
		]);

		const token = client(impl).pollForToken("dc", 5);
		await advance(5); // first poll → slow_down
		expect(calls).toHaveLength(1);
		await advance(9); // the old interval has passed, the new one (10 s) has not
		expect(calls).toHaveLength(1);
		await advance(1);

		await expect(token).resolves.toBe("gho_abc");
		expect(calls).toHaveLength(2);
	});

	it("treats an interval below one second as one second", async () => {
		const { impl, calls } = scriptedFetch([{ body: { access_token: "gho_abc" } }]);

		const token = client(impl).pollForToken("dc", 0);
		await advance(1);

		await expect(token).resolves.toBe("gho_abc");
		expect(calls).toHaveLength(1);
	});

	it.each([
		["expired_token", "expired"],
		["access_denied", "denied"],
	])("stops with %s", async (code, wording) => {
		const { impl } = scriptedFetch([{ body: { error: code } }]);

		const token = client(impl).pollForToken("dc", 5);
		const settled = token.catch((e) => e);
		await advance(5);
		const error = await settled;

		expect(error).toBeInstanceOf(DeviceFlowError);
		expect(error.code).toBe(code);
		expect(error.message.toLowerCase()).toContain(wording);
	});

	it("stops on an unrecognised GitHub error, carrying its code and description", async () => {
		const { impl } = scriptedFetch([
			{ body: { error: "incorrect_device_code", error_description: "The device_code is wrong" } },
		]);

		const settled = client(impl).pollForToken("dc", 5).catch((e) => e);
		await advance(5);
		const error = await settled;

		expect(error.code).toBe("incorrect_device_code");
		expect(error.message).toBe("The device_code is wrong");
	});

	it("rejects with cancelled when aborted while waiting, and polls no more", async () => {
		const { impl, calls } = scriptedFetch([{ body: { error: "authorization_pending" } }]);
		const controller = new AbortController();

		const settled = client(impl).pollForToken("dc", 5, { signal: controller.signal }).catch((e) => e);
		await advance(5); // one poll, now sleeping
		controller.abort();
		const error = await settled;
		await advance(60);

		expect(error).toBeInstanceOf(DeviceFlowError);
		expect(error.code).toBe("cancelled");
		expect(calls).toHaveLength(1);
	});

	it("rejects with cancelled at once when the signal is already aborted", async () => {
		const { impl, calls } = scriptedFetch([{ body: { access_token: "gho_abc" } }]);
		const controller = new AbortController();
		controller.abort();

		const error = await client(impl)
			.pollForToken("dc", 5, { signal: controller.signal })
			.catch((e) => e);

		expect(error.code).toBe("cancelled");
		expect(calls).toHaveLength(0);
	});

	it("gives up with timeout after the fifteen-minute cap", async () => {
		const { impl } = scriptedFetch([{ body: { error: "authorization_pending" } }]);

		const settled = client(impl).pollForToken("dc", 60).catch((e) => e);
		await advance(16 * 60);
		const error = await settled;

		expect(error).toBeInstanceOf(DeviceFlowError);
		expect(error.code).toBe("timeout");
	});

	/**
	 * Known defect: one transient failure ends the whole sign-in. The poll neither checks
	 * `response.ok` nor catches a rejected fetch, so a dropped connection (common on a phone
	 * switching to the GitHub app to approve) or a non-JSON 5xx page from the proxy rejects with a
	 * raw TypeError/SyntaxError. The user has already typed the code; they must start over with a
	 * new one. Expected: keep polling until GitHub itself answers, the deadline passes or the user
	 * cancels. Flip to `it` once fixed.
	 */
	it.fails("keeps polling through a transient network failure", async () => {
		const { impl } = scriptedFetch([
			new TypeError("Failed to fetch"),
			{ body: { access_token: "gho_abc" } },
		]);

		const settled = client(impl).pollForToken("dc", 5).catch((e) => e);
		await advance(10);

		expect(await settled).toBe("gho_abc");
	});

	it.fails("keeps polling through a non-JSON 5xx answer from the proxy", async () => {
		const { impl } = scriptedFetch([
			{ status: 502, body: "<html>Bad gateway</html>" },
			{ body: { access_token: "gho_abc" } },
		]);

		const settled = client(impl).pollForToken("dc", 5).catch((e) => e);
		await advance(10);

		expect(await settled).toBe("gho_abc");
	});

	/**
	 * Known defect: the abort signal is honoured only between polls, never passed to `fetch`,
	 * so a cancel that lands while a poll is in flight still resolves with the token when GitHub
	 * approves in that same answer — the caller asked to stop and got signed in anyway.
	 */
	it.fails("does not resolve with a token after the caller cancelled mid-request", async () => {
		const controller = new AbortController();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const impl = (async () => {
			await gate;
			return new Response(JSON.stringify({ access_token: "gho_abc" }));
		}) as unknown as typeof fetch;

		const settled = client(impl).pollForToken("dc", 5, { signal: controller.signal }).catch((e) => e);
		await advance(5); // poll is now in flight
		controller.abort();
		release();

		const outcome = await settled;
		expect(outcome).toBeInstanceOf(DeviceFlowError);
	});
});
