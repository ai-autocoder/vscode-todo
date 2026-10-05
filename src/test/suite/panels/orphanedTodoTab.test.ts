import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import createStore from "../../../todo/store";
import { HelloWorldPanel } from "../../../panels/HelloWorldPanel";

/**
 * When the extension host restarts with the window open, as an update to the extension makes it
 * do, VS Code keeps the Todo editor tab but never connects it to the new host, and everything
 * sent from it is dropped: an add typed there cleared the box and was lost. The new host
 * replaces such a tab.
 *
 * A tab left by an earlier host cannot be made here, but to this host it is just a Todo tab that
 * `HelloWorldPanel` did not open, which `createWebviewPanel` with the same view type produces.
 */

// The panel's HTML points at a webview bundle that is not there, so no script runs in it and
// nothing reaches the message handler, which would otherwise need the rest of a real context.
function createMockContext(): vscode.ExtensionContext {
	const memento = {
		get: (_key: string, fallback?: unknown) => fallback,
		update: async () => undefined,
		keys: () => [],
	};
	return {
		extensionUri: vscode.Uri.file(path.join(os.tmpdir(), "vsc-todo-no-webview")),
		subscriptions: [],
		globalState: memento,
		workspaceState: memento,
	} as unknown as vscode.ExtensionContext;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("timed out waiting for the condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

suite("Todo tab left by an earlier extension host", () => {
	const context = createMockContext();
	const textFile = path.join(os.tmpdir(), "vsc-todo-orphaned-tab-test.txt");
	let listener: vscode.Disposable | undefined;

	suiteSetup(() => {
		fs.writeFileSync(textFile, "an editor the user is working in\n");
	});

	suiteTeardown(() => {
		fs.rmSync(textFile, { force: true });
	});

	teardown(async () => {
		listener?.dispose();
		listener = undefined;
		HelloWorldPanel.currentPanel?.dispose();
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		await waitFor(() => vscode.window.tabGroups.all.every((group) => group.tabs.length === 0));
	});

	/** A Todo tab this host did not open, and a promise that settles when it is closed. */
	async function openOrphan(viewColumn: vscode.ViewColumn) {
		const panel = vscode.window.createWebviewPanel(HelloWorldPanel.viewType, "Todo", viewColumn);
		const closed = new Promise<void>((resolve) => panel.onDidDispose(() => resolve()));
		await waitFor(() => HelloWorldPanel.todoTabs().length === 1);
		return { panel, closed, tab: HelloWorldPanel.todoTabs()[0] };
	}

	async function openTextEditor(viewColumn: vscode.ViewColumn): Promise<void> {
		await vscode.window.showTextDocument(vscode.Uri.file(textFile), { viewColumn });
	}

	function activeTabLabel(viewColumn: vscode.ViewColumn): string | undefined {
		return vscode.window.tabGroups.all.find((group) => group.viewColumn === viewColumn)?.activeTab
			?.label;
	}

	test("replaces a tab in front at once, keeping its group even when it is the only tab there", async () => {
		await openTextEditor(vscode.ViewColumn.One);
		const orphan = await openOrphan(vscode.ViewColumn.Two);
		const group = orphan.tab.group;

		listener = HelloWorldPanel.replaceOrphanedTabs([orphan.tab], context, createStore());

		await orphan.closed;
		assert.ok(HelloWorldPanel.currentPanel, "a live Todo panel should have been opened");
		await waitFor(() => HelloWorldPanel.todoTabs().length === 1);
		assert.strictEqual(HelloWorldPanel.todoTabs()[0].group, group, "in the same group");
	});

	test("replaces a tab behind another editor only once it is shown", async () => {
		const orphan = await openOrphan(vscode.ViewColumn.One);
		await openTextEditor(vscode.ViewColumn.One);
		await waitFor(() => !orphan.tab.isActive);

		listener = HelloWorldPanel.replaceOrphanedTabs([orphan.tab], context, createStore());

		assert.strictEqual(HelloWorldPanel.currentPanel, undefined, "nothing replaced yet");
		assert.strictEqual(
			activeTabLabel(vscode.ViewColumn.One),
			path.basename(textFile),
			"the editor in use stays in front"
		);

		orphan.panel.reveal(vscode.ViewColumn.One);

		await orphan.closed;
		assert.ok(HelloWorldPanel.currentPanel, "a live Todo panel should have been opened");
		await waitFor(() => HelloWorldPanel.todoTabs().length === 1);
		assert.strictEqual(HelloWorldPanel.todoTabs()[0].group.viewColumn, vscode.ViewColumn.One);
	});

	test("moves a panel opened during activation into the old tab's place", async () => {
		const orphan = await openOrphan(vscode.ViewColumn.One);
		const store = createStore();
		// The Todo command, run before activation got as far as replacing the tab.
		HelloWorldPanel.render(context, store);
		const panel = HelloWorldPanel.currentPanel;
		await waitFor(() => HelloWorldPanel.todoTabs().length === 2);

		listener = HelloWorldPanel.replaceOrphanedTabs([orphan.tab], context, store);

		await orphan.closed;
		await waitFor(() => HelloWorldPanel.todoTabs().length === 1);
		assert.strictEqual(HelloWorldPanel.currentPanel, panel, "the panel already open is kept");
		await waitFor(() => HelloWorldPanel.todoTabs()[0]?.group.viewColumn === vscode.ViewColumn.One);
	});

	test("opens nothing when no Todo tab was left", () => {
		listener = HelloWorldPanel.replaceOrphanedTabs([], context, createStore());

		assert.strictEqual(HelloWorldPanel.currentPanel, undefined);
		assert.strictEqual(HelloWorldPanel.todoTabs().length, 0);
	});
});
