/**
 * Conflict Resolution UI
 * Enhanced per-item conflict resolution using multi-step QuickPick
 */

import * as vscode from "vscode";
import { Todo } from "../todo/todoTypes";
import { ConflictSet } from "./ThreeWayMerge";
import { formatMergeSummary } from "./ThreeWayMerge";
import { getGistId } from "../utilities/syncConfig";

/**
 * Result of user's conflict resolution choices
 */
export interface ConflictResolution {
	conflictId: number;
	resolution: "local" | "remote" | "skip";
}

export interface ConflictResolutionResult {
	resolutions: ConflictResolution[];
	cancelled: boolean;
}

/**
 * Enhanced conflict resolution UI with per-item control
 */
export class ConflictResolutionUI {
	/**
	 * Show conflict resolution wizard
	 * Returns resolved todos or null if cancelled
	 *
	 * @param conflicts - Array of conflicts to resolve
	 * @param autoMerged - Todos that were successfully auto-merged
	 * @param base - Base version for context
	 * @returns Array of todos after resolution, or null if cancelled
	 */
	static async resolveConflicts(
		conflicts: ConflictSet[],
		autoMerged: Todo[],
		base: Todo[]
	): Promise<Todo[] | null> {
		// Step 1: Overview and choice of resolution mode
		const mode = await this.showOverview(conflicts, autoMerged, base);
		if (!mode) {
			return null;
		}

		// Batch mode: Keep all local
		if (mode === "all-local") {
			return conflicts.map((c) => c.local).filter((t): t is Todo => t !== null);
		}

		// Batch mode: Keep all remote
		if (mode === "all-remote") {
			return conflicts.map((c) => c.remote).filter((t): t is Todo => t !== null);
		}

		// View gist in browser
		if (mode === "view-gist") {
			const gistId = getGistId();
			if (gistId) {
				await vscode.env.openExternal(vscode.Uri.parse(`https://gist.github.com/${gistId}`));
			}
			return null;
		}

		// Per-item resolution mode
		if (mode === "per-item") {
			const result = await this.resolvePerItem(conflicts);
			if (!result || result.cancelled) {
				return null;
			}
			return this.applyResolutions(conflicts, result.resolutions);
		}

		return null;
	}

	/**
	 * Step 1: Show overview and resolution mode selection
	 */
	private static async showOverview(
		conflicts: ConflictSet[],
		autoMerged: Todo[],
		base: Todo[]
	): Promise<string | null> {
		const autoMergeSummary = formatMergeSummary({ autoMerged, conflicts: [] }, base);

		const items = [
			{
				label: "$(list-ordered) Resolve Each Conflict",
				description: "Recommended for reviewing changes",
				detail: "Walk through each conflict and choose individually",
				value: "per-item",
			},
			{
				label: "$(cloud-download) Keep All Local",
				description: "Use all your changes",
				detail: `Applies local version to all ${conflicts.length} conflicts`,
				value: "all-local",
			},
			{
				label: "$(cloud-upload) Keep All Remote",
				description: "Use all remote changes",
				detail: `Applies remote version to all ${conflicts.length} conflicts`,
				value: "all-remote",
			},
			{
				label: "$(link-external) View on GitHub",
				description: "Open gist in browser",
				detail: "Manually resolve conflicts in gist",
				value: "view-gist",
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			title: "Sync Conflict Detected",
			placeHolder: `Auto-merged: ${autoMergeSummary} | Conflicts: ${conflicts.length}`,
			ignoreFocusOut: true,
			matchOnDescription: true,
			matchOnDetail: true,
		});

		return selected ? selected.value : null;
	}

	/**
	 * Step 2: Resolve each conflict individually
	 */
	private static async resolvePerItem(
		conflicts: ConflictSet[]
	): Promise<ConflictResolutionResult | null> {
		const resolutions: ConflictResolution[] = [];
		let currentIndex = 0;

		while (currentIndex < conflicts.length) {
			const conflict = conflicts[currentIndex];
			const resolution = await this.resolveOneConflict(conflict, currentIndex, conflicts.length);

			if (resolution === "cancel") {
				const confirm = await vscode.window.showWarningMessage(
					"Cancel conflict resolution? No changes will be synced.",
					{ modal: true },
					"Yes, Cancel",
					"No, Continue"
				);
				if (confirm === "Yes, Cancel") {
					return { resolutions: [], cancelled: true };
				}
				continue; // Show same conflict again
			}

			if (resolution === "back") {
				if (currentIndex > 0) {
					currentIndex--;
					// Remove previous resolution if going back
					resolutions.pop();
				}
				continue;
			}

			// Handle view-diff: show diff and re-prompt
			if (resolution === "view-diff") {
				await this.showDiffInEditor(conflict);
				continue; // Show same conflict again
			}

			// Record resolution
			resolutions.push({
				conflictId: conflict.todoId,
				resolution: resolution as "local" | "remote" | "skip",
			});

			currentIndex++;
		}

		// Show confirmation
		const confirmed = await this.showConfirmation(conflicts, resolutions);
		if (!confirmed) {
			return { resolutions: [], cancelled: true };
		}

		return { resolutions, cancelled: false };
	}

