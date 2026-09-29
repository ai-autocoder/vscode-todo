import { parentPort, workerData } from "node:worker_threads";
import McpHttpServer from "./McpHttpServer";
import {
	BridgeClient,
	HostToWorkerMessage,
	McpWorkerData,
	WorkerToHostMessage,
	serializeError,
} from "./mcpBridge";

// Entry point of the MCP worker thread, started by McpServerHost. The HTTP listener lives
// here, on its own event loop, so an extension that blocks the extension host's thread
// cannot make the MCP connect time out. See mcpBridge.ts for the message contract.

if (!parentPort) {
	throw new Error("mcpWorker must run as a worker thread.");
}
const port = parentPort;
const data = workerData as McpWorkerData;

const post = (message: WorkerToHostMessage) => port.postMessage(message);

// Node ends a thread on an unhandled rejection, and VS Code's own safety net covers only the
// extension host's main thread. A stray rejection is logged instead; an uncaught exception
// still ends the worker, and McpServerHost restarts it.
process.on("unhandledRejection", (reason) => {
	post({ type: "log", message: `[MCP] Unhandled rejection in the worker: ${String(reason)}` });
});
const bridge = new BridgeClient(post);
const server = new McpHttpServer({
	...data,
	call: (request, timeoutMs) => bridge.call(request, timeoutMs),
	log: (message) => post({ type: "log", message }),
});

port.on("message", (message: HostToWorkerMessage) => {
	if (message.type === "result") {
		bridge.handleResult(message);
		return;
	}
	if (message.type === "stop") {
		// Fail the forwarded calls still waiting on the host, and give their error replies one
		// turn of the event loop to reach the client before the stop closes every transport and
		// connection; otherwise the client sees only a reset connection.
		bridge.rejectAll("The MCP server is stopping; try again once it is back.");
		setImmediate(() => {
			void server
				.stop()
				.catch((error) =>
					post({ type: "log", message: `[MCP] Error stopping: ${String(error)}` })
				)
				.finally(() => post({ type: "stopped" }));
		});
	}
});

server.start().then(
	(boundPort) => post({ type: "listening", port: boundPort }),
	(error) => post({ type: "startFailed", error: serializeError(error) })
);
