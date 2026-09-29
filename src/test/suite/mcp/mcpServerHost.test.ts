import * as assert from "assert";
import * as http from "node:http";
import * as net from "node:net";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { EnhancedStore } from "@reduxjs/toolkit";
import { afterEach, beforeEach } from "mocha";
import createStore from "../../../todo/store";
import { StoreState } from "../../../todo/todoTypes";
import StorageSyncManager from "../../../storage/StorageSyncManager";
import McpServerHost from "../../../mcp/McpServerHost";
import McpHttpServer, {
	getSessionId,
	isAuthorized,
	isInitializeLikeRequest,
	isOriginAllowed,
} from "../../../mcp/McpHttpServer";
import { BridgeClient, BridgeRequest } from "../../../mcp/mcpBridge";
import { SERVER_NAME, STATIC_RESOURCES, TOOL_DEFINITIONS } from "../../../mcp/mcpDefinitions";

/**
 * The security-relevant request gates (token auth, Origin / DNS-rebinding validation,
 * session-id parsing, initialize detection) are pure functions of their inputs, so they are
 * pinned without a live HTTP server. The rest of the suite drives a real server: the handshake
 * must not depend on the extension host's thread, because another extension blocking that
 * thread used to make the MCP connect time out.
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

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "mcp-test", version: "0.0.0" },
	},
};

type RpcReply = { status: number; sessionId: string | null; body: any };

async function rpc(port: number, body: unknown, sessionId?: string): Promise<RpcReply> {
	const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	// Gate rejections (401, 403, 404) answer in plain text, not JSON-RPC.
	const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
	return {
		status: res.status,
		sessionId: res.headers.get("mcp-session-id"),
		body: text && isJson ? JSON.parse(text) : text || null,
	};
}

/** Initializes a session the way an MCP client does and returns its id. */
async function connect(port: number): Promise<string> {
	const init = await rpc(port, INITIALIZE);
	assert.strictEqual(init.status, 200, `initialize failed: ${JSON.stringify(init.body)}`);
	assert.ok(init.sessionId, "initialize should return a session id");
	const ack = await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
	assert.strictEqual(ack.status, 202);
	return init.sessionId;
}

