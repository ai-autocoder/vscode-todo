import * as http from "node:http";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { TodoScope } from "../todo/todoTypes";
import TodoService, { TodoUpdateFields } from "./TodoService";
import McpLogChannel from "./McpLogChannel";
import StorageSyncManager from "../storage/StorageSyncManager";
import { SyncManager } from "../sync/SyncManager";
import { EnhancedStore } from "@reduxjs/toolkit";
import { StoreState } from "../todo/todoTypes";
import * as path from "node:path";

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
	private readonly host = "127.0.0.1";
	private server: http.Server | null = null;
	private sessions = new Map<string, SessionEntry>();
	private config: McpConfig | null = null;
	private sdk: McpSdk | null = null;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly todoService: TodoService;

	constructor(
		private readonly context: vscode.ExtensionContext,
		store: EnhancedStore<StoreState>,
		storageSyncManager: StorageSyncManager,
		syncManager: SyncManager
	) {
		this.todoService = new TodoService(context, store, storageSyncManager, syncManager);
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

	public dispose(): void {
		void this.stopServer();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async applyConfig(): Promise<void> {
		const previous = this.config;
		const config = this.readConfig();
		this.todoService.updateAccess(config.readOnly, config.allowedScopes);

		if (!config.enabled || !vscode.workspace.isTrusted) {
			this.config = config;
			await this.stopServer();
			return;
		}

		if (!this.server) {
			this.config = config;
			await this.startWithConfig(config);
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
			return;
		}

		this.config = config;
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
			McpLogChannel.log(`[MCP] Failed to start server: ${String(error)}`);
			vscode.window.showErrorMessage("Failed to start MCP server. See output for details.");
			this.server = null;
			return;
		}

		const address = this.server.address();
		const port = typeof address === "object" && address ? address.port : config.port;
		this.config = config;
		McpLogChannel.log(`[MCP] Server started at http://${this.host}:${port}/mcp`);
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
		McpLogChannel.log("[MCP] Server stopped.");
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

		const sessionId = this.getSessionId(req);
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
				if (sessionId && this.sessions.has(sessionId)) {
					await this.sessions.get(sessionId)!.transport.handleRequest(req, res, body);
					return;
				}

				if (!sessionId && sdk.isInitializeRequest(body)) {
					await this.handleInitialize(req, res, body, sdk);
					return;
				}

				res.statusCode = 400;
				res.end("Invalid MCP request");
				return;
			}

			if (req.method === "GET") {
				if (!sessionId || !this.sessions.has(sessionId)) {
					res.statusCode = 400;
					res.end("Missing or invalid session ID");
					return;
				}
				await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
				return;
			}

			if (req.method === "DELETE") {
				if (!sessionId || !this.sessions.has(sessionId)) {
					res.statusCode = 400;
					res.end("Missing or invalid session ID");
					return;
				}
				await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
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
			onsessioninitialized: (sessionId) => {
				this.sessions.set(sessionId, { transport, server: mcpServer });
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
		if (transport.sessionId) {
			this.sessions.set(transport.sessionId, { transport, server: mcpServer });
		}
		await transport.handleRequest(req, res, body);
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
					"Use the todo.* tools to read and update VS Code Todo items. Use resources for snapshots.",
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

		const instructionsScopeTemplate = new sdk.resourceTemplate("todo://instructions?scope={scope}", {
			list: async () => {
				return {
					resources: [
						this.buildScopeResource(
							"todo://instructions?scope=user",
							"User Instructions",
							"User-scope instruction notes"
						),
						this.buildScopeResource(
							"todo://instructions?scope=workspace",
							"Workspace Instructions",
							"Workspace-scope instruction notes"
						),
					],
				};
			},
		});
		server.registerResource(
			"instruction-notes-scope",
			instructionsScopeTemplate,
			{
				title: "Instruction Notes (Scope)",
				description: "Instruction notes for user/workspace scopes",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const rawScope = this.getFirstValue(uri.searchParams.get("scope") ?? variables.scope);
				const scope = this.parseScopeParam(rawScope);
				if (!scope) {
					throw new Error("Missing or invalid scope.");
				}
				if (scope === TodoScope.currentFile) {
					throw new Error("File scope requires a path. Use todo://instructions?path=...");
				}
				const data = this.todoService.getInstructionNotesForScope(scope);
				return this.toResourceResult(uri.toString(), data);
			}
		);

		const instructionsFileTemplate = new sdk.resourceTemplate("todo://instructions?path={path}", {
			list: async () => {
				return { resources: this.buildFileResources("todo://instructions") };
			},
		});
		server.registerResource(
			"instruction-notes",
			instructionsFileTemplate,
			{
				title: "Instruction Notes (File)",
				description: "Instruction notes for a file with scope precedence",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const rawPath = uri.searchParams.get("path") ?? variables.path;
				const filePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
				if (!filePath) {
					throw new Error("Missing file path.");
				}
				const data = this.todoService.getInstructionNotesForFile(filePath);
				return this.toResourceResult(uri.toString(), data);
			}
		);

		const plansScopeTemplate = new sdk.resourceTemplate("todo://plans?scope={scope}", {
			list: async () => {
				return {
					resources: [
						this.buildScopeResource(
							"todo://plans?scope=user",
							"User Plans",
							"Plan headers in user scope"
						),
						this.buildScopeResource(
							"todo://plans?scope=workspace",
							"Workspace Plans",
							"Plan headers in workspace scope"
						),
					],
				};
			},
		});
		server.registerResource(
			"plan-headers",
			plansScopeTemplate,
			{
				title: "Plan Headers (Scope)",
				description: "Plan headers declared with @plan <slug> <title>",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const rawScope = this.getFirstValue(uri.searchParams.get("scope") ?? variables.scope);
				const scope = this.parseScopeParam(rawScope);
				if (!scope) {
					throw new Error("Missing or invalid scope.");
				}
				if (scope === TodoScope.currentFile) {
					throw new Error("File scope requires a path. Use todo://plans?path=...");
				}
				const data = this.todoService.getPlanHeadersForScope(scope);
				return this.toResourceResult(uri.toString(), data);
			}
		);

		const plansFileTemplate = new sdk.resourceTemplate("todo://plans?path={path}", {
			list: async () => {
				return { resources: this.buildFileResources("todo://plans") };
			},
		});
		server.registerResource(
			"plan-headers-file",
			plansFileTemplate,
			{
				title: "Plan Headers (File)",
				description: "Plan headers in file scope",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const rawPath = uri.searchParams.get("path") ?? variables.path;
				const filePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
				if (!filePath) {
					throw new Error("Missing file path.");
				}
				const data = this.todoService.getPlanHeadersForScope(TodoScope.currentFile, filePath);
				return this.toResourceResult(uri.toString(), data);
			}
		);

		const planItemsScopeTemplate = new sdk.resourceTemplate(
			"todo://plan?scope={scope}&slug={slug}",
			{
				list: undefined,
			}
		);
		server.registerResource(
			"plan-items",
			planItemsScopeTemplate,
			{
				title: "Plan Items (Scope)",
				description: "Plan items grouped by @plan:<slug> prefix",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const slugRaw = uri.searchParams.get("slug") ?? variables.slug;
				const slug = Array.isArray(slugRaw) ? slugRaw[0] : slugRaw;
				if (!slug) {
					throw new Error("Missing plan slug.");
				}
				const rawScope = this.getFirstValue(uri.searchParams.get("scope") ?? variables.scope);
				const scope = this.parseScopeParam(rawScope);
				if (!scope) {
					throw new Error("Missing or invalid scope.");
				}
				if (scope === TodoScope.currentFile) {
					throw new Error("File scope requires a path. Use todo://plan?path=...&slug=...");
				}
				const normalizedSlug = slug.trim().toLowerCase();

				const headers = this.todoService
					.getPlanHeadersForScope(scope)
					.filter((header) => header.slug === normalizedSlug);
				const items = this.todoService.getPlanItemsForScope(scope, slug);
				return this.toResourceResult(uri.toString(), {
					slug: normalizedSlug,
					scope: this.formatScope(scope),
					headers,
					items,
				});
			}
		);

		const planItemsFileTemplate = new sdk.resourceTemplate("todo://plan?path={path}&slug={slug}", {
			list: undefined,
		});
		server.registerResource(
			"plan-items-file",
			planItemsFileTemplate,
			{
				title: "Plan Items (File)",
				description: "Plan items grouped by @plan:<slug> prefix for a file",
				mimeType: "application/json",
			},
			async (uri, variables) => {
				const slugRaw = uri.searchParams.get("slug") ?? variables.slug;
				const slug = Array.isArray(slugRaw) ? slugRaw[0] : slugRaw;
				if (!slug) {
					throw new Error("Missing plan slug.");
				}
				const rawPath = uri.searchParams.get("path") ?? variables.path;
				const filePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
				if (!filePath) {
					throw new Error("Missing file path.");
				}
				const normalizedSlug = slug.trim().toLowerCase();

				const headers = this.todoService
					.getPlanHeadersForScope(TodoScope.currentFile, filePath)
					.filter((header) => header.slug === normalizedSlug);
				const items = this.todoService.getPlanItemsForScope(
					TodoScope.currentFile,
					slug,
					filePath
				);
				return this.toResourceResult(uri.toString(), {
					slug: normalizedSlug,
					scope: "file",
					filePath,
					headers,
					items,
				});
			}
		);
	}

	private registerTools(server: McpServer): void {
		const scopeSchema = z.enum(["user", "workspace", "currentFile"]);

		server.registerTool(
			"todo.list",
			{
				description: "List todos and notes for a scope.",
				inputSchema: {
					scope: scopeSchema,
					filePath: z.string().optional(),
					noteOnly: z.boolean().optional(),
					instructionOnly: z.boolean().optional(),
					textPrefix: z.string().optional(),
				},
			},
			async (args) => {
				return this.safeToolCall(() => {
					const { scope, ...filters } = args;
					const data = this.todoService.listTodos(scope as TodoScope, filters);
					return this.toolResult({
						scope,
						filePath: data.filePath,
						todos: data.todos,
					});
				});
			}
		);

		server.registerTool(
			"todo.add",
			{
				description: "Add a todo or note to a scope.",
				inputSchema: {
					scope: scopeSchema,
					text: z.string(),
					isNote: z.boolean().optional(),
					isMarkdown: z.boolean().optional(),
					filePath: z.string().optional(),
				},
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.addTodo(args.scope as TodoScope, args.text, args);
					return this.toolResult(result);
				});
			}
		);

		server.registerTool(
			"todo.update",
			{
				description: "Update a todo or note by id.",
				inputSchema: {
					scope: scopeSchema,
					id: z.number(),
					text: z.string().optional(),
					completed: z.boolean().optional(),
					isMarkdown: z.boolean().optional(),
					isNote: z.boolean().optional(),
					collapsed: z.boolean().optional(),
					filePath: z.string().optional(),
				},
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const updateFields: TodoUpdateFields = {
						text: args.text,
						completed: args.completed,
						isMarkdown: args.isMarkdown,
						isNote: args.isNote,
						collapsed: args.collapsed,
					};
					const result = await this.todoService.updateTodo(
						args.scope as TodoScope,
						args.id,
						updateFields,
						args.filePath
					);
					return this.toolResult(result);
				});
			}
		);

		server.registerTool(
			"todo.complete",
			{
				description: "Mark a todo complete or incomplete.",
				inputSchema: {
					scope: scopeSchema,
					id: z.number(),
					completed: z.boolean(),
					filePath: z.string().optional(),
				},
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.updateTodo(
						args.scope as TodoScope,
						args.id,
						{ completed: args.completed },
						args.filePath
					);
					return this.toolResult(result);
				});
			}
		);

		server.registerTool(
			"todo.delete",
			{
				description: "Delete todos by id.",
				inputSchema: {
					scope: scopeSchema,
					ids: z.array(z.number()),
					filePath: z.string().optional(),
				},
			},
			async (args) => {
				return this.safeToolCall(async () => {
					const result = await this.todoService.deleteTodos(
						args.scope as TodoScope,
						args.ids,
						args.filePath
					);
					return this.toolResult(result);
				});
			}
		);

		server.registerTool(
			"todo.listFiles",
			{
				description: "List files that have todos.",
			},
			async () => {
				return this.safeToolCall(() => {
					return this.toolResult({ files: this.todoService.listFiles() });
				});
			}
		);

	}

	private buildScopeResource(uri: string, name: string, description: string): Resource {
		return {
			uri,
			name,
			description,
			mimeType: "application/json",
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

	private getFirstValue(value: string | string[] | null | undefined): string | undefined {
		if (!value) {
			return undefined;
		}
		return Array.isArray(value) ? value[0] : value;
	}

	private parseScopeParam(rawScope: string | null | undefined): TodoScope | null {
		if (!rawScope) {
			return null;
		}
		const normalized = rawScope.trim().toLowerCase();
		switch (normalized) {
			case "user":
				return TodoScope.user;
			case "workspace":
				return TodoScope.workspace;
			case "file":
			case "currentfile":
				return TodoScope.currentFile;
			default:
				return null;
		}
	}

	private formatScope(scope: TodoScope): "user" | "workspace" | "file" {
		return scope === TodoScope.currentFile ? "file" : scope;
	}

	private toResourceResult(uri: string, data: unknown) {
		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify(data, null, 2),
				},
			],
		};
	}

	private toolResult(data: unknown) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(data ?? null, null, 2),
				},
			],
		};
	}

	private async safeToolCall(handler: () => Promise<any> | any) {
		try {
			return await handler();
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: String(error),
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
		return match[1].trim() === config.token.trim();
	}

	private getSessionId(req: http.IncomingMessage): string | undefined {
		const header = req.headers["mcp-session-id"];
		if (Array.isArray(header)) {
			return header[0];
		}
		return header;
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

	private isNodeVersionSupported(): boolean {
		const [major] = process.versions.node.split(".");
		return Number(major) >= 18;
	}
}