	/**
	 * Show resolution picker for a single conflict
	 */
	private static async resolveOneConflict(
		conflict: ConflictSet,
		index: number,
		total: number
	): Promise<"local" | "remote" | "skip" | "back" | "cancel" | "view-diff"> {
		const conflictDetail = this.formatConflictDetail(conflict);

		const items: Array<{
			label: string;
			description: string;
			detail: string;
			value: "local" | "remote" | "skip" | "back" | "view-diff";
		}> = [
			{
				label: "$(check) Keep Local",
				description: conflict.local ? this.truncate(conflict.local.text, 60) : "[DELETED]",
				detail: conflict.local ? this.formatFullTodoText(conflict.local) : "[This todo was deleted]",
				value: "local",
			},
			{
				label: "$(cloud) Keep Remote",
				description: conflict.remote ? this.truncate(conflict.remote.text, 60) : "[DELETED]",
				detail: conflict.remote ? this.formatFullTodoText(conflict.remote) : "[This todo was deleted]",
				value: "remote",
			},
			{
				label: "$(diff) View Full Diff",
				description: "Open side-by-side comparison",
				detail: "Compare local and remote versions in editor",
				value: "view-diff",
			},
			{
				label: "$(debug-step-over) Skip This Conflict",
				description: "Decide later",
				detail: "You'll be prompted again next sync",
				value: "skip",
			},
		];

		// Add back option if not first conflict
		if (index > 0) {
			items.push({
				label: "$(arrow-left) Go Back",
				description: "Return to previous conflict",
				detail: `Back to conflict ${index}`,
				value: "back",
			});
		}

		const selected = await vscode.window.showQuickPick(items, {
			title: `Conflict ${index + 1} of ${total}: ${conflict.conflictType}`,
			placeHolder: conflictDetail,
			ignoreFocusOut: false,
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!selected) {
			return "cancel";
		}

		return selected.value;
	}

	/**
	 * Show confirmation screen before applying resolutions
	 */
	private static async showConfirmation(
		conflicts: ConflictSet[],
		resolutions: ConflictResolution[]
	): Promise<boolean> {
		const resolved = resolutions.filter((r) => r.resolution !== "skip").length;
		const skipped = resolutions.filter((r) => r.resolution === "skip").length;

		// Check if all were skipped
		if (skipped === conflicts.length) {
			vscode.window.showWarningMessage(
				"All conflicts skipped. Sync cancelled. You'll be asked again next sync."
			);
			return false;
		}

		// Build summary
		const summary = resolutions
			.map((r, i) => {
				const conflict = conflicts.find((c) => c.todoId === r.conflictId);
				if (!conflict) {
					return "";
				}

				let text = `${i + 1}. `;
				if (r.resolution === "local") {
					text += `Keep Local: ${this.truncate(conflict.local?.text || "", 40)}`;
				} else if (r.resolution === "remote") {
					text += `Keep Remote: ${this.truncate(conflict.remote?.text || "", 40)}`;
				} else {
					text += "SKIPPED";
				}
				return text;
			})
			.join("\n");

		const items = [
			{
				label: "$(check-all) Apply Resolutions",
				description: `${resolved} conflicts resolved, ${skipped} skipped`,
				detail: "Save and sync changes",
				value: "apply",
			},
			{
				label: "$(eye) Review Choices",
				description: "See what you selected",
				detail: summary,
				value: "review",
			},
			{
				label: "$(x) Cancel",
				description: "Abort sync operation",
				detail: "No changes will be synced",
				value: "cancel",
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			title: "Review Conflict Resolutions",
			placeHolder: `Resolved: ${resolved}/${conflicts.length} conflicts`,
			ignoreFocusOut: true,
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!selected || selected.value === "cancel") {
			return false;
		}

		if (selected.value === "review") {
			// Show detailed summary in a modal
			const reviewMessage = `Conflict Resolutions:\n\n${summary}\n\nApply these changes?`;
			const confirm = await vscode.window.showInformationMessage(
				reviewMessage,
				{ modal: true },
				"Apply",
				"Cancel"
			);
			return confirm === "Apply";
		}

		return true; // apply
	}

	/**
	 * Apply user resolutions to conflicts
	 */
	private static applyResolutions(
		conflicts: ConflictSet[],
		resolutions: ConflictResolution[]
	): Todo[] {
		const resolved: Todo[] = [];

		for (const resolution of resolutions) {
			if (resolution.resolution === "skip") {
				continue; // Skip this conflict, won't be in result
			}

			const conflict = conflicts.find((c) => c.todoId === resolution.conflictId);
			if (!conflict) {
				continue;
			}

			if (resolution.resolution === "local" && conflict.local) {
				resolved.push(conflict.local);
			} else if (resolution.resolution === "remote" && conflict.remote) {
				resolved.push(conflict.remote);
			}
		}

		return resolved;
	}

	/**
	 * Format conflict details for display (increased truncation limits for better context)
	 */
	private static formatConflictDetail(conflict: ConflictSet): string {
		const parts: string[] = [];

		if (conflict.base) {
			parts.push(`BASE: "${this.truncate(conflict.base.text, 80)}"`);
		}

		if (conflict.local) {
			const status = conflict.local.completed ? "✓" : "○";
			parts.push(`LOCAL: "${this.truncate(conflict.local.text, 80)}" ${status}`);
		} else {
			parts.push("LOCAL: [DELETED]");
		}

		if (conflict.remote) {
			const status = conflict.remote.completed ? "✓" : "○";
			parts.push(`REMOTE: "${this.truncate(conflict.remote.text, 80)}" ${status}`);
		} else {
			parts.push("REMOTE: [DELETED]");
		}

		return parts.join(" | ");
	}

	/**
	 * Truncate text to specified length
	 */
	private static truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text;
		}
		return text.substring(0, maxLength - 3) + "...";
	}