suite("McpServerHost request gates", () => {
	// --- isAuthorized -------------------------------------------------------

	test("auth: no token configured allows any request", () => {
		assert.strictEqual(isAuthorized(makeReq({}), ""), true);
	});

	test("auth: missing Authorization header is rejected when a token is set", () => {
		assert.strictEqual(isAuthorized(makeReq({}), "secret"), false);
	});

	test("auth: correct bearer token is accepted", () => {
		const req = makeReq({ authorization: "Bearer secret" });
		assert.strictEqual(isAuthorized(req, "secret"), true);
	});

	test("auth: bearer scheme is case-insensitive and trims the token", () => {
		const req = makeReq({ authorization: "bearer   secret  " });
		assert.strictEqual(isAuthorized(req, "secret"), true);
	});

	test("auth: wrong token is rejected", () => {
		const req = makeReq({ authorization: "Bearer wrong" });
		assert.strictEqual(isAuthorized(req, "secret"), false);
	});

	test("auth: token of a different length is rejected (constant-time path)", () => {
		const req = makeReq({ authorization: "Bearer s" });
		assert.strictEqual(isAuthorized(req, "secret"), false);
	});

	test("auth: non-bearer Authorization header is rejected", () => {
		const req = makeReq({ authorization: "Basic secret" });
		assert.strictEqual(isAuthorized(req, "secret"), false);
	});

	// --- isOriginAllowed (DNS-rebinding guard) ------------------------------

	test("origin: absent Origin header is treated as a trusted non-browser client", () => {
		assert.strictEqual(isOriginAllowed(makeReq({}), 7337, null), true);
	});

	test("origin: loopback origin on the configured port is allowed", () => {
		const req = makeReq({ origin: "http://127.0.0.1:7337" });
		assert.strictEqual(isOriginAllowed(req, 7337, null), true);
	});

	test("origin: localhost origin on the configured port is allowed", () => {
		const req = makeReq({ origin: "http://localhost:7337" });
		assert.strictEqual(isOriginAllowed(req, 7337, null), true);
	});

	test("origin: portless loopback origin is allowed", () => {
		const req = makeReq({ origin: "http://localhost" });
		assert.strictEqual(isOriginAllowed(req, 7337, null), true);
	});

	test("origin: non-loopback host is rejected (DNS-rebinding guard)", () => {
		const req = makeReq({ origin: "http://evil.example.com" });
		assert.strictEqual(isOriginAllowed(req, 7337, null), false);
	});

	test("origin: loopback host on the wrong port is rejected", () => {
		const req = makeReq({ origin: "http://127.0.0.1:9999" });
		assert.strictEqual(isOriginAllowed(req, 7337, null), false);
	});

	test("origin: malformed Origin value is rejected", () => {
		const req = makeReq({ origin: "not a url" });
		assert.strictEqual(isOriginAllowed(req, 7337, null), false);
	});

	test("origin: matches the runtime bound port when bound to a random port", () => {
		const req = makeReq({ origin: "http://127.0.0.1:54321" });
		assert.strictEqual(isOriginAllowed(req, 7337, 54321), true);
	});

	// --- getSessionId -------------------------------------------------------

	test("session id: read from the mcp-session-id header", () => {
		const req = makeReq({ "mcp-session-id": "abc-123" });
		assert.strictEqual(getSessionId(req), "abc-123");
	});

	test("session id: query parameter takes precedence over the header", () => {
		const req = makeReq({ "mcp-session-id": "from-header" });
		const url = new URL("http://127.0.0.1/mcp?mcp-session-id=from-query");
		assert.strictEqual(getSessionId(req, url), "from-query");
	});

	test("session id: legacy sessionId query key is accepted", () => {
		const url = new URL("http://127.0.0.1/mcp?sessionId=legacy");
		assert.strictEqual(getSessionId(makeReq({}), url), "legacy");
	});

	test("session id: undefined when neither header nor query is present", () => {
		assert.strictEqual(getSessionId(makeReq({})), undefined);
	});

	// --- isInitializeLikeRequest --------------------------------------------

	test("initialize-like: detects a method:'initialize' body", () => {
		assert.strictEqual(isInitializeLikeRequest({ method: "initialize" }), true);
	});

	test("initialize-like: is case-insensitive on the method", () => {
		assert.strictEqual(isInitializeLikeRequest({ method: "Initialize" }), true);
	});

	test("initialize-like: detects an initialize entry inside a batch array", () => {
		const body = [{ method: "ping" }, { method: "initialize" }];
		assert.strictEqual(isInitializeLikeRequest(body), true);
	});

	test("initialize-like: a non-initialize body is not matched", () => {
		assert.strictEqual(isInitializeLikeRequest({ method: "tools/call" }), false);
		assert.strictEqual(isInitializeLikeRequest(null), false);
		assert.strictEqual(isInitializeLikeRequest("initialize"), false);
	});
});

