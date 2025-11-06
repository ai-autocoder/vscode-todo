/**
 * WebviewVisibilityCoordinator
 * Manages sync polling based on webview visibility using reference counting
 * Ensures polling only runs when at least one webview is visible
 */

import * as vscode from "vscode";
import { SyncManager } from "./SyncManager";

export class WebviewVisibilityCoordinator {
	private visibilityCount = 0;
	private syncManager: SyncManager;
	private context: vscode.ExtensionContext;
	private pollInterval: number;

	constructor(syncManager: SyncManager, context: vscode.ExtensionContext, pollInterval: number) {
		this.syncManager = syncManager;
		this.context = context;
		this.pollInterval = pollInterval;
	}

	/**
	 * Call when a webview becomes visible
	 */
	public incrementVisibility(): void {
		this.visibilityCount++;
		console.log(`[VisibilityCoordinator] Visibility count: ${this.visibilityCount}`);

		// Start polling when first webview becomes visible
		if (this.visibilityCount === 1) {
			this.startPollingIfNeeded();
		}
	}

	/**
	 * Call when a webview becomes hidden
	 */
	public decrementVisibility(): void {
		this.visibilityCount = Math.max(0, this.visibilityCount - 1);
		console.log(`[VisibilityCoordinator] Visibility count: ${this.visibilityCount}`);

		// Stop polling when no webviews are visible
		if (this.visibilityCount === 0) {
			this.stopPolling();
		}
	}

	/**
	 * Update poll interval and restart polling if active
	 */
	public updatePollInterval(interval: number): void {
		this.pollInterval = interval;
		console.log(`[VisibilityCoordinator] Poll interval updated to ${interval}s`);

		// Restart polling with new interval if currently running
		if (this.visibilityCount > 0) {
			this.stopPolling();
			this.startPollingIfNeeded();
		}
	}

	/**
	 * Call when sync modes change via commands
	 */
	public updateSyncModes(): void {
		console.log(`[VisibilityCoordinator] Sync modes updated`);

		// Restart polling if currently running
		if (this.visibilityCount > 0) {
			this.stopPolling();
			this.startPollingIfNeeded();
		}
	}

	/**
	 * Check if polling should be conditional on visibility
	 */
	private shouldPollOnlyWhenVisible(): boolean {
		const config = vscode.workspace.getConfiguration("vscodeTodo.sync");
		return config.get<boolean>("pollOnlyWhenVisible", true);
	}

	/**
	 * Start polling for scopes with GitHub sync enabled
	 */
	private startPollingIfNeeded(): void {
		// Check if polling should be conditional on visibility
		if (!this.shouldPollOnlyWhenVisible()) {
			// Setting disabled, don't manage polling based on visibility
			console.log(`[VisibilityCoordinator] pollOnlyWhenVisible is disabled, not managing polling`);
			return;
		}

		const userSyncMode = this.context.globalState.get<string>("syncMode", "profile-local");
		const workspaceSyncMode = this.context.workspaceState.get<string>("syncMode", "local");

		if (userSyncMode === "github") {
			console.log(`[VisibilityCoordinator] Starting user polling (${this.pollInterval}s)`);
			this.syncManager.startPolling("user", this.pollInterval);
		}

		if (workspaceSyncMode === "github") {
			console.log(`[VisibilityCoordinator] Starting workspace polling (${this.pollInterval}s)`);
			this.syncManager.startPolling("workspace", this.pollInterval);
		}
	}

	/**
	 * Stop all polling
	 */
	private stopPolling(): void {
		// Check if polling should be conditional on visibility
		if (!this.shouldPollOnlyWhenVisible()) {
			// Setting disabled, don't manage polling based on visibility
			return;
		}

		console.log(`[VisibilityCoordinator] Stopping all polling`);
		this.syncManager.stopPolling("user");
		this.syncManager.stopPolling("workspace");
	}

	/**
	 * Dispose resources
	 */
	public dispose(): void {
		this.stopPolling();
	}
}
