import * as vscode from "vscode";

class McpLogChannel {
	private static channel: vscode.OutputChannel | null = null;

	public static getChannel(): vscode.OutputChannel {
		if (!this.channel) {
			this.channel = vscode.window.createOutputChannel("VS Code Todo MCP", { log: true });
		}
		return this.channel;
	}

	public static log(message: string): void {
		this.getChannel().appendLine(message);
	}
}

export default McpLogChannel;
