import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import * as z from "zod";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { TodoScope } from "../todo/todoTypes";
import TodoService, { PaginatedResult } from "../todo/TodoService";
import McpLogChannel from "./McpLogChannel";
import StorageSyncManager from "../storage/StorageSyncManager";
import { EnhancedStore } from "@reduxjs/toolkit";
import { StoreState } from "../todo/todoTypes";
import * as path from "node:path";
import { McpStatus } from "./mcpStatus";
import {
	BridgeRequest,
	BridgeResult,
	McpWorkerData,
	SerializedError,
	WorkerToHostMessage,
} from "./mcpBridge";
import { FILE_RESOURCE, TOOL_INPUTS, ToolArgs, ToolName } from "./mcpDefinitions";

type McpConfig = {
	enabled: boolean;
	readOnly: boolean;
	allowedScopes: Array<"user" | "workspace" | "file">;
	transport: "streamableHttp";
	port: number;
	token: string;
};

/**
 * Owns the MCP server's lifecycle and runs the calls it forwards.
 *
 * The HTTP listener, the sessions and the handshake run in a worker thread
 * (`mcpWorker.ts` → `McpHttpServer`), because this extension host shares one JS thread with
 * every other extension: when one of them blocks it, a listener here cannot even answer
 * `initialize`, the client's connect times out, and the client drops the server for the whole
 * session. Tool calls and resource reads still need the Redux store and VS Code APIs, so the
 * worker forwards them over the bridge (`mcpBridge.ts`) and this class answers them.
 */
