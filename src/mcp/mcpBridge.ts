import type { ResourceName, ToolName } from "./mcpDefinitions";

/**
 * The message contract between the MCP worker and the extension host.
 *
 * The worker owns the HTTP listener and the MCP sessions, so the handshake and `tools/list` are
 * answered even while another extension blocks the extension host's thread. Anything that needs
 * the Redux store or a VS Code API — tool calls and resource reads — is forwarded here as a
 * `call` and answered with a `result`. Every forwarded call carries a timeout on the worker side,
 * so a stalled host makes a call slow and then fail, never hang the session.
 */

export type McpWorkerData = {
	host: string;
	port: number;
	token: string;
	version: string;
	callTimeoutMs: number;
	listTimeoutMs: number;
};

export type BridgeRequest =
	| { op: "tool"; name: ToolName; args: unknown }
	| { op: "resource"; name: ResourceName; uri: string }
	| { op: "fileResource"; uri: string; filePath: string }
	| { op: "listFileResources" };

export type SerializedError = { message: string; code?: string; stack?: string };

export type WorkerToHostMessage =
	| { type: "call"; id: number; request: BridgeRequest }
	| { type: "log"; message: string }
	| { type: "listening"; port: number }
	| { type: "startFailed"; error: SerializedError }
	| { type: "stopped" };

export type BridgeResult =
	| { type: "result"; id: number; ok: true; value: unknown }
	| { type: "result"; id: number; ok: false; error: string };

export type HostToWorkerMessage = BridgeResult | { type: "stop" };

export class BridgeTimeoutError extends Error {
	constructor(public readonly timeoutMs: number) {
		super(`The VS Code extension host did not answer within ${Math.round(timeoutMs / 1000)} s.`);
		this.name = "BridgeTimeoutError";
	}
}

/** Rejects the calls still pending when the bridge shuts down; its message is for the client. */
export class BridgeClosedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "BridgeClosedError";
	}
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** The worker's end of the bridge: numbers each call and settles it by result or timeout. */
export class BridgeClient {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();

	constructor(private readonly post: (message: WorkerToHostMessage) => void) {}

	public call(request: BridgeRequest, timeoutMs: number): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				// A result that arrives after this finds no entry and is dropped.
				this.pending.delete(id);
				reject(new BridgeTimeoutError(timeoutMs));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.post({ type: "call", id, request });
		});
	}

	public handleResult(message: BridgeResult): void {
		const entry = this.pending.get(message.id);
		if (!entry) {
			return;
		}
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.ok) {
			entry.resolve(message.value);
		} else {
			entry.reject(new Error(message.error));
		}
	}

	public rejectAll(reason: string): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new BridgeClosedError(reason));
		}
		this.pending.clear();
	}

	public get pendingCount(): number {
		return this.pending.size;
	}
}

export function serializeError(error: unknown): SerializedError {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			message: error.message,
			...(typeof code === "string" ? { code } : {}),
			...(error.stack ? { stack: error.stack } : {}),
		};
	}
	return { message: String(error) };
}
