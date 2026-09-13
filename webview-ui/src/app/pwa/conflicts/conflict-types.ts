/**
 * Pending sync conflicts, as surfaced to the user in the PWA.
 *
 * These are the conflicts the sync settled *without* the user saying so: the ones the up-front
 * prompt was shown but left undecided, and the ones nobody could be asked about (the page was
 * hidden, or a re-merge against a mid-flight edit found them after the dialog had closed). The
 * engine has already applied its prefer-local policy and pushed the result by the time
 * {@link GistGateway} records them, so they do not gate the sync: they exist to make a decision
 * that was already taken *visible and reversible*. Reversing one is an ordinary local edit plus
 * a push, not a special sync path.
 *
 * The prompt that runs *before* a write is {@link ConflictPromptRequest}, below.
 *
 * PWA-only: nothing here is reachable from the extension webview build.
 */

import type { ConflictSet, FileConflictSet, Todo } from "@vsc-todo/core";

/**
 * Scope a conflict belongs to. Per-file lists live inside the workspace gist file and are
 * reported separately as file conflicts, keyed by path rather than by todo id.
 */
export type ConflictScope = "user" | "workspace";

/** Which device's version a choice refers to. */
export type ConflictSide = "local" | "remote";

/**
 * What the sync engine is asking about, handed to the up-front prompt.
 *
 * Mirrors the argument of the core `ConflictResolver` hook. A reconcile is blocked on the answer
 * while this is on screen: nothing has been written, and the conflicts here are raw merge output,
 * not the {@link PendingConflict} records the review screen shows after the fact.
 */
export interface ConflictPromptRequest {
	todos: ConflictSet[];
	files: FileConflictSet[];
	/** Every todo id the merge saw, so a keep-both copy can draw an id nothing else uses. */
	knownIds: number[];
}

/**
 * Todo fields a per-field merge can pick sides on.
 *
 * `completionDate` is derived from `completed` and travels with it; `collapsed` is a per-device
 * view preference. Neither is worth asking about, so neither is offered.
 */
export const MERGEABLE_FIELDS = ["text", "completed", "isNote", "isMarkdown", "tags"] as const;
export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

/** A conflict on a single todo in the user or workspace list. */
export interface PendingTodoConflict {
	kind: "todo";
	/** Identity key — a fresh conflict on the same todo replaces the pending one. */
	key: string;
	scope: ConflictScope;
	todoId: number;
	/**
	 * `id-collision` never reaches here: two todos created independently that happened to draw
	 * the same id are not versions of each other, so the gateway keeps both automatically and
	 * records a {@link KeptBothConflict} instead.
	 */
	conflictType: "edit-edit" | "edit-delete" | "delete-edit";
	base: Todo | null;
	local: Todo | null;
	remote: Todo | null;
	/** What the engine actually applied and pushed. Mirrors `local` under prefer-local. */
	resolvedValue: Todo | null;
	syncedAt: string;
}

/**
 * A per-file list that changed on both sides in a way the merge could not settle by itself.
 *
 * The record is keyed by path and its two sides are whole `Todo[]` lists, but they are not the
 * raw arrays from either device: the merge settles per todo, so both sides already contain every
 * addition either device made to the file and differ only on the todos genuinely in dispute.
 * `local` is what the engine applied under prefer-local; `remote` is what choosing the other
 * device would apply. Choosing therefore swaps the disputed todos, and does not discard the
 * other device’s work.
 */
export interface PendingFileConflict {
	kind: "file";
	key: string;
	filePath: string;
	conflictType: "file-added-both" | "file-edit-edit" | "file-edit-delete" | "file-delete-edit";
	base: Todo[] | null;
	local: Todo[] | null;
	remote: Todo[] | null;
	resolvedValue: Todo[] | null;
	syncedAt: string;
}

/**
 * An id collision that was resolved by keeping both sides. Informational: the other device's
 * todo has already been re-added under {@link newId}, so the only action left is undoing that.
 */
export interface KeptBothConflict {
	kind: "kept-both";
	key: string;
	scope: ConflictScope;
	/** The id both devices independently drew. Kept by the local todo. */
	todoId: number;
	local: Todo;
	/** The other device's todo, as re-added under `newId`. */
	remote: Todo;
	newId: number;
	syncedAt: string;
}

export type PendingConflict = PendingTodoConflict | PendingFileConflict | KeptBothConflict;

/**
 * A pending conflict plus what the local list holds for it *now*.
 *
 * `stale` means the user edited or deleted the item after the sync resolved it, so applying the
 * other device's version would silently discard that later edit. The review UI flags it and the
 * gateway re-checks at apply time.
 */
export interface PendingConflictView {
	conflict: PendingConflict;
	stale: boolean;
}

/** Identity key for a todo-level record, so a later conflict supersedes an unreviewed one. */
export function todoConflictKey(scope: ConflictScope, todoId: number): string {
	return `${scope}:${todoId}`;
}

/** Identity key for a file-level record. Namespaced so it cannot collide with a todo key. */
export function fileConflictKey(filePath: string): string {
	return `file:${filePath}`;
}

/**
 * Outcome of applying a review choice. `"stale"` means local state changed after the sync
 * resolved the conflict, so the caller must confirm before the choice is forced through.
 */
export type ConflictApplyResult = "applied" | "stale" | "missing";
