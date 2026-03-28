/**
 * GitHub OAuth Device Flow client for the standalone PWA.
 *
 * Why a proxy: the device-flow endpoints live on `github.com` (not `api.github.com`) and
 * send no CORS headers, so a browser cannot call them directly. `proxyBaseUrl` points at a
 * tiny CORS-adding proxy (e.g. a Cloudflare Worker) that forwards these two POSTs to GitHub.
 * The flow is a public-client flow: only the public `clientId` is needed — no secret — so
 * the proxy holds no credentials.
 */

export const DEVICE_CODE_PATH = "/login/oauth/device/code";
export const ACCESS_TOKEN_PATH = "/login/oauth/access_token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceFlowOptions {
	/** Public GitHub OAuth App client id. */
	clientId: string;
	/** Base URL of the CORS proxy that forwards to github.com (no trailing slash needed). */
	proxyBaseUrl: string;
	/** OAuth scope(s). Defaults to "gist". */
	scope?: string;
	/** Override fetch (tests / non-browser hosts). Defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/** Response from the device/code endpoint — what to show the user. */
export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export interface PollOptions {
	/** Called each time GitHub reports the user has not authorized yet. */
	onPending?: (info: { secondsRemaining: number }) => void;
	/** Cancels polling. */
	signal?: AbortSignal;
}

/** Error carrying the GitHub OAuth error code (e.g. "access_denied", "expired_token"). */
export class DeviceFlowError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message);
		this.name = "DeviceFlowError";
	}
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DeviceFlowError("Device flow cancelled", "cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DeviceFlowError("Device flow cancelled", "cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

export class DeviceFlowClient {
	private readonly fetchImpl: typeof fetch;
	private readonly scope: string;
	private readonly base: string;

	constructor(private readonly options: DeviceFlowOptions) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.scope = options.scope ?? "gist";
		this.base = options.proxyBaseUrl.replace(/\/$/, "");
	}

	/** Step 1: request a device + user code to display to the user. */
	public async requestDeviceCode(): Promise<DeviceCodeResponse> {
		const response = await this.fetchImpl(`${this.base}${DEVICE_CODE_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ client_id: this.options.clientId, scope: this.scope }),
		});
		if (!response.ok) {
			throw new DeviceFlowError(`Failed to start device flow (HTTP ${response.status})`, "http_error");
		}
		const data = (await response.json()) as DeviceCodeResponse & { error?: string; error_description?: string };
		if (data.error) {
			throw new DeviceFlowError(data.error_description || data.error, data.error);
		}
		return data;
	}

	/**
	 * Step 2: poll until the user authorizes, then resolve with the access token. Honors
	 * GitHub's `authorization_pending` (keep waiting) and `slow_down` (back off) signals.
	 */
	public async pollForToken(deviceCode: string, intervalSeconds: number, opts: PollOptions = {}): Promise<string> {
		let intervalMs = Math.max(1, intervalSeconds) * 1000;
		const deadline = Date.now() + 15 * 60 * 1000; // hard cap; GitHub codes expire ~15 min

		// Wait one interval before the first poll (the user needs time to enter the code).
		await sleep(intervalMs, opts.signal);

		while (Date.now() < deadline) {
			const response = await this.fetchImpl(`${this.base}${ACCESS_TOKEN_PATH}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					client_id: this.options.clientId,
					device_code: deviceCode,
					grant_type: DEVICE_GRANT_TYPE,
				}),
			});

			const data = (await response.json()) as {
				access_token?: string;
				token_type?: string;
				scope?: string;
				error?: string;
				error_description?: string;
			};

			if (data.access_token) {
				return data.access_token;
			}

			switch (data.error) {
				case "authorization_pending":
					opts.onPending?.({ secondsRemaining: Math.max(0, Math.round((deadline - Date.now()) / 1000)) });
					break;
				case "slow_down":
					intervalMs += 5000;
					break;
				case "expired_token":
					throw new DeviceFlowError("The device code expired. Please try connecting again.", "expired_token");
				case "access_denied":
					throw new DeviceFlowError("Authorization was denied.", "access_denied");
				default:
					if (data.error) {
						throw new DeviceFlowError(data.error_description || data.error, data.error);
					}
			}

			await sleep(intervalMs, opts.signal);
		}

		throw new DeviceFlowError("Timed out waiting for authorization.", "timeout");
	}
}