export default class McpServerHost implements vscode.Disposable {
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
	// How long the worker waits for this thread to answer a forwarded call. Stalls caused by
	// other extensions have lasted up to two minutes; past this the call fails with a
	// "host busy" error instead of hanging, and the session stays usable.
	private static readonly CALL_TIMEOUT_MS = 60_000;
	// Listing file resources is part of resources/list, which a client may send while it
	// connects, so it gives up quickly and lists none rather than failing the list.
	private static readonly LIST_TIMEOUT_MS = 5_000;
	// How long a stop waits for the worker to close its sessions before terminating it.
	private static readonly STOP_TIMEOUT_MS = 3_000;
	// After a crash the worker is restarted with an exponential backoff: 1 s, 2 s, 4 s, 8 s,
	// 16 s. A worker that ran for RESTART_RESET_MS before crashing starts the count again; the
	// crash after MAX_RESTARTS restarts in a row makes the host give up and say so.
	private static readonly RESTART_BASE_DELAY_MS = 1_000;
	private static readonly RESTART_RESET_MS = 60_000;
	private static readonly MAX_RESTARTS = 5;
	private readonly host = "127.0.0.1";
	private worker: Worker | null = null;
	// The config the running worker was started with; `config` is the one last asked for.
	private runningConfig: McpConfig | null = null;
	private workerStartedAt = 0;
	private consecutiveCrashes = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private restartGeneration = 0;
	private disposed = false;
	// Every start, stop and config change runs through this chain, one at a time, and each
	// compares what is wanted with what is running. Run concurrently, a change that arrived
	// while a worker was still starting was lost, and overlapping stops raced a restart.
	private queue: Promise<unknown> = Promise.resolve();
	private config: McpConfig | null = null;
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
		this.disposed = true;
		this.cancelRestart();
		void this.stopServer();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		this.statusEmitter.dispose();
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch((error) => {
			McpLogChannel.log(`[MCP] Lifecycle error: ${String(error)}`);
		});
		return run;
	}

	private applyConfig(): Promise<void> {
		return this.enqueue(async () => {
			const config = this.readConfig();
			this.todoService.updateAccess(config.readOnly, config.allowedScopes);
			await this.reconcile(config);
		});
	}

	/** Test seam and restart path: run the server with this config, whatever the settings say. */
	private startWithConfig(config: McpConfig): Promise<void> {
		return this.enqueue(() => this.reconcile(config));
	}

	private stopServer(): Promise<void> {
		return this.enqueue(async () => {
			this.cancelRestart();
			await this.stopWorker();
		});
	}

	// Only ever called from inside the queue.
	private async reconcile(config: McpConfig): Promise<void> {
		// Whatever this pass decides replaces a restart still waiting on its backoff.
		this.cancelRestart();
		this.config = config;
		if (!config.enabled || !vscode.workspace.isTrusted || this.disposed) {
			await this.stopWorker();
			this.refreshStatus();
			return;
		}
		if (this.worker && this.runningConfig && !this.needsRestart(this.runningConfig, config)) {
			this.refreshStatus();
			return;
		}
		await this.stopWorker();
		await this.startWorker(config);
		this.refreshStatus();
	}

	private needsRestart(running: McpConfig, wanted: McpConfig): boolean {
		return (
			running.port !== wanted.port ||
			running.token !== wanted.token ||
			running.transport !== wanted.transport
		);
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

	// Only ever called from inside the queue, with no worker running.
	private async startWorker(config: McpConfig): Promise<void> {
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

		const workerData: McpWorkerData = {
			host: this.host,
			port: config.port,
			token: config.token,
			version: this.context.extension.packageJSON.version ?? "0.0.0",
			callTimeoutMs: McpServerHost.CALL_TIMEOUT_MS,
			listTimeoutMs: McpServerHost.LIST_TIMEOUT_MS,
		};

		let worker: Worker;
		let port: number;
		try {
			worker = new Worker(path.join(__dirname, "mcpWorker.js"), { workerData });
			worker.on("message", (message: WorkerToHostMessage) => {
				this.onWorkerMessage(worker, message);
			});
			port = await this.waitForListening(worker);
		} catch (error) {
			this.notifyServerStartFailed(error);
			return;
		}

		worker.on("error", (error) => {
			McpLogChannel.log(`[MCP] Worker error: ${String(error)}`);
			if (error.stack) {
				McpLogChannel.log(error.stack);
			}
		});
		worker.on("exit", (code) => {
			// A stop clears this.worker first, so only an unexpected exit gets here.
			if (this.worker === worker) {
				this.onWorkerCrashed(code);
			}
		});

		this.worker = worker;
		this.runningConfig = config;
		this.workerStartedAt = Date.now();
		this.lastPort = port;
		this.notifyServerStarted(port);
	}

	private onWorkerCrashed(code: number): void {
		this.worker = null;
		this.runningConfig = null;
		this.lastPort = null;
		this.refreshStatus();
		McpLogChannel.log(`[MCP] Worker exited unexpectedly with code ${code}.`);
		if (this.disposed) {
			return;
		}

		if (Date.now() - this.workerStartedAt >= McpServerHost.RESTART_RESET_MS) {
			this.consecutiveCrashes = 0;
		}
		this.consecutiveCrashes++;
		if (this.consecutiveCrashes > McpServerHost.MAX_RESTARTS) {
			const message =
				`MCP server crashed ${McpServerHost.MAX_RESTARTS + 1} times in a row and was not ` +
				"restarted. Run the start command to try again; see output for details.";
			McpLogChannel.log(`[MCP] ${message}`);
			void vscode.window.showErrorMessage(message);
			this.consecutiveCrashes = 0;
			return;
		}

		const delay = McpServerHost.RESTART_BASE_DELAY_MS * 2 ** (this.consecutiveCrashes - 1);
		McpLogChannel.log(`[MCP] Restarting the MCP server in ${delay} ms.`);
		this.cancelRestart();
		const generation = this.restartGeneration;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			// The config is read when the task runs, not when the timer fires: a change already
			// queued ahead of it — a disable, a stop — has to win over the restart.
			void this.enqueue(async () => {
				if (
					generation === this.restartGeneration &&
					this.config &&
					!this.disposed &&
					!this.worker
				) {
					await this.reconcile(this.config);
				}
			});
		}, delay);
	}

	// Cancels a pending restart: its timer if it has not fired, and — through the generation —
	// its queued task if it has, which may be sitting behind the very stop cancelling it.
	private cancelRestart(): void {
		this.restartGeneration++;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}

	private waitForListening(worker: Worker): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const fail = (error: Error) => {
				cleanup();
				void worker.terminate();
				reject(error);
			};
			const onMessage = (message: WorkerToHostMessage) => {
				if (message.type === "listening") {
					cleanup();
					resolve(message.port);
				} else if (message.type === "startFailed") {
					fail(this.toError(message.error));
				}
			};
			const onExit = (code: number) => {
				fail(new Error(`The MCP worker exited with code ${code} before it started listening`));
			};
			const cleanup = () => {
				worker.off("message", onMessage);
				worker.off("error", fail);
				worker.off("exit", onExit);
			};
			worker.on("message", onMessage);
			worker.on("error", fail);
			worker.on("exit", onExit);
		});
	}

	// Only ever called from inside the queue.
	private async stopWorker(): Promise<void> {
		const worker = this.worker;
		if (!worker) {
			return;
		}
		this.worker = null;
		this.runningConfig = null;

		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				worker.off("message", onMessage);
				worker.off("exit", done);
				resolve();
			};
			const onMessage = (message: WorkerToHostMessage) => {
				if (message.type === "stopped") {
					done();
				}
			};
			const timer = setTimeout(() => {
				McpLogChannel.log("[MCP] Worker did not stop in time; terminating it.");
				done();
			}, McpServerHost.STOP_TIMEOUT_MS);
			worker.on("message", onMessage);
			worker.on("exit", done);
			worker.postMessage({ type: "stop" });
		});
		await worker.terminate();

		this.lastPort = null;
		this.notifyServerStopped();
		this.refreshStatus();
	}

	private onWorkerMessage(worker: Worker, message: WorkerToHostMessage): void {
		if (message.type === "log") {
			McpLogChannel.log(message.message);
		} else if (message.type === "call") {
			void this.answerCall(worker, message.id, message.request);
		}
	}

	private async answerCall(worker: Worker, id: number, request: BridgeRequest): Promise<void> {
		let reply: BridgeResult;
		try {
			reply = { type: "result", id, ok: true, value: await this.handleBridgeRequest(request) };
		} catch (error) {
			McpLogChannel.log(`[MCP] ${request.op} request failed: ${String(error)}`);
			const message =
				error instanceof Error && error.message.trim()
					? error.message
					: "The request failed due to an unexpected error.";
			reply = { type: "result", id, ok: false, error: message };
		}
		try {
			worker.postMessage(reply);
		} catch (error) {
			McpLogChannel.log(`[MCP] Could not reply to the worker: ${String(error)}`);
		}
	}

	private async handleBridgeRequest(request: BridgeRequest): Promise<unknown> {
		switch (request.op) {
			case "tool":
				return this.runTool(request.name, request.args);
			case "resource":
				switch (request.name) {
					case "user-todos":
						return this.toResourceResult(
							request.uri,
							this.todoService.listTodos(TodoScope.user).todos
						);
					case "workspace-todos":
						return this.toResourceResult(
							request.uri,
							this.todoService.listTodos(TodoScope.workspace).todos
						);
					case "todo-counts":
						return this.toResourceResult(request.uri, this.todoService.getCounts());
					case "todo-files":
						return this.toResourceResult(request.uri, this.todoService.listFiles());
				}
				throw new Error("Unknown resource.");
			case "fileResource": {
				const data = this.todoService.listTodos(TodoScope.currentFile, {
					filePath: request.filePath,
				});
				return this.toResourceResult(request.uri, data.todos);
			}
			case "listFileResources":
				return this.buildFileResources(FILE_RESOURCE.uriPrefix);
		}
	}

	private runTool(name: ToolName, rawArgs: unknown) {
		return this.safeToolCall(async () => {
			switch (name) {
				case "todo_list_items": {
					const args = parseToolArgs(name, rawArgs);
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
				}
				case "todo_count_items": {
					const args = parseToolArgs(name, rawArgs);
					return this.toolResult(this.todoService.getCounts(args.tag));
				}
				case "todo_add_item": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.addTodo(args.scope as TodoScope, args.text, args);
					if (!result) {
						throw new Error("Failed to create the todo: it was not added to the store.");
					}
					return this.toolResult({
						scope: result.scope,
						...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
						todo: result.todo,
					});
				}
				case "todo_add_items": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.addTodos(args.scope as TodoScope, args.items, {
						// Batch insert defaults to 'bottom' (append the block in order), independent
						// of the user's single-add createPosition preference. See batchPositionSchema.
						position: args.position ?? "bottom",
						filePath: args.filePath,
					});
					return this.toolResult({
						scope: result.scope,
						...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
						todos: result.todos,
						count: result.todos.length,
					});
				}
				case "todo_list_files": {
					const args = parseToolArgs(name, rawArgs);
					const data = this.todoService.listFilesPaginated({
						limit: args.limit,
						offset: args.offset,
					});
					return this.toolResult({
						files: data.items,
						...this.paginationFields(data),
					});
				}
				case "todo_update_text": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.updateTodoText(
						args.scope as TodoScope,
						args.id,
						args.newText,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				}
				case "todo_set_completed": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.setCompleted(
						args.scope as TodoScope,
						args.id,
						args.completed,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				}
				case "todo_set_note": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.setNote(args.scope as TodoScope, args.id, args.isNote, {
						filePath: args.filePath,
					});
					return this.toolResult(this.itemResult(result));
				}
				case "todo_set_markdown": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.setMarkdown(
						args.scope as TodoScope,
						args.id,
						args.isMarkdown,
						{ filePath: args.filePath }
					);
					return this.toolResult(this.itemResult(result));
				}
				case "todo_set_tags": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.setTags(args.scope as TodoScope, args.id, args.tags, {
						filePath: args.filePath,
					});
					return this.toolResult(this.itemResult(result));
				}
				case "todo_delete_items": {
					const args = parseToolArgs(name, rawArgs);
					const result = await this.todoService.deleteTodos(args.scope as TodoScope, args.ids, {
						filePath: args.filePath,
					});
					return this.toolResult({
						scope: result.scope,
						...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
						deleted: result.deleted,
						count: result.count,
					});
				}
			}
			throw new Error(`Unknown tool: ${String(name)}`);
		});
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

	private toError(serialized: SerializedError): Error {
		const error = new Error(serialized.message) as NodeJS.ErrnoException;
		if (serialized.code) {
			error.code = serialized.code;
		}
		if (serialized.stack) {
			error.stack = serialized.stack;
		}
		return error;
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
		const running = Boolean(this.worker);
		const port = running ? (this.lastPort ?? config.port) : null;
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

// The worker has already validated the arguments against the same shapes; parsing again
// here types them for this side and rejects anything that did not come through the SDK.
function parseToolArgs<N extends ToolName>(name: N, rawArgs: unknown): ToolArgs<N> {
	const shape: z.ZodRawShape = TOOL_INPUTS[name];
	return z.object(shape).parse(rawArgs ?? {}) as ToolArgs<N>;
}