	/**
	 * Format full todo text for detail field (no truncation)
	 * Shows the complete text with metadata
	 */
	private static formatFullTodoText(todo: Todo): string {
		const parts: string[] = [];

		// Status and metadata
		if (todo.completed) {
			parts.push("✓ Completed");
			if (todo.completionDate) {
				parts.push(`on ${new Date(todo.completionDate).toLocaleDateString()}`);
			}
		} else {
			parts.push("○ Incomplete");
		}

		if (todo.isNote) {
			parts.push("| 📝 Note");
		}

		if (todo.isMarkdown) {
			parts.push("| Markdown");
		}

		const metadata = parts.join(" ");
		const charCount = `(${todo.text.length} chars)`;

		// Return full text with metadata
		return `${metadata} ${charCount}\n\n${todo.text}`;
	}

	/**
	 * Show a diff comparison in the editor for a conflict
	 * Creates temporary virtual documents and uses VS Code's diff view
	 */
	private static async showDiffInEditor(conflict: ConflictSet): Promise<void> {
		const localContent = conflict.local?.text || "[DELETED]";
		const remoteContent = conflict.remote?.text || "[DELETED]";

		try {
			// Determine language based on whether it's markdown
			const isMarkdown = conflict.local?.isMarkdown || conflict.remote?.isMarkdown || false;
			const language = isMarkdown ? "markdown" : "plaintext";

			// Create temporary documents with full content
			const localDoc = await vscode.workspace.openTextDocument({
				content: `${this.formatConflictHeader("LOCAL", conflict.local)}\n\n${localContent}`,
				language: language,
			});

			const remoteDoc = await vscode.workspace.openTextDocument({
				content: `${this.formatConflictHeader("REMOTE", conflict.remote)}\n\n${remoteContent}`,
				language: language,
			});

			// Show the diff (this opens a single diff editor tab)
			await vscode.commands.executeCommand(
				"vscode.diff",
				localDoc.uri,
				remoteDoc.uri,
				`Local ↔ Remote`,
				{
					preview: true,
					preserveFocus: false,
				}
			);
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to open diff view: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Format a header for diff view documents
	 */
	private static formatConflictHeader(label: string, todo: Todo | null): string {
		if (!todo) {
			return `=== ${label}: [DELETED] ===`;
		}

		const status = todo.completed ? "✓ Completed" : "○ Incomplete";
		const type = todo.isNote ? "📝 Note" : "Task";
		const format = todo.isMarkdown ? "Markdown" : "Plain Text";

		return `=== ${label}: ${status} | ${type} | ${format} ===`;
	}
}