suite("McpHttpServer with an unresponsive extension host", () => {
	let server: McpHttpServer;
	let bridge: BridgeClient;
	let port: number;
	const forwarded: BridgeRequest[] = [];

	// The host end of this bridge never answers, as when another extension blocks the
	// extension host's thread. Short timeouts keep the suite fast.
	beforeEach(async () => {
		forwarded.length = 0;
		bridge = new BridgeClient((message) => {
			if (message.type === "call") {
				forwarded.push(message.request);
			}
		});
		server = new McpHttpServer({
			host: "127.0.0.1",
			port: 0,
			token: "",
			version: "9.9.9",
			callTimeoutMs: 200,
			listTimeoutMs: 100,
			call: (request, timeoutMs) => bridge.call(request, timeoutMs),
			log: () => undefined,
		});
		port = await server.start();
	});

	afterEach(async () => {
		await server.stop();
		bridge.rejectAll("test finished");
	});

	test("initialize and tools/list are answered without the extension host", async () => {
		const init = await rpc(port, INITIALIZE);
		assert.strictEqual(init.status, 200);
		assert.strictEqual(init.body.result.serverInfo.name, SERVER_NAME);
		assert.strictEqual(init.body.result.serverInfo.version, "9.9.9");
		assert.ok(init.body.result.instructions.includes("todo_list_items"));

		const sessionId = await connect(port);
		const list = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
		const names = list.body.result.tools.map((tool: { name: string }) => tool.name).sort();
		assert.deepStrictEqual(names, TOOL_DEFINITIONS.map((tool) => tool.name).sort());
		assert.strictEqual(forwarded.length, 0, "the handshake should forward nothing to the host");
	});

	test("resources/list still lists the static resources when the file list times out", async () => {
		const sessionId = await connect(port);
		const list = await rpc(port, { jsonrpc: "2.0", id: 2, method: "resources/list" }, sessionId);
		assert.ok(list.body.result, `resources/list failed: ${JSON.stringify(list.body)}`);
		const uris = list.body.result.resources.map((resource: { uri: string }) => resource.uri).sort();
		assert.deepStrictEqual(uris, STATIC_RESOURCES.map((resource) => resource.uri).sort());
		assert.deepStrictEqual(forwarded, [{ op: "listFileResources" }]);
	});

	test("a tool call the host never answers fails with a busy error instead of hanging", async () => {
		const sessionId = await connect(port);
		const call = await rpc(
			port,
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "todo_count_items", arguments: {} },
			},
			sessionId
		);
		const result = call.body.result;
		assert.strictEqual(result.isError, true);
		assert.match(result.content[0].text, /did not answer/);
		assert.doesNotMatch(result.content[0].text, /may still be applied/);
		assert.deepStrictEqual(forwarded, [{ op: "tool", name: "todo_count_items", args: {} }]);
		assert.strictEqual(bridge.pendingCount, 0, "a timed-out call should not stay pending");
	});

	test("a timed-out change warns that it may still be applied", async () => {
		const sessionId = await connect(port);
		const call = await rpc(
			port,
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "todo_set_completed", arguments: { scope: "user", id: 1, completed: true } },
			},
			sessionId
		);
		assert.strictEqual(call.body.result.isError, true);
		assert.match(call.body.result.content[0].text, /may still be applied/);
	});

	test("stopping does not wait for a call the host never answered", async function () {
		this.timeout(10_000);
		const slow = new McpHttpServer({
			host: "127.0.0.1",
			port: 0,
			token: "",
			version: "9.9.9",
			callTimeoutMs: 60_000,
			listTimeoutMs: 100,
			call: (request, timeoutMs) => bridge.call(request, timeoutMs),
			log: () => undefined,
		});
		const slowPort = await slow.start();
		const sessionId = await connect(slowPort);
		const pendingCall = rpc(
			slowPort,
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "todo_count_items", arguments: {} },
			},
			sessionId
		).catch((error) => error);
		const deadline = Date.now() + 2_000;
		while (forwarded.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.strictEqual(forwarded.length, 1, "the call should be waiting on the host");

		const started = Date.now();
		await slow.stop();
		assert.ok(Date.now() - started < 1_000, `stop took ${Date.now() - started} ms`);
		await pendingCall;
	});

	test("invalid tool arguments are rejected in the worker, before reaching the host", async () => {
		const sessionId = await connect(port);
		const call = await rpc(
			port,
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "todo_list_items", arguments: { scope: "nowhere" } },
			},
			sessionId
		);
		const failed = call.body.error !== undefined || call.body.result?.isError === true;
		assert.ok(failed, `expected a validation error, got ${JSON.stringify(call.body)}`);
		assert.strictEqual(forwarded.length, 0);
	});
});

