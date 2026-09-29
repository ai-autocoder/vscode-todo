import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, ReadResourceResult, Resource } from "@modelcontextprotocol/sdk/types.js";
import { BridgeClosedError, BridgeRequest, BridgeTimeoutError } from "./mcpBridge";
import {
	FILE_RESOURCE,
	SERVER_INSTRUCTIONS,
	SERVER_NAME,
	STATIC_RESOURCES,
	TOOL_DEFINITIONS,
	ToolDefinition,
} from "./mcpDefinitions";

/**
 * The MCP HTTP endpoint: listener, request gates, sessions, and the SDK server per session.
 *
 * It runs in a worker thread (see `mcpWorker.ts`), so it must never import `vscode`. The
 * handshake, `tools/list` and the resource list are answered here; tool calls and resource
 * reads go to the extension host through `call`, which rejects with a `BridgeTimeoutError`
 * when the host does not answer in time.
 */

export type McpHttpServerOptions = {
	host: string;
	port: number;
	token: string;
	version: string;
	/** Timeout for a forwarded tool call or resource read. */
	callTimeoutMs: number;
	/** Timeout for listing file resources; on expiry the list is empty rather than an error. */
	listTimeoutMs: number;
	call: (request: BridgeRequest, timeoutMs: number) => Promise<unknown>;
	log: (message: string) => void;
};

type McpSdk = {
	mcpServer: typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
	resourceTemplate: typeof import("@modelcontextprotocol/sdk/server/mcp.js").ResourceTemplate;
	streamableHttpServerTransport: typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
	isInitializeRequest: typeof import("@modelcontextprotocol/sdk/types.js").isInitializeRequest;
};

type SessionEntry = {
	transport: StreamableHTTPServerTransport;
	server: McpServer;
};

export default class McpHttpServer {
	// Cap concurrent sessions so a client that initializes repeatedly without a
	// clean DELETE cannot grow the map unbounded. When exceeded, the
	// least-recently-used session is evicted and its server closed.
	public static readonly MAX_SESSIONS = 50;
	private server: http.Server | null = null;
	private sessions = new Map<string, SessionEntry>();
	private sdk: McpSdk | null = null;
	private boundPort: number | null = null;

	constructor(private readonly options: McpHttpServerOptions) {}

