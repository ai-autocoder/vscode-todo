/**
 * Conflict Resolution UI
 * Enhanced per-item conflict resolution using multi-step QuickPick
 *
 * This is the extension's {@link ConflictResolver}: it turns the conflicts a reconcile found
 * into a {@link ConflictDecisions} the shared {@link GistSyncEngine} applies. It returns
 * *decisions*, not a finished todo list — an earlier version returned the list, and because a
 * three-way merge deliberately leaves conflicting ids out of its auto-merged output, every
 * conflict the user did not explicitly resolve was absent from the uploaded result and deleted
 * on both devices. Decisions are sparse by design: anything left undecided falls back to the
 * engine's policy (prefer-local), so "decide later" means the local version stands and the
 * conflict is presented again, rather than the item disappearing.
 */

import * as vscode from "vscode";
import { Todo } from "../todo/todoTypes";
import {
	ConflictDecisions,
	ConflictSet,
	FileConflictSet,
	generateUniqueId,
	resolveFileConflict,
} from "../core";
import { getGistId } from "../utilities/syncConfig";

/**
 * Result of user's conflict resolution choices.
 *
 * `keep-both` only applies to `id-collision`, where the two todos are independent items that
 * happen to share a random id rather than two versions of one item.
 */
export interface ConflictResolution {
	conflictId: number;
	resolution: "local" | "remote" | "keep-both" | "skip";
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
	 * Ask the user about everything one reconcile found, todo- and file-level.
	 *
	 * Returns null when the user backs out, which aborts the reconcile: nothing is written and
	 * the same decision comes back on the next sync.
	 *
	 * @param conflicts - Todo-level conflicts
	 * @param fileConflicts - Per-file list conflicts (workspace scope; empty for the user scope)
	 * @param knownIds - Ids already in play, so a keep-both copy can pick a free one
	 */
	static async resolve(
		conflicts: ConflictSet[],
		fileConflicts: FileConflictSet[],
		knownIds: number[]
	): Promise<ConflictDecisions | null> {
		// Todos first, then files. The order matters: either half can abort the whole reconcile
		// (the user backs out, or skips every conflict), and asking the coarse file question first
		// meant an abort in the todo wizard threw away answers the user had already given. Nothing
		// is applied until both halves return, so the cheaper-to-re-answer half goes last.
		let todoDecisions: ConflictDecisions = {};
		if (conflicts.length > 0) {
			const decided = await this.resolveTodoConflicts(conflicts, knownIds);
			if (!decided) {
				return null;
			}
			todoDecisions = decided;
		}

		if (fileConflicts.length === 0) {
			return todoDecisions;
		}

		const fileDecisions = await this.resolveFileConflicts(fileConflicts);
		if (!fileDecisions) {
			return null;
		}
		return { ...todoDecisions, files: fileDecisions };
	}

	/**
	 * The file-level question. Resolved through `resolveFileConflict` rather than by storing the
	 * chosen side's array: within one file only the genuinely conflicting ids are the choice's to
	 * decide, and taking the raw array would also discard every todo the other device added to
	 * that file — items the user was never shown and never chose to discard.
	 */
	private static async resolveFileConflicts(
		fileConflicts: FileConflictSet[]
	): Promise<Map<string, Todo[] | null> | null> {
		const paths = fileConflicts.map((conflict) => conflict.filePath).join(", ");
		const choice = await vscode.window.showWarningMessage(
			`Workspace Sync: ${fileConflicts.length} file list conflict(s) detected.`,
			{ modal: true, detail: `Affected files: ${paths}` },
			"Keep Local Files",
			"Keep Remote Files",
			"View Gist"
		);

		if (choice === "View Gist") {
			await this.openGist();
			return null;
		}

		// Dismissing the dialog aborts rather than silently choosing. Escape must not be a
		// destructive answer to a destructive question.
		if (choice !== "Keep Local Files" && choice !== "Keep Remote Files") {
			return null;
		}

		const prefer = choice === "Keep Local Files" ? "local" : "remote";
		const decided = new Map<string, Todo[] | null>();
		for (const conflict of fileConflicts) {
			decided.set(conflict.filePath, resolveFileConflict(conflict, prefer));
		}
		return decided;
	}

