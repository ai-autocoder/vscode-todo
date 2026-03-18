import * as assert from "assert";
import * as http from "node:http";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { beforeEach } from "mocha";
import createStore from "../../../todo/store";
import { StoreState } from "../../../todo/todoTypes";
import StorageSyncManager from "../../../storage/StorageSyncManager";
import McpServerHost from "../../../mcp/McpServerHost";

/**
 * The security-relevant request gates on McpServerHost (token auth, Origin /
 * DNS-rebinding validation, session-id parsing, initialize detection) are pure
 * functions of their inputs. These tests reach them via casts — the same pattern
 * the TodoService suite uses — so the gates are pinned without a live HTTP server.
 */

type McpConfig = {
	enabled: boolean;
	readOnly: boolean;
	allowedScopes: Array<"user" | "workspace" | "file">;
	transport: "streamableHttp";
	port: number;
	token: string;
};

// Minimal ExtensionContext: McpServerHost's constructor only needs workspaceState/
// globalState (for the TodoService it builds) and extension.packageJSON.version.
function createMockContext(): vscode.ExtensionContext {
	const workspaceStore = new Map<string, unknown>();
	const globalStore = new Map<string, unknown>();
	return {
		globalState: {
			get: (key: string, defaultValue?: unknown) => globalStore.get(key) ?? defaultValue,
			update: async (key: string, value: unknown) => {
				globalStore.set(key, value);
			},
		},
		workspaceState: {
			get: (key: string, defaultValue?: unknown) => workspaceStore.get(key) ?? defaultValue,
			update: async (key: string, value: unknown) => {
				workspaceStore.set(key, value);
			},
		},
		extension: { packageJSON: { version: "9.9.9" } },
	} as unknown as vscode.ExtensionContext;
}

function createMockStorage(): StorageSyncManager {
	return {
		persistSlice: async () => undefined,
	} as unknown as StorageSyncManager;
}

function makeConfig(overrides: Partial<McpConfig> = {}): McpConfig {
	return {
		enabled: true,
		readOnly: true,
		allowedScopes: ["user", "workspace", "file"],
		transport: "streamableHttp",
		port: 7337,
		token: "",
		...overrides,
	};
}

function makeReq(
	headers: http.IncomingHttpHeaders = {},
	method = "POST",
	url = "/mcp"
): http.IncomingMessage {
	return { headers, method, url } as unknown as http.IncomingMessage;
}

