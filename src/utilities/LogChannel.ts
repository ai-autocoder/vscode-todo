// LogChannel.ts

import * as vscode from "vscode";

class LogChannel {
	private static channel: vscode.OutputChannel | null = null;

	public static getChannel(): vscode.OutputChannel {
		if (!this.channel) {
			this.channel = vscode.window.createOutputChannel("VSCode Todo", { log: true });
		}
		return this.channel;
	}

	public static log(message: string): void {
		this.getChannel().appendLine(`${message}`);
	}
}

export default LogChannel;
