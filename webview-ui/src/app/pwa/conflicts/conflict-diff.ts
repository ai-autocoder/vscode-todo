/**
 * Pure helpers behind the conflict review screen: how a conflict is described, which fields the
 * two sides disagree on, and how a per-field pick is turned back into a todo.
 *
 * Deliberately free of Angular and of {@link GistGateway} so the merge rules can be tested
 * directly. PWA-only.
 */

import { isEqual, type Todo } from "@vsc-todo/core";
import {
	MERGEABLE_FIELDS,
	type ConflictSide,
	type MergeableField,
	type PendingConflict,
	type PendingTodoConflict,
} from "./conflict-types";

/** One field the two versions disagree on, with both values already formatted for display. */
export interface FieldDiff {
	field: MergeableField;
	label: string;
	localText: string;
	remoteText: string;
}

const FIELD_LABELS: Record<MergeableField, string> = {
	text: "Text",
	completed: "Status",
	isNote: "Kind",
	isMarkdown: "Formatting",
	tags: "Tags",
};

/** Short sentence naming what happened, used as the card's headline. */
export function describeConflict(conflict: PendingConflict): string {
	if (conflict.kind === "kept-both") {
		return "Two different items with the same id";
	}
	if (conflict.kind === "file") {
		switch (conflict.conflictType) {
			case "file-added-both":
				return "This file's list was started on both devices";
			case "file-edit-edit":
				return "This file's list changed on both devices";
			case "file-edit-delete":
				return "Changed here, removed on the other device";
			case "file-delete-edit":
				return "Removed here, changed on the other device";
		}
	}
	switch (conflict.conflictType) {
		case "edit-edit":
			return "Edited on both devices";
		case "edit-delete":
			return "Edited here, deleted on the other device";
		case "delete-edit":
			return "Deleted here, edited on the other device";
	}
}

/**
 * Per-field merging only means anything when there are two versions to take fields from. With a
 * deletion on one side there is exactly one version and a removal — nothing to interleave.
 */
export function canMergeFields(conflict: PendingConflict): conflict is PendingTodoConflict {
	return conflict.kind === "todo" && conflict.conflictType === "edit-edit";
}

/** The fields whose values differ between the two versions, in a stable display order. */
export function fieldDiffs(local: Todo, remote: Todo): FieldDiff[] {
	const diffs: FieldDiff[] = [];
	for (const field of MERGEABLE_FIELDS) {
		const localText = formatField(field, local);
		const remoteText = formatField(field, remote);
		if (localText !== remoteText) {
			diffs.push({ field, label: FIELD_LABELS[field], localText, remoteText });
		}
	}
	return diffs;
}

/** Renders one field for display — also the comparison key, so equal text means equal value. */
export function formatField(field: MergeableField, todo: Todo): string {
	switch (field) {
		case "text":
			return todo.text;
		case "completed":
			return todo.completed ? "Done" : "Not done";
		case "isNote":
			return todo.isNote ? "Note" : "Task";
		case "isMarkdown":
			return todo.isMarkdown ? "Markdown" : "Plain text";
		case "tags":
			return todo.tags?.length ? todo.tags.join(", ") : "No tags";
	}
}

/**
 * Builds the todo a per-field merge produces. Starts from the local version — the one already
 * in the list — and takes only the fields the user assigned to the other device, so a field
 * nobody chose to move keeps the value that is on screen.
 *
 * `completionDate` is not offered as a choice but must travel with `completed`, or a todo can
 * end up marked done with the other device's completion timestamp (or none at all).
 */
export function mergeTodoFields(
	local: Todo,
	remote: Todo,
	picks: Partial<Record<MergeableField, ConflictSide>>
): Todo {
	const merged: Todo = { ...local };
	for (const field of MERGEABLE_FIELDS) {
		if (picks[field] !== "remote") {
			continue;
		}
		switch (field) {
			case "text":
				merged.text = remote.text;
				break;
			case "completed":
				merged.completed = remote.completed;
				merged.completionDate = remote.completionDate;
				break;
			case "isNote":
				merged.isNote = remote.isNote;
				break;
			case "isMarkdown":
				merged.isMarkdown = remote.isMarkdown;
				break;
			case "tags":
				merged.tags = remote.tags;
				break;
		}
	}
	// JSON round-trips drop undefined anyway, but an explicit key with no value reads as data
	// in IndexedDB dumps and in the gist diff. Keep the shape clean.
	if (merged.completionDate === undefined) {
		delete merged.completionDate;
	}
	if (merged.tags === undefined) {
		delete merged.tags;
	}
	return merged;
}

/**
 * Whether the local list has moved on since the sync resolved this conflict — the user edited
 * or deleted the item afterwards. Applying the other device's version would then discard that
 * later edit, so the review screen warns and asks for a second tap.
 */
export function isValueStale<T extends Todo | Todo[]>(
	resolved: T | null,
	current: T | null
): boolean {
	if (resolved === null || current === null) {
		return resolved !== current;
	}
	return !isEqual(resolved, current);
}