suite("McpServerHost worker thread", () => {
	let host: McpServerHost;
	let priv: {
		startWithConfig(config: McpConfig): Promise<void>;
		stopServer(): Promise<void>;
		enqueue<T>(task: () => Promise<T>): Promise<T>;
		lastPort: number | null;
		worker: Worker | null;
	};

	async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			if (Date.now() > deadline) {
				throw new Error("timed out waiting for the condition");
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	beforeEach(() => {
		const store = createStore() as EnhancedStore<StoreState>;
		host = new McpServerHost(createMockContext(), store, createMockStorage());
		priv = host as unknown as typeof priv;
	});

	afterEach(async function () {
		// A stop queues behind any start in flight, including a crash restart.
		this.timeout(10_000);
		await priv.stopServer();
		host.dispose();
	});

	test("answers initialize while the extension host thread is blocked", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		const port = priv.lastPort;
		assert.ok(port, "the worker should report the port it bound");
		assert.strictEqual(host.getStatus().running, true);

		// The client runs in its own thread, so it can talk to the server while this one spins.
		// It sleeps on shared memory until this thread says the spin has begun, so the request
		// is always sent during the block, however slow the machine.
		const signal = new Int32Array(new SharedArrayBuffer(4));
		const client = new Worker(
			`
			const { parentPort, workerData } = require("node:worker_threads");
			parentPort.postMessage({ ready: true });
			Atomics.wait(workerData.signal, 0, 0);
			const sentAt = Date.now();
			fetch("http://127.0.0.1:" + workerData.port + "/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify(workerData.body),
			})
				.then(async (res) => parentPort.postMessage({ sentAt, at: Date.now(), status: res.status, json: await res.json() }))
				.catch((error) => parentPort.postMessage({ error: String(error) }));
			`,
			{ eval: true, workerData: { port, body: INITIALIZE, signal } }
		);
		let resolveReply: (message: any) => void = () => undefined;
		const reply = new Promise<any>((resolve) => (resolveReply = resolve));
		await new Promise<void>((resolve) =>
			client.on("message", (message) => (message.ready ? resolve() : resolveReply(message)))
		);

		// Block this thread the way a misbehaving extension blocks the extension host.
		const blockedFrom = Date.now();
		const blockedUntil = blockedFrom + 3_000;
		Atomics.store(signal, 0, 1);
		Atomics.notify(signal, 0);
		while (Date.now() < blockedUntil) {
			// spin
		}

		const message = await reply;
		await client.terminate();
		assert.strictEqual(message.error, undefined, message.error);
		assert.strictEqual(message.status, 200);
		assert.strictEqual(message.json.result.serverInfo.name, SERVER_NAME);
		assert.ok(message.sentAt >= blockedFrom, "the request should be sent during the block");
		assert.ok(
			message.at < blockedUntil,
			"initialize should be answered while the extension host thread is still blocked"
		);
	});

	test("forwards tool calls and resource reads to the extension host", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		const port = priv.lastPort!;
		const sessionId = await connect(port);

		const call = await rpc(
			port,
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "todo_count_items", arguments: {} },
			},
			sessionId
		);
		const result = call.body.result;
		assert.notStrictEqual(result.isError, true, JSON.stringify(result));
		assert.strictEqual(result.structuredContent.user.todos, 0);
		assert.strictEqual(result.structuredContent.workspace.notes, 0);

		const read = await rpc(
			port,
			{ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "todo://user" } },
			sessionId
		);
		assert.deepStrictEqual(JSON.parse(read.body.result.contents[0].text), []);
	});

	test("stopping terminates the worker and frees the port", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		const port = priv.lastPort!;
		await priv.stopServer();
		assert.strictEqual(host.getStatus().running, false);
		await assert.rejects(rpc(port, INITIALIZE));
	});

	test("a port already in use fails the start and leaves the server stopped", async function () {
		this.timeout(20_000);
		const blocker = http.createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
		const address = blocker.address();
		const taken = typeof address === "object" && address ? address.port : 0;
		try {
			await priv.startWithConfig(makeConfig({ port: taken }));
			assert.strictEqual(host.getStatus().running, false);
			assert.strictEqual(priv.lastPort, null);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	test("a request target URL cannot parse gets 400 and leaves the server up", async function () {
		this.timeout(20_000);
		// A token is set: the request is rejected before auth, so any local process can send it.
		await priv.startWithConfig(makeConfig({ port: 0, token: "secret" }));
		const port = priv.lastPort!;
		const worker = priv.worker;

		// Node's HTTP parser accepts this target; `new URL` throws on it.
		const status = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(port, "127.0.0.1", () => {
				socket.write("GET http://a:b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
			});
			let response = "";
			socket.on("data", (chunk) => (response += chunk.toString()));
			socket.on("end", () => resolve(response.split("\r\n")[0]));
			socket.on("error", reject);
			socket.setTimeout(5_000, () => {
				socket.destroy();
				reject(new Error("the server never answered the request"));
			});
		});
		assert.match(status, /^HTTP\/1\.1 400/);

		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.strictEqual(priv.worker, worker, "the worker should still be the same one");
		const init = await rpc(port, INITIALIZE);
		assert.strictEqual(init.status, 401, "the server should still answer, and still want the token");
	});

	test("a crashed worker is restarted", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		const crashed = priv.worker!;
		await crashed.terminate();
		assert.strictEqual(host.getStatus().running, false);

		await waitFor(() => priv.worker !== null && priv.worker !== crashed, 10_000);
		assert.strictEqual(host.getStatus().running, true);
		await connect(priv.lastPort!);
	});

	test("a stop cancels a restart still waiting on its backoff", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		await priv.worker!.terminate();
		await priv.stopServer();

		// The first restart is due 1 s after the crash. Once past it, draining the queue waits
		// out any restart that did get queued, so a wrong restart cannot slip past the check.
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		await priv.enqueue(async () => undefined);
		assert.strictEqual(priv.worker, null);
		assert.strictEqual(host.getStatus().running, false);
	});

	test("a stop cancels a restart whose timer fired while the stop was queued", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		await priv.worker!.terminate();

		// Hold the queue past the 1 s restart: the stop is queued first, the restart behind it.
		const held = priv.enqueue(() => new Promise<void>((resolve) => setTimeout(resolve, 1_600)));
		const stopped = priv.stopServer();
		await Promise.all([held, stopped]);

		await priv.enqueue(async () => undefined);
		assert.strictEqual(priv.worker, null, "the restart should not undo the stop");
		assert.strictEqual(host.getStatus().running, false);
	});

	test("a restart does not override a disable queued ahead of it", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		await priv.worker!.terminate();

		// Hold the queue past the 1 s restart, so the restart timer fires while the disable
		// below is still waiting its turn.
		const held = priv.enqueue(() => new Promise<void>((resolve) => setTimeout(resolve, 1_600)));
		const disabled = priv.startWithConfig(makeConfig({ port: 0, enabled: false }));
		await Promise.all([held, disabled]);

		await priv.enqueue(async () => undefined);
		assert.strictEqual(priv.worker, null, "the restart should not bring the server back");
		assert.strictEqual(host.getStatus().running, false);
	});

	test("stopping answers a call still waiting on the host with a stopping error", async function () {
		this.timeout(20_000);
		await priv.startWithConfig(makeConfig({ port: 0 }));
		const port = priv.lastPort!;
		const sessionId = await connect(port);

		// Make this host never answer, as when another extension is blocking it.
		let reached = false;
		(host as unknown as { handleBridgeRequest(): Promise<unknown> }).handleBridgeRequest = () => {
			reached = true;
			return new Promise(() => undefined);
		};
		const pendingCall = rpc(
			port,
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "todo_set_completed", arguments: { scope: "user", id: 1, completed: true } },
			},
			sessionId
		);
		await waitFor(() => reached, 5_000);

		const started = Date.now();
		await priv.stopServer();
		const elapsed = Date.now() - started;
		// Under the 3 s stop timeout: the stop did not wait on the call.
		assert.ok(elapsed < 2_000, `stop took ${elapsed} ms`);

		const reply = await pendingCall;
		assert.strictEqual(reply.body.result.isError, true);
		assert.match(reply.body.result.content[0].text, /stopping/);
		assert.match(reply.body.result.content[0].text, /may still be applied/);
	});

	test("a token set while the worker is still starting is applied", async function () {
		this.timeout(20_000);
		// Not awaited in between: the second change lands before the first worker listens.
		const first = priv.startWithConfig(makeConfig({ port: 0 }));
		const second = priv.startWithConfig(makeConfig({ port: 0, token: "secret" }));
		await Promise.all([first, second]);

		const port = priv.lastPort!;
		assert.strictEqual((await rpc(port, INITIALIZE)).status, 401);
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: "Bearer secret",
			},
			body: JSON.stringify(INITIALIZE),
		});
		assert.strictEqual(res.status, 200);
	});

	test("enable, disable, enable in quick succession ends running", async function () {
		this.timeout(20_000);
		await Promise.all([
			priv.startWithConfig(makeConfig({ port: 0 })),
			priv.stopServer(),
			priv.startWithConfig(makeConfig({ port: 0 })),
		]);
		assert.strictEqual(host.getStatus().running, true);
		await connect(priv.lastPort!);
	});
});
