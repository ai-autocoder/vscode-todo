import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import * as vscode from "vscode";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { TodoScope } from "../todo/todoTypes";
import TodoService, { PaginatedResult } from "../todo/TodoService";
import McpLogChannel from "./McpLogChannel";
import StorageSyncManager from "../storage/StorageSyncManager";
import { EnhancedStore } from "@reduxjs/toolkit";
import { StoreState } from "../todo/todoTypes";
import * as path from "node:path";
import { McpStatus } from "./mcpStatus";

type McpConfig = {
	enabled: boolean;
	readOnly: boolean;
	allowedScopes: Array<"user" | "workspace" | "file">;
	transport: "streamableHttp";
	port: number;
	token: string;
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

export default class McpServerHost implements vscode.Disposable {
	// Cap concurrent sessions so a client that initializes repeatedly without a
	// clean DELETE cannot grow the map unbounded. When exceeded, the
	// least-recently-used session is evicted and its server closed.
	private static readonly MAX_SESSIONS = 50;
	// Upper bound on the serialized text block of a tool/resource response. Set
	// very high so realistic payloads (including long Markdown notes) pass
	// untouched; it only guards against a pathological scope flooding the client.
	private static readonly CHARACTER_LIMIT = 2_000_000;
	// Default per-page character budget for todo_list_items. Keeps a single page
	// comfortably ingestible by an agent even when items are large; callers can
	// override via the maxChars parameter. The page is trimmed to whole items, so a
	// page may return fewer than `limit` items with has_more=true. The budget is
	// measured on compact per-item JSON, so the pretty-printed, enveloped response is
	// somewhat larger; CHARACTER_LIMIT remains the final backstop on that payload.
	private static readonly LIST_ITEMS_MAX_CHARS = 100_000;
	private readonly host = "127.0.0.1";
	private server: http.Server | null = null;
	private sessions = new Map<string, SessionEntry>();
	private config: McpConfig | null = null;
	private sdk: McpSdk | null = null;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly todoService: TodoService;
	private readonly statusEmitter = new vscode.EventEmitter<McpStatus>();
	private status: McpStatus;
	private lastPort: number | null = null;

	public readonly onDidChangeStatus = this.statusEmitter.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		store: EnhancedStore<StoreState>,
		storageSyncManager: StorageSyncManager
	) {
		this.todoService = new TodoService(context, store, storageSyncManager);
		this.status = this.buildStatus(this.readConfig(), false, null);
	}

	public initialize(): void {
		void this.applyConfig();
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("vscodeTodo.mcp")) {
					void this.applyConfig();
				}
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				void this.applyConfig();
			})
		);
	}

	public async start(): Promise<void> {
		await this.applyConfig();
	}

	public async stop(): Promise<void> {
		await this.stopServer();
	}

	public getStatus(): McpStatus {
		this.refreshStatus();
		return this.status;
	}

	public dispose(): void {
		void this.stopServer();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		this.statusEmitter.dispose();
	}

	private async applyConfig(): Promise<void> {
		const previous = this.config;
		const config = this.readConfig();
		this.todoService.updateAccess(config.readOnly, config.allowedScopes);

		if (!config.enabled || !vscode.workspace.isTrusted) {
			this.config = config;
			await this.stopServer();
			this.refreshStatus();
			return;
		}

		if (!this.server) {
			this.config = config;
			await this.startWithConfig(config);
			this.refreshStatus();
			return;
		}

		if (
			previous &&
			(previous.port !== config.port ||
				previous.token !== config.token ||
				previous.transport !== config.transport)
		) {
			this.config = config;
			await this.stopServer();
			await this.startWithConfig(config);
			this.refreshStatus();
			return;
		}

		this.config = config;
		this.refreshStatus();
	}

	private readConfig(): McpConfig {
		const config = vscode.workspace.getConfiguration("vscodeTodo.mcp");
		const allowedScopes = config.get<Array<"user" | "workspace" | "file">>("allowedScopes", [
			"user",
			"workspace",
			"file",
		]);
		const portRaw = config.get<number>("port", 7337);
		const port = Number.isFinite(portRaw) && portRaw >= 0 && portRaw <= 65535 ? portRaw : 7337;
		const transport = config.get<"streamableHttp">("transport", "streamableHttp");
		return {
			enabled: config.get<boolean>("enabled", false),
			readOnly: config.get<boolean>("readOnly", true),
			allowedScopes,
			transport,
			port,
			token: config.get<string>("token", ""),
		};
	}

	private async startWithConfig(config: McpConfig): Promise<void> {
		if (this.server) {
			return;
		}
		this.lastPort = null;

		if (!this.isNodeVersionSupported()) {
			vscode.window.showWarningMessage("MCP server requires Node.js 18+.");
			McpLogChannel.log("[MCP] Node.js 18+ is required to start the MCP server.");
			return;
		}

		if (config.transport !== "streamableHttp") {
			vscode.window.showWarningMessage("Unsupported MCP transport. Use streamableHttp.");
			return;
		}

		const sdk = await this.loadSdk();
		this.server = http.createServer((req, res) => {
			void this.handleRequest(req, res, sdk, config);
		});

		try {
			await new Promise<void>((resolve, reject) => {
				this.server?.once("error", reject);
				this.server?.listen(config.port, this.host, () => resolve());
			});
		} catch (error) {
			this.notifyServerStartFailed(error);
			this.server = null;
			return;
		}

		const address = this.server.address();
		const port = typeof address === "object" && address ? address.port : config.port;
		this.lastPort = typeof port === "number" ? port : null;
		this.config = config;
		this.notifyServerStarted(port);
	}

	private async stopServer(): Promise<void> {
		if (!this.server) {
			return;
		}

		for (const entry of this.sessions.values()) {
			try {
				await entry.server.close();
			} catch (error) {
				McpLogChannel.log(`[MCP] Error closing session: ${String(error)}`);
			}
		}
		this.sessions.clear();

		await new Promise<void>((resolve) => {
			this.server?.close(() => resolve());
		});
		this.server = null;
		this.lastPort = null;
		this.notifyServerStopped();
		this.refreshStatus();
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		sdk: McpSdk,
		config: McpConfig
	): Promise<void> {
		if (!req.url) {
			res.statusCode = 400;
			res.end("Missing URL");
			return;
		}

		if (!vscode.workspace.isTrusted) {
			res.statusCode = 403;
			res.end("Workspace not trusted");
			return;
		}

		if (!this.isOriginAllowed(req, config)) {
			McpLogChannel.log(
				`[MCP] Rejected request with disallowed Origin: ${String(req.headers.origin)}`
			);
			res.statusCode = 403;
			res.end("Forbidden: disallowed Origin");
			return;
		}

		const url = new URL(req.url, `http://${this.host}`);
		if (url.pathname !== "/mcp") {
			res.statusCode = 404;
			res.end("Not Found");
			return;
		}

		if (!this.isAuthorized(req, config)) {
			res.statusCode = 401;
			res.end("Unauthorized");
			return;
		}

		const sessionId = this.getSessionId(req, url);
		try {
			if (req.method === "POST") {
				let body: unknown;
				try {
					body = await this.readBody(req);
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

				if (!sessionId && (sdk.isInitializeRequest(body) || this.isInitializeLikeRequest(body))) {
					if (!sdk.isInitializeRequest(body)) {
						McpLogChannel.log("[MCP] Received non-standard initialize request; attempting to continue.");
					}
					await this.handleInitialize(req, res, body, sdk);
					return;
				}

				res.statusCode = 400;
				res.end("Invalid MCP request: missing session ID or initialize payload.");
				return;
			}

			if (req.method === "GET") {
				const entry = sessionId ? this.touchSession(sessionId) : undefined;
				if (!entry) {
					res.statusCode = 400;
					res.end("Missing or invalid session ID");
					return;
				}
				await entry.transport.handleRequest(req, res);
				return;
			}

			if (req.method === "DELETE") {
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
			McpLogChannel.log(`[MCP] Request error: ${String(error)}`);
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
			McpLogChannel.log(`[MCP] Transport error: ${String(error)}`);
		};

		await mcpServer.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	// Register a session, evicting the least-recently-used one first when the cap
	// is reached. A Map iterates in insertion order, so the first key is the LRU
	// entry (touchSession re-inserts on use to keep that ordering accurate).
	private registerSession(sessionId: string, entry: SessionEntry): void {
		while (this.sessions.size >= McpServerHost.MAX_SESSIONS) {
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
		McpLogChannel.log(`[MCP] Evicting idle session ${sessionId} (max ${McpServerHost.MAX_SESSIONS}).`);
		void entry.server.close().catch((error) => {
			McpLogChannel.log(`[MCP] Error closing evicted session: ${String(error)}`);
		});
	}

	private createServerInstance(sdk: McpSdk): McpServer {
		const server = new sdk.mcpServer(
			{
				name: "vscode-todo-mcp",
				version: this.context.extension.packageJSON.version ?? "0.0.0",
			},
			{
				capabilities: { resources: {}, tools: {} },
				instructions:
					"Use the todo_* tools to read, create, update, and delete VS Code Todo items and notes " +
					"across the user, workspace, and currentFile scopes. todo_list_items reads todos/notes for " +
					"a scope, todo_count_items returns per-scope counts for a quick overview, and " +
					"todo_list_files lists files that have todos. todo_add_item creates an item; " +
					"todo_update_text, todo_set_completed, todo_set_note, and todo_set_markdown change an " +
					"existing item by id; todo_delete_items removes items by id. All write tools are blocked " +
					"when the server is in read-only mode. For the currentFile scope, pass filePath to target " +
					"a specific file (it need not be open in the editor). The todo:// resources expose " +
					"read-only snapshots of the same data.",
			}
		);

		this.registerResources(server, sdk);
		this.registerTools(server);

		return server;
	}

	private registerResources(server: McpServer, sdk: McpSdk): void {
		server.registerResource(
			"user-todos",
			"todo://user",
			{
				title: "User Todos",
				description: "User-scope todos and notes",
				mimeType: "application/json",
			},
			async () => {
				const data = this.todoService.listTodos(TodoScope.user);
				return this.toResourceResult("todo://user", data.todos);
			}
		);

		server.registerResource(
			"workspace-todos",
			"todo://workspace",
			{
				title: "Workspace Todos",
				description: "Workspace-scope todos and notes",
				mimeType: "application/json",
			},
			async () => {
				const data = this.todoService.listTodos(TodoScope.workspace);
				return this.toResourceResult("todo://workspace", data.todos);
			}
		);

		server.registerResource(
			"todo-counts",
			"todo://counts",
			{
				title: "Todo Counts",
				description: "Todo and note counts by scope",
				mimeType: "application/json",
			},
			async () => {
				return this.toResourceResult("todo://counts", this.todoService.getCounts());
			}
		);

		server.registerResource(
			"todo-files",
			"todo://files",
			{
				title: "Files with Todos",
				description: "List of files that have todos",
				mimeType: "application/json",
			},
			async () => {
				return this.toResourceResult("todo://files", this.todoService.listFiles());
			}
		);

		const fileTemplate = new sdk.resourceTemplate("todo://file?path={path}", {
			list: async () => {
				return { resources: this.buildFileResources("todo://file") };
			},
		});
		server.registerResource(
			"file-todos",
			fileTemplate,
			{
				title: "File Todos",
				description: "File-scoped todos and notes",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const rawPath = uri.searchParams.get("path") ?? variables.path;
				const filePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
				if (!filePath) {
					throw new Error("Missing file path.");
				}
				const data = this.todoService.listTodos(TodoScope.currentFile, { filePath });
				return this.toResourceResult(uri.toString(), data.todos);
			}
		);
	}

	private registerTools(server: McpServer): void {
		const scopeSchema = z
			.enum(["user", "workspace", "currentFile"])
			.describe(
				"Which todo list to target: 'user' (global, shared across all projects), " +
					"'workspace' (the current project/folder), or 'currentFile' (a specific file — " +
					"requires filePath)."
			);

		const limitSchema = z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Maximum number of items to return. Defaults to 50, capped at 500.");
		const offsetSchema = z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				"Number of items to skip from the start, for paging. Defaults to 0. Use the " +
					"next_offset from a previous response to fetch the next page."
			);
		const maxCharsSchema = z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"Optional cap on the serialized size of a page, in characters. The page is " +
					"trimmed to whole items to stay under this budget, so it may return fewer than " +
					"the requested limit with has_more true. Defaults to a sane limit; item text is " +
					"never truncated."
			);

		const todoShape = {
			id: z.number().describe("Stable numeric identifier of the item within its scope."),
			text: z.string().describe("The todo or note text."),
			completed: z.boolean().describe("Whether the item is marked done. Always false for notes."),
			creationDate: z.string().describe("ISO 8601 timestamp of when the item was created."),
			completionDate: z
				.string()
				.optional()
				.describe("ISO 8601 timestamp of when the item was completed, if completed."),
			isMarkdown: z.boolean().describe("Whether the text is rendered as Markdown in the UI."),
			isNote: z
				.boolean()
				.describe("True for a free-text note, false for a checkable task."),
			collapsed: z
				.boolean()
				.optional()
				.describe("Whether the item is collapsed in the UI."),
		};
		const todoSchema = z.object(todoShape);

		const listItemsOutputSchema = {
			scope: scopeSchema,
			filePath: z
				.string()
				.optional()
				.describe("Resolved file path when scope is 'currentFile'."),
			todos: z.array(todoSchema).describe("The page of todos/notes for this scope."),
			total: z.number().describe("Total number of items matching the query across all pages."),
			count: z.number().describe("Number of items returned in this page."),
			has_more: z.boolean().describe("True when more items remain beyond this page."),
			next_offset: z
				.number()
				.optional()
				.describe("Offset to pass on the next call to fetch the following page, when has_more is true."),
		};

		const fileEntrySchema = z.object({
			filePath: z.string().describe("Path of a file that has todos."),
			todoNumber: z.number().describe("Number of todos recorded against that file."),
		});
		const listFilesOutputSchema = {
			files: z.array(fileEntrySchema).describe("The page of files that have todos."),
			total: z.number().describe("Total number of files with todos across all pages."),
			count: z.number().describe("Number of files returned in this page."),
			has_more: z.boolean().describe("True when more files remain beyond this page."),
			next_offset: z
				.number()
				.optional()
				.describe("Offset to pass on the next call to fetch the following page, when has_more is true."),
		};

		const addItemOutputSchema = {
			scope: scopeSchema,
			filePath: z
				.string()
				.optional()
				.describe("Resolved file path when the item was added to a 'currentFile' scope."),
			todo: todoSchema.describe("The newly created todo or note."),
		};

		// Per-scope count objects are "loose" (extra keys allowed) so future, more
		// granular counts (e.g. a per-tag breakdown) can be added without a breaking
		// schema change. z.looseObject is the Zod 4 idiom for the old .passthrough().
		const scopeCountsSchema = z.looseObject({
			todos: z.number().describe("Number of checkable tasks in the scope."),
			notes: z.number().describe("Number of free-text notes in the scope."),
		});
		const fileCountsSchema = z.looseObject({
			todos: z.number().describe("Number of checkable tasks for the current file."),
			notes: z.number().describe("Number of free-text notes for the current file."),
			filePath: z.string().describe("Path of the current file these counts apply to."),
		});
		const countItemsOutputSchema = {
			user: scopeCountsSchema.optional().describe("Counts for the user scope, if allowed."),
			workspace: scopeCountsSchema
				.optional()
				.describe("Counts for the workspace scope, if allowed."),
			currentFile: fileCountsSchema
				.optional()
				.describe("Counts for the current file scope, if allowed."),
		};

		const idSchema = z
			.number()
			.int()
			.describe("Numeric id of the target item (from a previous todo_list_items result).");
		const mutateFilePathSchema = z
			.string()
			.optional()
			.describe(
				"Absolute or workspace-relative path; required when scope is 'currentFile', otherwise ignored."
			);

		// Shared by the four single-item mutators (update text, set completed/note/markdown).
		const itemOutputSchema = {
			scope: scopeSchema,
			filePath: z
				.string()
				.optional()
				.describe("Resolved file path when scope is 'currentFile'."),
			todo: todoSchema.describe("The item after the change."),
		};

		const deleteOutputSchema = {
			scope: scopeSchema,
			filePath: z
				.string()
				.optional()
				.describe("Resolved file path when scope is 'currentFile'."),
			deleted: z.array(todoSchema).describe("The items that were deleted."),
			count: z.number().describe("Number of items deleted (0 if no id matched)."),
		};

		const mutateAnnotations = {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		};

		server.registerTool(
			"todo_list_items",
			{
				title: "List Todos",
				description:
					"List todos and notes for a scope. 'scope' is one of 'user' (global), " +
					"'workspace' (current project), or 'currentFile' (a specific file — requires " +
					"'filePath'). Optionally filter by 'kind' ('task', 'note', or 'all'), by " +
					"'completed' (true=done, false=open), or to items whose text starts with " +
					"'textPrefix'. Results are paginated: pass 'limit' (default 50, " +
					"max 500) and 'offset', and read 'total' / 'has_more' / 'next_offset' from the result. " +
					"To stay within an agent's context budget, a page is also trimmed to a character " +
					"limit, so it may return fewer than 'limit' items with 'has_more' true — follow " +
					"'next_offset' to fetch the rest. Item text is always returned in full, never truncated.",
				inputSchema: {
					scope: scopeSchema,
					filePath: z
						.string()
						.optional()
						.describe(
							"Absolute or workspace-relative path; required when scope is 'currentFile', " +
								"otherwise ignored."
						),
					kind: z
						.enum(["task", "note", "all"])
						.optional()
						.describe(
							"Restrict to 'task' (checkable items), 'note' (free-text notes), or 'all'. " +
								"Defaults to 'all'."
						),
					completed: z
						.boolean()
						.optional()
						.describe(
							"Filter by completion: true for done items, false for open items. Omit to " +
								"return both. Notes are never completed."
						),
					textPrefix: z
						.string()
						.optional()
						.describe("When set, return only items whose text begins with this prefix (case-insensitive)."),
					limit: limitSchema,
					offset: offsetSchema,
					maxChars: maxCharsSchema,
				},
				outputSchema: listItemsOutputSchema,
				annotations: { title: "List Todos", readOnlyHint: true, openWorldHint: false },
			},
			async (args) => {
				return this.safeToolCall(() => {
					const { scope, limit, offset, maxChars, ...filters } = args;
					const data = this.todoService.listTodosPaginated(scope as TodoScope, filters, {
						limit,
						offset,
						maxChars: maxChars ?? McpServerHost.LIST_ITEMS_MAX_CHARS,
					});
					return this.toolResult({
						scope,
						...(data.filePath !== undefined ? { filePath: data.filePath } : {}),
						todos: data.items,
						...this.paginationFields(data),
					});
				});
			}
		);

		server.registerTool(
			"todo_count_items",
			{
				title: "Count Todos",
				description:
					"Return todo and note counts per scope (user, workspace, currentFile) without " +
					"fetching the items themselves. Use this for a cheap overview — 'is there " +
					"outstanding work, and where?' — before paging through a scope with " +
					"todo_list_items. A scope is omitted when it is not allowed or unavailable " +
					"(e.g. currentFile with no file, or a scope excluded by allowedScopes).",
				inputSchema: {},
				outputSchema: countItemsOutputSchema,
				annotations: { title: "Count Todos", readOnlyHint: true, openWorldHint: false },
			},
			async () => {
				return this.safeToolCall(() => this.toolResult(this.todoService.getCounts()));
			}
		);

		server.registerTool(
			"todo_add_item",
			{
				title: "Add Todo",
				description:
					"Create a new todo or note in the given scope. 'scope' is one of 'user' (global), " +
					"'workspace' (current project), or 'currentFile' (a specific file — requires " +
					"'filePath'). Set 'isNote: true' for a free-text note instead of a checkable task. " +
					"Set 'isMarkdown: true' to render the text as Markdown. Returns the created item. " +
					"Rejected when the server is in read-only mode.",
				inputSchema: {
					scope: scopeSchema,
					text: z.string().describe("The text of the todo or note to create."),
					isNote: z
						.boolean()
						.optional()
						.describe("When true, create a free-text note instead of a checkable task. Defaults to false."),
					isMarkdown: z
						.boolean()
						.optional()
						.describe(
							"When true, the text is rendered as Markdown in the UI. Defaults to the " +
								"extension's createMarkdownByDefault setting."
						),
					filePath: z
						.string()
						.optional()
						.describe(
							"Absolute or workspace-relative path; required when scope is 'currentFile', " +
								"otherwise ignored."
						),
				},
				outputSchema: addItemOutputSchema,
				annotations: {
					title: "Add Todo",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.addTodo(args.scope as TodoScope, args.text, args);
					if (!result) {
						throw new Error("Failed to create the todo: it was not added to the store.");
					}
					return this.toolResult({
						scope: result.scope,
						...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
						todo: result.todo,
					});
				});
			}
		);

		server.registerTool(
			"todo_list_files",
			{
				title: "List Files with Todos",
				description:
					"List files in the current workspace that have file-scoped todos, with the count " +
					"of todos per file. Results are paginated: pass 'limit' (default 50, max 500) and " +
					"'offset', and read 'total' / 'has_more' / 'next_offset' from the result. Requires " +
					"an open workspace folder.",
				inputSchema: {
					limit: limitSchema,
					offset: offsetSchema,
				},
				outputSchema: listFilesOutputSchema,
				annotations: { title: "List Files with Todos", readOnlyHint: true, openWorldHint: false },
			},
			async (args) => {
				return this.safeToolCall(() => {
					const data = this.todoService.listFilesPaginated({
						limit: args?.limit,
						offset: args?.offset,
					});
					return this.toolResult({
						files: data.items,
						...this.paginationFields(data),
					});
				});
			}
		);

		server.registerTool(
			"todo_update_text",
			{
				title: "Update Todo Text",
				description:
					"Change the text of an existing todo or note. Identify the item by 'scope' and " +
					"numeric 'id' (use todo_list_items to find ids); for 'currentFile' scope also pass " +
					"'filePath'. Returns the updated item. Rejected when the server is in read-only mode.",
				inputSchema: {
					scope: scopeSchema,
					id: idSchema,
					newText: z.string().describe("The new text for the item."),
					filePath: mutateFilePathSchema,
				},
				outputSchema: itemOutputSchema,
				annotations: { title: "Update Todo Text", ...mutateAnnotations },
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.updateTodoText(
						args.scope as TodoScope,
						args.id,
						args.newText,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				});
			}
		);

		server.registerTool(
			"todo_set_completed",
			{
				title: "Set Todo Completed",
				description:
					"Mark a todo as completed or not completed. Identify the item by 'scope' and numeric " +
					"'id'; for 'currentFile' scope also pass 'filePath'. Set 'completed: true' to complete " +
					"(records a completion date) or 'false' to reopen it. Idempotent — setting the value it " +
					"already has is a no-op. Notes have no completion state. Returns the updated item. " +
					"Rejected when the server is in read-only mode.",
				inputSchema: {
					scope: scopeSchema,
					id: idSchema,
					completed: z.boolean().describe("Target completion state: true to complete, false to reopen."),
					filePath: mutateFilePathSchema,
				},
				outputSchema: itemOutputSchema,
				annotations: { title: "Set Todo Completed", ...mutateAnnotations },
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.setCompleted(
						args.scope as TodoScope,
						args.id,
						args.completed,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				});
			}
		);

		server.registerTool(
			"todo_set_note",
			{
				title: "Set Todo Note Flag",
				description:
					"Convert an item between a checkable task and a free-text note. Identify the item by " +
					"'scope' and numeric 'id'; for 'currentFile' scope also pass 'filePath'. Set " +
					"'isNote: true' to make it a note, 'false' to make it a task. Idempotent. Returns the " +
					"updated item. Rejected when the server is in read-only mode.",
				inputSchema: {
					scope: scopeSchema,
					id: idSchema,
					isNote: z.boolean().describe("True to make the item a note, false to make it a task."),
					filePath: mutateFilePathSchema,
				},
				outputSchema: itemOutputSchema,
				annotations: { title: "Set Todo Note Flag", ...mutateAnnotations },
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.setNote(
						args.scope as TodoScope,
						args.id,
						args.isNote,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				});
			}
		);

		server.registerTool(
			"todo_set_markdown",
			{
				title: "Set Todo Markdown Flag",
				description:
					"Toggle whether an item's text is rendered as Markdown in the UI. Identify the item by " +
					"'scope' and numeric 'id'; for 'currentFile' scope also pass 'filePath'. Set " +
					"'isMarkdown: true' to enable Markdown rendering, 'false' to show plain text. Idempotent. " +
					"Returns the updated item. Rejected when the server is in read-only mode.",
				inputSchema: {
					scope: scopeSchema,
					id: idSchema,
					isMarkdown: z.boolean().describe("True to render as Markdown, false for plain text."),
					filePath: mutateFilePathSchema,
				},
				outputSchema: itemOutputSchema,
				annotations: { title: "Set Todo Markdown Flag", ...mutateAnnotations },
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.setMarkdown(
						args.scope as TodoScope,
						args.id,
						args.isMarkdown,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				});
			}
		);

		server.registerTool(
			"todo_delete_items",
			{
				title: "Delete Todos",
				description:
					"Delete one or more todos or notes from a scope. Identify items by 'scope' and an array " +
					"of numeric 'ids' (use todo_list_items to find them); for 'currentFile' scope also pass " +
					"'filePath'. Ids that do not match any item are ignored. Returns the deleted items and a " +
					"'count'. This permanently removes the items. Rejected when the server is in read-only mode.",
				inputSchema: {
					scope: scopeSchema,
					ids: z
						.array(z.number().int())
						.min(1)
						.describe("Numeric ids of the items to delete. Must contain at least one id."),
					filePath: mutateFilePathSchema,
				},
				outputSchema: deleteOutputSchema,
				annotations: {
					title: "Delete Todos",
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.deleteTodos(args.scope as TodoScope, args.ids, {
						filePath: args.filePath,
					});
					return this.toolResult({
						scope: result.scope,
						...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
						deleted: result.deleted,
						count: result.count,
					});
				});
			}
		);
	}

	private itemResult(result: { scope: TodoScope; filePath?: string; todo: unknown }): {
		scope: TodoScope;
		filePath?: string;
		todo: unknown;
	} {
		return {
			scope: result.scope,
			...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
			todo: result.todo,
		};
	}

	private paginationFields(result: PaginatedResult<unknown>): {
		total: number;
		count: number;
		has_more: boolean;
		next_offset?: number;
	} {
		return {
			total: result.total,
			count: result.count,
			has_more: result.hasMore,
			...(result.nextOffset !== undefined ? { next_offset: result.nextOffset } : {}),
		};
	}

	private buildFileResources(prefix: string): Resource[] {
		try {
			const files = this.todoService.listFiles();
			const separator = prefix.includes("?") ? "&" : "?";
			return files.map((entry) => {
				const encoded = encodeURIComponent(entry.filePath);
				const uri = `${prefix}${separator}path=${encoded}`;
				return {
					uri,
					name: path.basename(entry.filePath),
					description: entry.filePath,
					mimeType: "application/json",
				};
			});
		} catch (error) {
			return [];
		}
	}

	private toResourceResult(uri: string, data: unknown) {
		const serialized = JSON.stringify(data, null, 2);
		// Resources have no structured fallback, so cap the text and append a notice
		// (as valid JSON) rather than streaming an unbounded blob to the client.
		const text =
			serialized.length > McpServerHost.CHARACTER_LIMIT
				? JSON.stringify(
						{
							truncated: true,
							character_limit: McpServerHost.CHARACTER_LIMIT,
							original_length: serialized.length,
							message:
								"Resource payload exceeded the character limit and was omitted. Use the " +
								"todo_list_items tool with limit/offset to page through this scope instead.",
						},
						null,
						2
					)
				: serialized;
		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text,
				},
			],
		};
	}

	private toolResult(data: unknown) {
		const serialized = JSON.stringify(data ?? null, null, 2);
		const isStructured = Boolean(data) && typeof data === "object" && !Array.isArray(data);
		// The text block is the human/unstructured fallback; structuredContent carries
		// the schema-typed payload. When the text would exceed the limit, replace just
		// the text with a pointer to structuredContent so the response stays bounded
		// without breaking the declared outputSchema.
		const text =
			serialized.length > McpServerHost.CHARACTER_LIMIT
				? JSON.stringify(
						{
							truncated: true,
							character_limit: McpServerHost.CHARACTER_LIMIT,
							original_length: serialized.length,
							message: isStructured
								? "Result text omitted because it exceeded the character limit; read the " +
									"full payload from structuredContent, or use limit/offset to request a " +
									"smaller page."
								: "Result omitted because it exceeded the character limit. Use limit/offset " +
									"to request a smaller page.",
						},
						null,
						2
					)
				: serialized;
		const result: {
			content: Array<{ type: "text"; text: string }>;
			structuredContent?: Record<string, unknown>;
		} = {
			content: [
				{
					type: "text",
					text,
				},
			],
		};
		// Mirror the payload as structuredContent so clients with the declared
		// outputSchema can parse results without re-parsing the text block.
		if (isStructured) {
			result.structuredContent = data as Record<string, unknown>;
		}
		return result;
	}

	private async safeToolCall(handler: () => Promise<any> | any) {
		try {
			return await handler();
		} catch (error) {
			// Full detail (including any stack) goes to the log; the client only sees
			// the curated Error.message, or a generic message for non-Error throws so
			// internal objects never leak across the MCP boundary.
			McpLogChannel.log(`[MCP] Tool error: ${String(error)}`);
			if (error instanceof Error && error.stack) {
				McpLogChannel.log(error.stack);
			}
			const message =
				error instanceof Error && error.message.trim()
					? error.message
					: "The tool call failed due to an unexpected error.";
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: message,
					},
				],
			};
		}
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

	private isOriginAllowed(req: http.IncomingMessage, config: McpConfig): boolean {
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
			hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
		if (!isLoopbackHost) {
			return false;
		}

		// When bound to a fixed port, require the origin to target it (or be portless).
		if (config.port && parsed.port) {
			return parsed.port === String(config.port) || parsed.port === String(this.lastPort ?? config.port);
		}

		return true;
	}

	private isAuthorized(req: http.IncomingMessage, config: McpConfig): boolean {
		if (!config.token) {
			return true;
		}
		const authHeaderValue = req.headers.authorization;
		const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;
		const match = (authHeader ?? "").match(/^Bearer\s+(.+)$/i);
		if (!match) {
			return false;
		}
		return this.tokensEqual(match[1].trim(), config.token.trim());
	}

	// Constant-time comparison to avoid leaking the token via response timing.
	private tokensEqual(provided: string, expected: string): boolean {
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

	private getSessionId(req: http.IncomingMessage, url?: URL): string | undefined {
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

	private isInitializeLikeRequest(body: unknown): boolean {
		if (!body) {
			return false;
		}
		if (Array.isArray(body)) {
			return body.some((entry) => this.isInitializeLikeRequest(entry));
		}
		if (typeof body !== "object") {
			return false;
		}
		const method = (body as { method?: unknown }).method;
		return typeof method === "string" && method.toLowerCase() === "initialize";
	}

	private async readBody(req: http.IncomingMessage): Promise<unknown> {
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

	private notifyServerStarted(port: number): void {
		const message = `MCP server started at http://${this.host}:${port}/mcp`;
		McpLogChannel.log(`[MCP] ${message}`);
		void vscode.window.showInformationMessage(message);
	}

	private notifyServerStopped(): void {
		const message = "MCP server stopped.";
		McpLogChannel.log(`[MCP] ${message}`);
		void vscode.window.showInformationMessage(message);
	}

	private notifyServerStartFailed(error: unknown): void {
		const details = this.formatErrorDetails(error);
		const message = `Failed to start MCP server: ${details}. See output for more details.`;
		McpLogChannel.log(`[MCP] Failed to start server: ${details}`);
		if (error instanceof Error && error.stack) {
			McpLogChannel.log(error.stack);
		}
		const viewOutput = "View Output";
		void vscode.window.showErrorMessage(message, viewOutput).then((selection) => {
			if (selection === viewOutput) {
				McpLogChannel.getChannel().show(true);
			}
		});
	}

	private formatErrorDetails(error: unknown): string {
		if (error instanceof Error) {
			const message = error.message?.trim();
			if (message) {
				const errnoError = error as NodeJS.ErrnoException;
				if (errnoError.code && !message.includes(errnoError.code)) {
					return `${message} (${errnoError.code})`;
				}
				return message;
			}
		}
		if (typeof error === "string") {
			return error;
		}
		if (typeof error === "object" && error) {
			try {
				return JSON.stringify(error);
			} catch {
				// fall through to best-effort string conversion
			}
		}
		const fallback = String(error);
		return fallback && fallback !== "[object Object]" ? fallback : "Unknown error";
	}

	private isNodeVersionSupported(): boolean {
		const [major] = process.versions.node.split(".");
		return Number(major) >= 18;
	}

	private buildStatus(config: McpConfig, running: boolean, port: number | null): McpStatus {
		return {
			enabled: config.enabled,
			running,
			trusted: vscode.workspace.isTrusted,
			readOnly: config.readOnly,
			transport: config.transport,
			port,
		};
	}

	private refreshStatus(): void {
		const config = this.readConfig();
		const running = Boolean(this.server);
		const port = running ? this.lastPort ?? config.port : null;
		const next = this.buildStatus(config, running, port);
		if (!this.isStatusEqual(this.status, next)) {
			this.status = next;
			this.statusEmitter.fire(this.status);
		}
	}

	private isStatusEqual(left: McpStatus, right: McpStatus): boolean {
		return (
			left.enabled === right.enabled &&
			left.running === right.running &&
			left.trusted === right.trusted &&
			left.readOnly === right.readOnly &&
			left.transport === right.transport &&
			left.port === right.port
		);
	}
}