	private static async resolveTodoConflicts(
		conflicts: ConflictSet[],
		knownIds: number[]
	): Promise<ConflictDecisions | null> {
		// Step 1: Overview and choice of resolution mode
		const mode = await this.showOverview(conflicts);
		if (!mode) {
			return null;
		}

		if (mode === "all-local" || mode === "all-remote") {
			const side = mode === "all-local" ? "local" : "remote";
			const todos = new Map<number, Todo | null>();
			for (const conflict of conflicts) {
				todos.set(conflict.todoId, side === "local" ? conflict.local : conflict.remote);
			}
			return { todos };
		}

		// View gist in browser
		if (mode === "view-gist") {
			await this.openGist();
			return null;
		}

		// Per-item resolution mode
		if (mode === "per-item") {
			const result = await this.resolvePerItem(conflicts);
			if (!result || result.cancelled) {
				return null;
			}
			return this.applyResolutions(conflicts, result.resolutions, knownIds);
		}

		return null;
	}

	private static async openGist(): Promise<void> {
		const gistId = getGistId();
		if (gistId) {
			await vscode.env.openExternal(vscode.Uri.parse(`https://gist.github.com/${gistId}`));
		}
	}

	/**
	 * Step 1: Show overview and resolution mode selection
	 */
	private static async showOverview(conflicts: ConflictSet[]): Promise<string | null> {
		const collisions = conflicts.filter((c) => c.conflictType === "id-collision").length;

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

		// Items with no common history are called out because a batch choice may be the wrong tool
		// for them: if two devices independently created items that drew the same id, "keep all
		// local" throws a real item away. Per-item offers Keep Both for those.
		const placeHolder =
			collisions > 0
				? `${conflicts.length} conflict(s), ${collisions} with no shared history. Resolve those individually`
				: `${conflicts.length} conflict(s) to resolve`;

		const selected = await vscode.window.showQuickPick(items, {
			title: "Sync Conflict Detected",
			placeHolder,
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
	): Promise<"local" | "remote" | "keep-both" | "skip" | "back" | "cancel" | "view-diff"> {
		const conflictDetail = this.formatConflictDetail(conflict);

		const items: Array<{
			label: string;
			description: string;
			detail: string;
			value: "local" | "remote" | "keep-both" | "skip" | "back" | "view-diff";
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
		];

		// `id-collision` means only "this merge had no common ancestor for this id" — the two
		// sides may be independently created items that drew the same random id, in which case
		// picking a side destroys a real item, OR simply two versions of one item seen without a
		// baseline (a first sync, or a scope just switched to GitHub, merges against an empty
		// base and labels every differing shared id this way). Nothing in the data distinguishes
		// them, so offer Keep Both without claiming which it is and without recommending it.
		if (conflict.conflictType === "id-collision" && conflict.local && conflict.remote) {
			items.push({
				label: "$(diff-added) Keep Both",
				description: "If these are two different items, not two versions of one",
				detail:
					"Keeps this device's item and adds the other device's as a separate item. " +
					"Choose this only if the two texts are unrelated; otherwise you get a duplicate.",
				value: "keep-both",
			});
		}

		items.push(
			{
				label: "$(diff) View Full Diff",
				description: "Open side-by-side comparison",
				detail: "Compare local and remote versions in editor",
				value: "view-diff",
			},
			{
				label: "$(debug-step-over) Skip This Conflict",
				description: "Decide later",
				detail: "Keeps this device's version for now; you'll be prompted again next sync",
				value: "skip",
			}
		);

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
			ignoreFocusOut: true,
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

		// Every conflict skipped: there is nothing to apply, so abort the reconcile rather than
		// push. Aborting leaves the baseline untouched, which is what makes the same conflicts
		// come back next sync — the promise the Skip option makes.
		if (skipped === conflicts.length) {
			vscode.window.showWarningMessage(
				"All conflicts skipped. Nothing was synced: this device's versions are unchanged and you'll be asked again next sync."
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
				} else if (r.resolution === "keep-both") {
					text += `Keep Both: ${this.truncate(conflict.local?.text || "", 20)} + ${this.truncate(
						conflict.remote?.text || "",
						20
					)}`;
				} else {
					text += `SKIPPED (keeps this device's version for now): ${this.truncate(
						conflict.local?.text || conflict.remote?.text || "",
						40
					)}`;
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
		resolutions: ConflictResolution[],
		knownIds: number[]
	): ConflictDecisions {
		const todos = new Map<number, Todo | null>();
		// Keyed by the conflict each copy came from, so the engine can place it next to that item
		// instead of at the bottom of the list.
		const extraTodos = new Map<number, Todo[]>();
		// Ids handed out here must not collide with each other either, so the pool grows as we go.
		const pool = knownIds.map((id) => ({ id }));

		for (const resolution of resolutions) {
			const conflict = conflicts.find((c) => c.todoId === resolution.conflictId);
			if (!conflict) {
				continue;
			}

			// A skipped conflict is deliberately left OUT of the map: an absent key means "no
			// decision", which the engine settles with its prefer-local policy. Recording it as
			// null instead would mean "delete this item", and returning a list rather than a map —
			// what this used to do — dropped the item entirely, deleting it on both devices under
			// a menu entry that promised to ask again.
			if (resolution.resolution === "skip") {
				continue;
			}

			if (resolution.resolution === "local") {
				todos.set(conflict.todoId, conflict.local);
			} else if (resolution.resolution === "remote") {
				todos.set(conflict.todoId, conflict.remote);
			} else if (resolution.resolution === "keep-both" && conflict.local && conflict.remote) {
				// This device's item keeps the contested id; the other device's is re-added under a
				// fresh one. Both survive, which for an id collision is the only non-destructive
				// answer — see resolveOneConflict.
				todos.set(conflict.todoId, conflict.local);
				const newId = generateUniqueId(pool);
				pool.push({ id: newId });
				extraTodos.set(conflict.todoId, [
					...(extraTodos.get(conflict.todoId) ?? []),
					{ ...conflict.remote, id: newId },
				]);
			}
		}

		return extraTodos.size > 0 ? { todos, extraTodos } : { todos };
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
			const status = conflict.local.isNote ? "" : conflict.local.completed ? "✓" : "○";
			const statusSuffix = status ? ` ${status}` : "";
			parts.push(`LOCAL: "${this.truncate(conflict.local.text, 80)}"${statusSuffix}`);
		} else {
			parts.push("LOCAL: [DELETED]");
		}

		if (conflict.remote) {
			const status = conflict.remote.isNote ? "" : conflict.remote.completed ? "✓" : "○";
			const statusSuffix = status ? ` ${status}` : "";
			parts.push(`REMOTE: "${this.truncate(conflict.remote.text, 80)}"${statusSuffix}`);
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
		if (!todo.isNote) {
			if (todo.completed) {
				parts.push("Status: Completed");
				if (todo.completionDate) {
					parts.push(`on ${new Date(todo.completionDate).toLocaleDateString()}`);
				}
			} else {
				parts.push("Status: Incomplete");
			}
		}

		if (todo.isNote) {
			parts.push("📝 Note");
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

		const status = todo.completed ? "Status: Completed" : "Status: Incomplete";
		const type = todo.isNote ? "📝 Note" : "Task";
		const format = todo.isMarkdown ? "Markdown" : "Plain Text";

		return `=== ${label}: ${status} | ${type} | ${format} ===`;
	}
}