suite("McpServerHost request gates", () => {
	let host: McpServerHost;
	// Cast to reach the private gate methods under test.
	let priv: {
		isAuthorized(req: http.IncomingMessage, config: McpConfig): boolean;
		isOriginAllowed(req: http.IncomingMessage, config: McpConfig): boolean;
		getSessionId(req: http.IncomingMessage, url?: URL): string | undefined;
		isInitializeLikeRequest(body: unknown): boolean;
		lastPort: number | null;
	};

	beforeEach(() => {
		const store = createStore() as EnhancedStore<StoreState>;
		host = new McpServerHost(createMockContext(), store, createMockStorage());
		priv = host as unknown as typeof priv;
	});

	// --- isAuthorized -------------------------------------------------------

	test("auth: no token configured allows any request", () => {
		assert.strictEqual(priv.isAuthorized(makeReq({}), makeConfig({ token: "" })), true);
	});

	test("auth: missing Authorization header is rejected when a token is set", () => {
		assert.strictEqual(priv.isAuthorized(makeReq({}), makeConfig({ token: "secret" })), false);
	});

	test("auth: correct bearer token is accepted", () => {
		const req = makeReq({ authorization: "Bearer secret" });
		assert.strictEqual(priv.isAuthorized(req, makeConfig({ token: "secret" })), true);
	});

	test("auth: bearer scheme is case-insensitive and trims the token", () => {
		const req = makeReq({ authorization: "bearer   secret  " });
		assert.strictEqual(priv.isAuthorized(req, makeConfig({ token: "secret" })), true);
	});

	test("auth: wrong token is rejected", () => {
		const req = makeReq({ authorization: "Bearer wrong" });
		assert.strictEqual(priv.isAuthorized(req, makeConfig({ token: "secret" })), false);
	});

	test("auth: token of a different length is rejected (constant-time path)", () => {
		const req = makeReq({ authorization: "Bearer s" });
		assert.strictEqual(priv.isAuthorized(req, makeConfig({ token: "secret" })), false);
	});

	test("auth: non-bearer Authorization header is rejected", () => {
		const req = makeReq({ authorization: "Basic secret" });
		assert.strictEqual(priv.isAuthorized(req, makeConfig({ token: "secret" })), false);
	});

	// --- isOriginAllowed (DNS-rebinding guard) ------------------------------

	test("origin: absent Origin header is treated as a trusted non-browser client", () => {
		assert.strictEqual(priv.isOriginAllowed(makeReq({}), makeConfig()), true);
	});

	test("origin: loopback origin on the configured port is allowed", () => {
		const req = makeReq({ origin: "http://127.0.0.1:7337" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig({ port: 7337 })), true);
	});

	test("origin: localhost origin on the configured port is allowed", () => {
		const req = makeReq({ origin: "http://localhost:7337" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig({ port: 7337 })), true);
	});

	test("origin: portless loopback origin is allowed", () => {
		const req = makeReq({ origin: "http://localhost" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig({ port: 7337 })), true);
	});

	test("origin: non-loopback host is rejected (DNS-rebinding guard)", () => {
		const req = makeReq({ origin: "http://evil.example.com" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig()), false);
	});

	test("origin: loopback host on the wrong port is rejected", () => {
		const req = makeReq({ origin: "http://127.0.0.1:9999" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig({ port: 7337 })), false);
	});

	test("origin: malformed Origin value is rejected", () => {
		const req = makeReq({ origin: "not a url" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig()), false);
	});

	test("origin: matches the runtime lastPort when bound to a random port", () => {
		priv.lastPort = 54321;
		const req = makeReq({ origin: "http://127.0.0.1:54321" });
		assert.strictEqual(priv.isOriginAllowed(req, makeConfig({ port: 7337 })), true);
	});

	// --- getSessionId -------------------------------------------------------

	test("session id: read from the mcp-session-id header", () => {
		const req = makeReq({ "mcp-session-id": "abc-123" });
		assert.strictEqual(priv.getSessionId(req), "abc-123");
	});

	test("session id: query parameter takes precedence over the header", () => {
		const req = makeReq({ "mcp-session-id": "from-header" });
		const url = new URL("http://127.0.0.1/mcp?mcp-session-id=from-query");
		assert.strictEqual(priv.getSessionId(req, url), "from-query");
	});

	test("session id: legacy sessionId query key is accepted", () => {
		const url = new URL("http://127.0.0.1/mcp?sessionId=legacy");
		assert.strictEqual(priv.getSessionId(makeReq({}), url), "legacy");
	});

	test("session id: undefined when neither header nor query is present", () => {
		assert.strictEqual(priv.getSessionId(makeReq({})), undefined);
	});

	// --- isInitializeLikeRequest --------------------------------------------

	test("initialize-like: detects a method:'initialize' body", () => {
		assert.strictEqual(priv.isInitializeLikeRequest({ method: "initialize" }), true);
	});

	test("initialize-like: is case-insensitive on the method", () => {
		assert.strictEqual(priv.isInitializeLikeRequest({ method: "Initialize" }), true);
	});

	test("initialize-like: detects an initialize entry inside a batch array", () => {
		const body = [{ method: "ping" }, { method: "initialize" }];
		assert.strictEqual(priv.isInitializeLikeRequest(body), true);
	});

	test("initialize-like: a non-initialize body is not matched", () => {
		assert.strictEqual(priv.isInitializeLikeRequest({ method: "tools/call" }), false);
		assert.strictEqual(priv.isInitializeLikeRequest(null), false);
		assert.strictEqual(priv.isInitializeLikeRequest("initialize"), false);
	});
});