	/** Starts listening and resolves with the bound port. */
	public async start(): Promise<number> {
		if (this.server && this.boundPort !== null) {
			return this.boundPort;
		}
		const sdk = await this.loadSdk();
		const server = http.createServer((req, res) => {
			// An unhandled rejection would end the worker, so a stray throw anywhere on the
			// request path — ours or the SDK's — becomes a 500 for that one request instead.
			this.handleRequest(req, res, sdk).catch((error) => {
				this.options.log(`[MCP] Request error: ${String(error)}`);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end("Internal Server Error");
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, this.options.host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		server.on("error", (error) => {
			this.options.log(`[MCP] Server error: ${String(error)}`);
		});
		this.server = server;
		const address = server.address();
		this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
		return this.boundPort;
	}

	public async stop(): Promise<void> {
		const server = this.server;
		if (!server) {
			return;
		}
		this.server = null;

		for (const entry of this.sessions.values()) {
			try {
				await entry.server.close();
			} catch (error) {
				this.options.log(`[MCP] Error closing session: ${String(error)}`);
			}
		}
		this.sessions.clear();

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			// close() waits for open connections, including a request whose response went to a
			// transport that has just closed and so will never be written; drop them instead.
			server.closeAllConnections();
		});
		this.boundPort = null;
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		sdk: McpSdk
	): Promise<void> {
		if (!req.url) {
			res.statusCode = 400;
			res.end("Missing URL");
			return;
		}

		// No workspace-trust check here: the extension host only starts this server in a
		// trusted workspace, and trust cannot be withdrawn without reloading the window, which
		// tears the server down with the extension host.

		if (!isOriginAllowed(req, this.options.port, this.boundPort)) {
			this.options.log(
				`[MCP] Rejected request with disallowed Origin: ${String(req.headers.origin)}`
			);
			res.statusCode = 403;
			res.end("Forbidden: disallowed Origin");
			return;
		}

		// Node's parser accepts request targets that URL rejects (e.g. "http://a:b"), and any
		// local process can send one before auth runs.
		let url: URL;
		try {
			url = new URL(req.url, `http://${this.options.host}`);
		} catch {
			res.statusCode = 400;
			res.end("Invalid URL");
			return;
		}
		if (url.pathname !== "/mcp") {
			res.statusCode = 404;
			res.end("Not Found");
			return;
		}

		if (!isAuthorized(req, this.options.token)) {
			res.statusCode = 401;
			res.end("Unauthorized");
			return;
		}

		const sessionId = getSessionId(req, url);
		try {
			if (req.method === "POST") {
				let body: unknown;
				try {
					body = await readBody(req);
				} catch (error) {
					res.statusCode = 400;
					res.end("Invalid JSON body");
					return;
				}
				if (sessionId) {
					const entry = this.touchSession(sessionId);
					if (entry) {
						await entry.transport.handleRequest(req, res, body);
						return;
					}
				}

				if (!sessionId && (sdk.isInitializeRequest(body) || isInitializeLikeRequest(body))) {
					if (!sdk.isInitializeRequest(body)) {
						this.options.log(
							"[MCP] Received non-standard initialize request; attempting to continue."
						);
					}
					await this.handleInitialize(req, res, body, sdk);
					return;
				}

				res.statusCode = 400;
				res.end("Invalid MCP request: missing session ID or initialize payload.");
				return;
			}

			if (req.method === "GET" || req.method === "DELETE") {
				const entry = sessionId ? this.touchSession(sessionId) : undefined;
				if (!entry) {
					res.statusCode = 400;
					res.end("Missing or invalid session ID");
					return;
				}
				await entry.transport.handleRequest(req, res);
				return;
			}

			res.statusCode = 405;
			res.end("Method Not Allowed");
		} catch (error) {
			this.options.log(`[MCP] Request error: ${String(error)}`);
			if (!res.headersSent) {
				res.statusCode = 500;
				res.end("Internal Server Error");
			}
		}
	}

	private async handleInitialize(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		body: unknown,
		sdk: McpSdk
	): Promise<void> {
		const mcpServer = this.createServerInstance(sdk);
		const transport = new sdk.streamableHttpServerTransport({
			sessionIdGenerator: () => randomUUID(),
			// Reply with a single JSON body rather than opening an SSE stream. This
			// local single-user server has no server-initiated notifications, so plain
			// JSON responses are lighter and simpler for tool-calling clients.
			enableJsonResponse: true,
			// The transport only assigns sessionId while handling the initialize
			// request, so onsessioninitialized is the single source of truth for
			// registering the session. Registering again after connect() would be
			// a no-op (sessionId is still undefined there).
			onsessioninitialized: (sessionId) => {
				this.registerSession(sessionId, { transport, server: mcpServer });
			},
		});

		transport.onclose = () => {
			const sessionId = transport.sessionId;
			if (sessionId && this.sessions.has(sessionId)) {
				this.sessions.delete(sessionId);
			}
		};
		transport.onerror = (error) => {
			this.options.log(`[MCP] Transport error: ${String(error)}`);
		};

		await mcpServer.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	// Register a session, evicting the least-recently-used one first when the cap
	// is reached. A Map iterates in insertion order, so the first key is the LRU
	// entry (touchSession re-inserts on use to keep that ordering accurate).
	private registerSession(sessionId: string, entry: SessionEntry): void {
		while (this.sessions.size >= McpHttpServer.MAX_SESSIONS) {
			const oldest = this.sessions.keys().next();
			if (oldest.done) {
				break;
			}
			this.evictSession(oldest.value);
		}
		this.sessions.set(sessionId, entry);
	}

	private touchSession(sessionId: string): SessionEntry | undefined {
		const entry = this.sessions.get(sessionId);
		if (entry) {
			this.sessions.delete(sessionId);
			this.sessions.set(sessionId, entry);
		}
		return entry;
	}

	private evictSession(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		if (!entry) {
			return;
		}
		this.options.log(
			`[MCP] Evicting idle session ${sessionId} (max ${McpHttpServer.MAX_SESSIONS}).`
		);
		void entry.server.close().catch((error) => {
			this.options.log(`[MCP] Error closing evicted session: ${String(error)}`);
		});
	}

	private createServerInstance(sdk: McpSdk): McpServer {
		const server = new sdk.mcpServer(
			{ name: SERVER_NAME, version: this.options.version },
			{ capabilities: { resources: {}, tools: {} }, instructions: SERVER_INSTRUCTIONS }
		);
		this.registerResources(server, sdk);
		for (const definition of TOOL_DEFINITIONS) {
			this.registerTool(server, definition);
		}
		return server;
	}

	private registerTool(server: McpServer, definition: ToolDefinition): void {
		server.registerTool(
			definition.name,
			{
				title: definition.title,
				description: definition.description,
				inputSchema: definition.inputSchema,
				outputSchema: definition.outputSchema,
				annotations: definition.annotations,
			},
			async (args: unknown) => this.forwardToolCall(definition, args)
		);
	}

	private async forwardToolCall(definition: ToolDefinition, args: unknown): Promise<CallToolResult> {
		try {
			return (await this.options.call(
				{ op: "tool", name: definition.name, args },
				this.options.callTimeoutMs
			)) as CallToolResult;
		} catch (error) {
			this.options.log(`[MCP] Tool ${definition.name} failed in the bridge: ${String(error)}`);
			let message =
				error instanceof BridgeTimeoutError
					? `${error.message} Another extension is probably keeping it busy; try again shortly.`
					: error instanceof BridgeClosedError
						? error.message
						: "The tool call failed due to an unexpected error.";
			// Either way the host was sent the call, so it may still run it.
			const reachedHost = error instanceof BridgeTimeoutError || error instanceof BridgeClosedError;
			if (reachedHost && definition.mutates) {
				message +=
					" The change may still be applied once the extension host catches up, so list " +
					"the items before retrying.";
			}
			return { isError: true, content: [{ type: "text", text: message }] };
		}
	}

	private registerResources(server: McpServer, sdk: McpSdk): void {
		for (const resource of STATIC_RESOURCES) {
			server.registerResource(
				resource.name,
				resource.uri,
				{
					title: resource.title,
					description: resource.description,
					mimeType: "application/json",
				},
				async () =>
					(await this.options.call(
						{ op: "resource", name: resource.name, uri: resource.uri },
						this.options.callTimeoutMs
					)) as ReadResourceResult
			);
		}

		const fileTemplate = new sdk.resourceTemplate(FILE_RESOURCE.uriTemplate, {
			// resources/list includes this, and a client may list resources while it connects.
			// A stalled host must not fail the whole list, so it gets a short timeout and an
			// empty answer instead of an error.
			list: async () => {
				try {
					const resources = (await this.options.call(
						{ op: "listFileResources" },
						this.options.listTimeoutMs
					)) as Resource[];
					return { resources };
				} catch (error) {
					this.options.log(`[MCP] Listing file resources failed: ${String(error)}`);
					return { resources: [] };
				}
			},
		});
		server.registerResource(
			FILE_RESOURCE.name,
			fileTemplate,
			{
				title: FILE_RESOURCE.title,
				description: FILE_RESOURCE.description,
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const rawPath = uri.searchParams.get("path") ?? variables.path;
				const filePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
				if (!filePath) {
					throw new Error("Missing file path.");
				}
				return (await this.options.call(
					{ op: "fileResource", uri: uri.toString(), filePath },
					this.options.callTimeoutMs
				)) as ReadResourceResult;
			}
		);
	}

	private async loadSdk(): Promise<McpSdk> {
		if (this.sdk) {
			return this.sdk;
		}
		const [mcpModule, transportModule, typesModule] = await Promise.all([
			import("@modelcontextprotocol/sdk/server/mcp.js"),
			import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
			import("@modelcontextprotocol/sdk/types.js"),
		]);
		this.sdk = {
			mcpServer: mcpModule.McpServer,
			resourceTemplate: mcpModule.ResourceTemplate,
			streamableHttpServerTransport: transportModule.StreamableHTTPServerTransport,
			isInitializeRequest: typesModule.isInitializeRequest,
		};
		return this.sdk;
	}
}

export function isOriginAllowed(
	req: http.IncomingMessage,
	configuredPort: number,
	boundPort: number | null
): boolean {
	const originValue = req.headers.origin;
	const origin = Array.isArray(originValue) ? originValue[0] : originValue;

	// Non-browser MCP clients (CLI agents, the SDK) typically send no Origin
	// header. Only browser contexts set it, so absence is treated as trusted.
	if (!origin) {
		return true;
	}

	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}

	// Guard against DNS-rebinding: only loopback origins may reach the server.
	const hostname = parsed.hostname.toLowerCase();
	const isLoopbackHost =
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1";
	if (!isLoopbackHost) {
		return false;
	}

	// When bound to a fixed port, require the origin to target it (or be portless).
	if (configuredPort && parsed.port) {
		return (
			parsed.port === String(configuredPort) ||
			parsed.port === String(boundPort ?? configuredPort)
		);
	}

	return true;
}

export function isAuthorized(req: http.IncomingMessage, token: string): boolean {
	if (!token) {
		return true;
	}
	const authHeaderValue = req.headers.authorization;
	const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;
	const match = (authHeader ?? "").match(/^Bearer\s+(.+)$/i);
	if (!match) {
		return false;
	}
	return tokensEqual(match[1].trim(), token.trim());
}

// Constant-time comparison to avoid leaking the token via response timing.
function tokensEqual(provided: string, expected: string): boolean {
	const providedBuf = Buffer.from(provided, "utf8");
	const expectedBuf = Buffer.from(expected, "utf8");
	// timingSafeEqual requires equal-length buffers; differing lengths mean a
	// mismatch, but still run a same-length compare so timing does not reveal it.
	if (providedBuf.length !== expectedBuf.length) {
		timingSafeEqual(expectedBuf, expectedBuf);
		return false;
	}
	return timingSafeEqual(providedBuf, expectedBuf);
}

export function getSessionId(req: http.IncomingMessage, url?: URL): string | undefined {
	const querySessionId =
		url?.searchParams.get("mcp-session-id") ??
		url?.searchParams.get("mcpSessionId") ??
		url?.searchParams.get("sessionId");
	if (querySessionId) {
		return querySessionId;
	}
	const header = req.headers["mcp-session-id"];
	if (Array.isArray(header)) {
		return header[0];
	}
	return header;
}

export function isInitializeLikeRequest(body: unknown): boolean {
	if (!body) {
		return false;
	}
	if (Array.isArray(body)) {
		return body.some((entry) => isInitializeLikeRequest(entry));
	}
	if (typeof body !== "object") {
		return false;
	}
	const method = (body as { method?: unknown }).method;
	return typeof method === "string" && method.toLowerCase() === "initialize";
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (chunks.length === 0) {
		return undefined;
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) {
		return undefined;
	}
	return JSON.parse(raw);
}
