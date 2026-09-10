import { Todo, TodoFilesData, TodoFilesDataPaths } from "./todoTypes";
import { isEqual, normalizeAbsolutePath, normalizeRelativePath } from "./pure";
import { WorkspaceMergeResult, FileConflictSet } from "./syncTypes";

/**
 * Result of a three-way merge operation
 */
export interface MergeResult {
	/** Todos that were successfully auto-merged, in {@link order}. */
	autoMerged: Todo[];
	/** Conflicts that require user resolution */
	conflicts: ConflictSet[];
	/**
	 * The merged list's ordering, as todo ids — including the conflicted ones, which hold their
	 * slot even though no version of them is chosen yet.
	 *
	 * This is the skeleton the final list must be built on: feed it, plus whatever settled the
	 * conflicts, to {@link assembleMerged}. Rebuilding from any other order (the base array, say)
	 * appends every addition at the bottom and undoes every reorder either side made.
	 */
	order: number[];
}

/**
 * Represents a conflict between local and remote changes
 */
export interface ConflictSet {
	/** The ID of the conflicting todo */
	todoId: number;
	/** The base version (from lastCleanRemoteData), null if didn't exist in base */
	base: Todo | null;
	/** The local version, null if deleted locally */
	local: Todo | null;
	/** The remote version, null if deleted remotely */
	remote: Todo | null;
	/** Type of conflict detected */
	conflictType: "edit-edit" | "edit-delete" | "delete-edit" | "id-collision";
}

/**
 * Performs a three-way merge of todo lists using ID-based comparison.
 * Preserves the original positional ordering from both local and remote arrays.
 *
 * Algorithm:
 * - Compares base (lastCleanRemoteData) vs local vs remote
 * - Auto-merges non-conflicting changes
 * - Preserves positional intent from both local and remote
 * - Returns conflicts only when true overlaps exist
 *
 * Ordering rule: **local order is the skeleton**, and items only the remote holds are spliced in
 * next to the neighbours they have there. Local order wins because it is the arrangement the
 * user of this device last saw and made — including a fresh todo at the top, which is where
 * `createPosition: top` puts it. Nothing detects "both devices reordered the same items", and
 * nothing should: with no per-item position in the data model the two orders cannot be merged,
 * only picked between, and picking the one in front of the user is the answer that never
 * surprises. The other device's arrangement is not lost so much as superseded — its next sync
 * pulls this order down, and both peers converge on it.
 *
 * @param base - The last known clean remote state (baseline for comparison)
 * @param local - Current local state (may include uncommitted changes)
 * @param remote - Current remote state (fetched from gist)
 * @returns MergeResult with auto-merged todos and any conflicts
 */
export function threeWayMerge(base: Todo[], local: Todo[], remote: Todo[]): MergeResult {
	const baseMap = new Map(base.map((t) => [t.id, t]));
	const localMap = new Map(local.map((t) => [t.id, t]));
	const remoteMap = new Map(remote.map((t) => [t.id, t]));

	const conflicts: ConflictSet[] = [];
	const processedIds = new Set<number>();

	// First pass: Analyze all todos to find conflicts
	const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

	for (const id of allIds) {
		const baseTodo = baseMap.get(id);
		const localTodo = localMap.get(id);
		const remoteTodo = remoteMap.get(id);

		const inBase = !!baseTodo;
		const inLocal = !!localTodo;
		const inRemote = !!remoteTodo;

		// CASE 3: In base and local, not remote (deleted remotely)
		if (inBase && inLocal && !inRemote) {
			const localModified = !isEqual(baseTodo, localTodo);
			if (localModified) {
				// CONFLICT: edit-delete (local edited, remote deleted)
				conflicts.push({
					todoId: id,
					base: baseTodo,
					local: localTodo,
					remote: null,
					conflictType: "edit-delete",
				});
				processedIds.add(id);
			}
			// else: accept deletion (will be excluded from result)
			continue;
		}

		// CASE 4: In base and remote, not local (deleted locally)
		if (inBase && !inLocal && inRemote) {
			const remoteModified = !isEqual(baseTodo, remoteTodo);
			if (remoteModified) {
				// CONFLICT: delete-edit (local deleted, remote edited)
				conflicts.push({
					todoId: id,
					base: baseTodo,
					local: null,
					remote: remoteTodo,
					conflictType: "delete-edit",
				});
				processedIds.add(id);
			}
			// else: accept deletion (will be excluded from result)
			continue;
		}

		// CASE 5: In local and remote, not base (added on both sides)
		if (!inBase && inLocal && inRemote) {
			if (!isEqual(localTodo, remoteTodo)) {
				// CONFLICT: ID collision (same ID, different content)
				conflicts.push({
					todoId: id,
					base: null,
					local: localTodo,
					remote: remoteTodo,
					conflictType: "id-collision",
				});
				processedIds.add(id);
			}
			// else: same content, will be added once during position-aware merge
			continue;
		}

		// CASE 6: In all three (potential edit-edit)
		if (inBase && inLocal && inRemote) {
			const localModified = !isEqual(baseTodo, localTodo);
			const remoteModified = !isEqual(baseTodo, remoteTodo);

			if (localModified && remoteModified && !isEqual(localTodo, remoteTodo)) {
				// CONFLICT: edit-edit (different changes to same todo)
				conflicts.push({
					todoId: id,
					base: baseTodo,
					local: localTodo,
					remote: remoteTodo,
					conflictType: "edit-edit",
				});
				processedIds.add(id);
			}
			// else: one side changed or both made same change, will be merged
			continue;
		}
	}

	// Second pass: Build the position-aware ordering, and the item settled at each slot.
	//
	// A conflicted id takes a slot here too, with no item behind it: whatever settles the
	// conflict later has to land where the item actually sits, not at the bottom of the list.
	const settled = new Map<number, Todo>();
	const order: number[] = [];
	const placed = new Set<number>();

	// Walk through local array to preserve local positions and additions
	for (const localTodo of local) {
		const id = localTodo.id;

		// One slot per id. A list holding the same id twice is malformed — nothing this app
		// writes can produce it, but a hand-edited gist can — and without this the second copy
		// would overwrite the first in `settled` while keeping both slots, so the merged list
		// would carry that todo twice and the other one not at all.
		if (placed.has(id)) {
			continue;
		}

		if (processedIds.has(id)) {
			// Conflicted: reserve the slot, leave the item for `assembleMerged`.
			order.push(id);
			placed.add(id);
			continue;
		}

		const baseTodo = baseMap.get(id);
		const remoteTodo = remoteMap.get(id);

		if (!baseTodo && !remoteTodo) {
			// CASE 1: Only in local (added locally) - preserve local position
			settled.set(id, localTodo);
		} else if (baseTodo && remoteTodo) {
			// CASE 6: In all three - check which version to use
			const remoteModified = !isEqual(baseTodo, remoteTodo);
			settled.set(id, remoteModified ? remoteTodo : localTodo);
		} else if (baseTodo && !remoteTodo) {
			// CASE 3a: Deleted remotely, local unchanged - accept the deletion, claim no slot
			continue;
		} else {
			// CASE 5a: Added on both sides with same content - add once
			settled.set(id, localTodo);
		}

		order.push(id);
		placed.add(id);
	}

	// Walk through remote array to add remote-only items, preserving remote positions
	for (let i = 0; i < remote.length; i++) {
		const remoteTodo = remote[i];
		const id = remoteTodo.id;

		if (placed.has(id)) {
			continue; // Already placed by the local walk
		}

		const baseTodo = baseMap.get(id);
		const localTodo = localMap.get(id);
		// A conflict the local side has no version of (delete-edit) reaches this walk unplaced.
		// It gets a slot by its remote neighbours, exactly like a remote-only addition, so a
		// resolution that revives it lands where the remote has it rather than at the end.
		const conflicted = processedIds.has(id);

		if (!conflicted && (baseTodo || localTodo)) {
			// CASE 4a: Deleted locally, remote unchanged - already handled, skip
			continue;
		}

		// CASE 2: Only in remote (added remotely) - preserve remote position
		// Find insertion index based on surrounding items in remote array
		const insertIndex = findInsertionIndex(order, remote, i, placed);
		order.splice(insertIndex, 0, id);
		placed.add(id);
		if (!conflicted) {
			settled.set(id, remoteTodo);
		}
	}

	const autoMerged = order.flatMap((id) => {
		const todo = settled.get(id);
		return todo ? [todo] : [];
	});

	return { autoMerged, conflicts, order };
}

/**
 * Finds the appropriate insertion index for a remote-only item
 * based on its surrounding items (anchors) in the remote array
 *
 * @param order - Ordering built so far, as todo ids
 * @param remote - Remote array
 * @param remoteIndex - Index of item to insert in remote array
 * @param placed - Set of IDs already in `order`
 * @returns Index where the item should be inserted
 */
function findInsertionIndex(
	order: number[],
	remote: Todo[],
	remoteIndex: number,
	placed: Set<number>
): number {
	// Find the closest previous item in remote that is already placed (anchor before)
	let prevAnchorId: number | null = null;
	for (let i = remoteIndex - 1; i >= 0; i--) {
		if (placed.has(remote[i].id)) {
			prevAnchorId = remote[i].id;
			break;
		}
	}

	// Find the closest next item in remote that is already placed (anchor after)
	let nextAnchorId: number | null = null;
	for (let i = remoteIndex + 1; i < remote.length; i++) {
		if (placed.has(remote[i].id)) {
			nextAnchorId = remote[i].id;
			break;
		}
	}

	// Find positions of anchors in the ordering
	let prevAnchorIndex = -1;
	let nextAnchorIndex = order.length;

	if (prevAnchorId !== null) {
		prevAnchorIndex = order.indexOf(prevAnchorId);
	}

	if (nextAnchorId !== null) {
		nextAnchorIndex = order.indexOf(nextAnchorId);
	}

	// Insert after the previous anchor (or at the beginning if no prev anchor)
	// and before the next anchor (or at the end if no next anchor)
	if (prevAnchorIndex >= 0) {
		// Insert after prev anchor, but before next anchor if it exists
		const insertPos = prevAnchorIndex + 1;
		// Make sure we don't go past the next anchor
		if (nextAnchorIndex >= 0 && insertPos > nextAnchorIndex) {
			return nextAnchorIndex;
		}
		return insertPos;
	} else if (nextAnchorIndex < order.length) {
		// No prev anchor, insert before next anchor
		return nextAnchorIndex;
	} else {
		// No anchors found, append at end (fallback)
		return order.length;
	}
}

/**
 * Formats a summary of the merge result for display to the user
 */
export function formatMergeSummary(result: MergeResult, base: Todo[]): string {
	const baseIds = new Set(base.map((t) => t.id));
	const mergedIds = new Set(result.autoMerged.map((t) => t.id));

	const added = result.autoMerged.filter((t) => !baseIds.has(t.id));
	const deleted = base.filter((t) => !mergedIds.has(t.id));
	const modified = result.autoMerged.filter((t) => {
		if (!baseIds.has(t.id)) {
			return false;
		}
		const baseTodo = base.find((b) => b.id === t.id);
		return !isEqual(baseTodo!, t);
	});

	const parts: string[] = [];
	if (added.length > 0) {
		parts.push(`${added.length} added`);
	}
	if (modified.length > 0) {
		parts.push(`${modified.length} modified`);
	}
	if (deleted.length > 0) {
		parts.push(`${deleted.length} deleted`);
	}

	return parts.length > 0 ? parts.join(", ") : "No changes";
}

/**
 * Builds the final list from a merge and whatever settled its conflicts, on the merge's own
 * {@link MergeResult.order}.
 *
 * The ordering is the merge's, not the base's. This used to rebuild from the base array — base
 * order first, everything else appended — which threw away the position-aware order the merge
 * had just worked out: every addition landed at the bottom however the user had asked for them
 * to be created, and any drag-and-drop reorder on either device was undone the next time a sync
 * had to merge. The base is the one order that is certainly stale, since it is by definition
 * what both sides have since changed.
 *
 * @param merge - The merge whose `order` and `autoMerged` items form the skeleton
 * @param resolved - The winning version per conflicted id; an id left out is one no side kept
 * @param extras - Extra copies to keep, keyed by the conflict they were raised from; each lands
 *   directly after that item, which is the only place a "keep both" reads as a pair
 * @returns Final merged array
 */
export function assembleMerged(
	merge: MergeResult,
	resolved: Map<number, Todo>,
	extras?: Map<number, Todo[]>
): Todo[] {
	const auto = new Map(merge.autoMerged.map((t) => [t.id, t]));
	const result: Todo[] = [];
	const emitted = new Set<number>();

	const emit = (todo: Todo): void => {
		if (emitted.has(todo.id)) {
			return;
		}
		result.push(todo);
		emitted.add(todo.id);
	};

	for (const id of merge.order) {
		// A conflicted id with no entry in `resolved` is one whose winning side deleted it, so
		// the slot simply goes unfilled and the deletion stands.
		const todo = resolved.get(id) ?? auto.get(id);
		if (todo) {
			emit(todo);
		}
		for (const extra of extras?.get(id) ?? []) {
			emit(extra);
		}
	}

	// Anything keyed to an id this merge never saw still has to land somewhere: a resolver is
	// free to hand back items of its own, and dropping them here would delete them silently.
	for (const todo of resolved.values()) {
		emit(todo);
	}
	for (const list of extras?.values() ?? []) {
		for (const todo of list) {
			emit(todo);
		}
	}

	return result;
}

/**
 * Performs a three-way merge of workspace data including both workspaceTodos and filesData.
 *
 * Algorithm:
 * - Merges workspaceTodos array using standard threeWayMerge
 * - Merges filesData dictionary by:
 *   1. Finding all file paths across base, local, and remote
 *   2. For each file path, performing three-way merge on its todo array
 *   3. Detecting file-level conflicts (file added/deleted/modified in conflicting ways)
 *
 * @returns WorkspaceMergeResult with auto-merged data and any conflicts
 */
export function threeWayMergeWorkspace(
	baseWorkspaceTodos: Todo[],
	localWorkspaceTodos: Todo[],
	remoteWorkspaceTodos: Todo[],
	baseFilesData: TodoFilesData,
	localFilesData: TodoFilesData,
	remoteFilesData: TodoFilesData,
	baseFilesDataPaths: TodoFilesDataPaths,
	localFilesDataPaths: TodoFilesDataPaths,
	remoteFilesDataPaths: TodoFilesDataPaths
): WorkspaceMergeResult {
	// Merge workspace todos using standard three-way merge
	const workspaceMergeResult = threeWayMerge(baseWorkspaceTodos, localWorkspaceTodos, remoteWorkspaceTodos);

	// Merge filesData dictionary
	const filesDataMergeResult = mergeFilesData(baseFilesData, localFilesData, remoteFilesData);
	const filesDataPathsMergeResult = mergeFilesDataPaths(
		baseFilesDataPaths,
		localFilesDataPaths,
		remoteFilesDataPaths
	);

	return {
		workspaceMerge: workspaceMergeResult,
		autoMergedFilesData: filesDataMergeResult.autoMerged,
		autoMergedFilesDataPaths: filesDataPathsMergeResult,
		fileConflicts: filesDataMergeResult.conflicts,
	};
}

/**
 * Merges the filesData dictionary (file paths -> todo arrays).
 *
 * @returns Merged files data and file-level conflicts
 */
export function mergeFilesData(
	base: TodoFilesData,
	local: TodoFilesData,
	remote: TodoFilesData
): { autoMerged: TodoFilesData; conflicts: FileConflictSet[] } {
	// Sorted so the merged object's key order depends only on which paths are present, never on
	// which side contributed them. `isEqual` compares serialized JSON, so an insertion-order
	// difference would otherwise read as a change and push identical content on every reconcile.
	// Sorting also matches how the extension writes this map (see sortByFileName).
	const allFilePaths = [
		...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]),
	].sort();

	const autoMerged: TodoFilesData = {};
	const conflicts: FileConflictSet[] = [];

	for (const filePath of allFilePaths) {
		const baseTodos = base[filePath] || null;
		const localTodos = local[filePath] || null;
		const remoteTodos = remote[filePath] || null;

		const inBase = baseTodos !== null;
		const inLocal = localTodos !== null;
		const inRemote = remoteTodos !== null;

		// CASE 1: File exists in all three - perform three-way merge on todos
		if (inBase && inLocal && inRemote) {
			const localModified = !isEqual(baseTodos, localTodos);
			const remoteModified = !isEqual(baseTodos, remoteTodos);

			if (localModified && remoteModified && !isEqual(localTodos, remoteTodos)) {
				// Both sides touched this file. Merge the todo arrays per item rather than treating
				// the file as one opaque value: two people adding a todo to the same file are not
				// in conflict, and whole-array resolution silently discarded whichever side lost.
				// Only genuinely conflicting todos (the same id edited differently on both sides)
				// escalate to a file conflict for the caller's policy to settle.
				// This is the only copy: both peers run it, so they cannot resolve the same
				// situation differently. (The extension used to ship its own, and they drifted.)
				const itemMerge = threeWayMerge(baseTodos, localTodos, remoteTodos);
				if (itemMerge.conflicts.length === 0) {
					autoMerged[filePath] = itemMerge.autoMerged;
				} else {
					// The per-item merge rides along on the conflict: it is what a resolution must be
					// built from, so the caller settles only the conflicting ids and keeps both sides’
					// additions to the file. Resolving from the raw local/remote arrays instead drops
					// the losing side’s additions, silently — see resolveFileConflict.
					conflicts.push({
						filePath,
						base: baseTodos,
						local: localTodos,
						remote: remoteTodos,
						conflictType: "file-edit-edit",
						itemMerge,
					});
				}
			} else if (remoteModified) {
				// Remote changed, local unchanged - use remote
				autoMerged[filePath] = remoteTodos;
			} else {
				// Local changed or both unchanged - use local
				autoMerged[filePath] = localTodos;
			}
			continue;
		}

		// CASE 2: File in base and local, not remote (deleted remotely)
		if (inBase && inLocal && !inRemote) {
			const localModified = !isEqual(baseTodos, localTodos);
			if (localModified) {
				// FILE CONFLICT: Local modified, remote deleted
				conflicts.push({
					filePath,
					base: baseTodos,
					local: localTodos,
					remote: null,
					conflictType: "file-edit-delete",
				});
			}
			// else: accept deletion (don't add to autoMerged)
			continue;
		}

		// CASE 3: File in base and remote, not local (deleted locally)
		if (inBase && !inLocal && inRemote) {
			const remoteModified = !isEqual(baseTodos, remoteTodos);
			if (remoteModified) {
				// FILE CONFLICT: Remote modified, local deleted
				conflicts.push({
					filePath,
					base: baseTodos,
					local: null,
					remote: remoteTodos,
					conflictType: "file-delete-edit",
				});
			}
			// else: accept deletion (don't add to autoMerged)
			continue;
		}

		// CASE 4: File in local and remote, not base (added on both sides)
		if (!inBase && inLocal && inRemote) {
			if (!isEqual(localTodos, remoteTodos)) {
				// "Added on both sides" is not itself a conflict: the base is just empty, which is
				// what a three-way merge of two addition sets already handles. Escalating the whole
				// file destroyed one side’s todos outright, and this is the branch a cold cache takes
				// for EVERY file both sides hold — bootstrap merges against an empty base, so an empty
				// base must mean "both sides added", never "pick one side". Only a genuine id
				// collision inside the file escalates, and it carries its substrate.
				const itemMerge = threeWayMerge([], localTodos, remoteTodos);
				if (itemMerge.conflicts.length === 0) {
					autoMerged[filePath] = itemMerge.autoMerged;
				} else {
					conflicts.push({
						filePath,
						base: null,
						local: localTodos,
						remote: remoteTodos,
						conflictType: "file-added-both",
						itemMerge,
					});
				}
			} else {
				// Same content, add once
				autoMerged[filePath] = localTodos;
			}
			continue;
		}

		// CASE 5: File only in local (added locally)
		if (!inBase && inLocal && !inRemote) {
			autoMerged[filePath] = localTodos;
			continue;
		}

		// CASE 6: File only in remote (added remotely)
		if (!inBase && !inLocal && inRemote) {
			autoMerged[filePath] = remoteTodos;
			continue;
		}
	}

	return { autoMerged, conflicts };
}

/**
 * Settles one file conflict into the todo array to store for that file, given the side the
 * caller’s policy prefers.
 *
 * Where the conflict carries a per-item merge (`file-edit-edit` and `file-added-both`, the two
 * types where both sides hold a version of the file) the resolution is built from that
 * substrate, so the policy decides only the ids that genuinely conflict: additions either side
 * made to the file, and edits only one side made, survive whichever way the policy falls.
 * Taking `conflict.local` or `conflict.remote` wholesale instead — as callers did before this
 * existed — drops every addition the losing side made to that file, with no dialog and no
 * message, because a file conflict is settled by policy rather than shown to the user.
 *
 * The remaining types (`file-edit-delete`, `file-delete-edit`) have no substrate: the file
 * itself is the unit of conflict, edited on one side and deleted on the other, so the whole
 * preferred side wins. Those are also the only types where the preferred side can be absent,
 * which is why the guard below can return `pick` for both reasons at once.
 *
 * Returns null when the preferred side has no version of the file — leave it out of the
 * merged set, i.e. accept the deletion.
 *
 * Kept in step with the sibling copy of this module; both peers sync the same gist and must
 * settle the same conflict identically.
 */
export function resolveFileConflict(conflict: FileConflictSet, prefer: "local" | "remote"): Todo[] | null {
	const pick = prefer === "remote" ? conflict.remote : conflict.local;
	if (!conflict.itemMerge || !pick) {
		return pick;
	}

	const resolved = new Map<number, Todo>();
	for (const itemConflict of conflict.itemMerge.conflicts) {
		const side = prefer === "remote" ? itemConflict.remote : itemConflict.local;
		if (side) {
			resolved.set(itemConflict.todoId, side);
		}
		// else: the preferred side deleted this todo, so the deletion stands.
	}

	// Same positioning rule as the workspace-todo path: the per-item merge's own order.
	return assembleMerged(conflict.itemMerge, resolved);
}

/**
 * Merges the filesDataPaths dictionary (primary file paths -> alias arrays).
 *
 * Strategy:
 * - Union local + remote entries for each key
 * - Deduplicate paths using normalized comparisons
 */
export function mergeFilesDataPaths(
	_base: TodoFilesDataPaths,
	local: TodoFilesDataPaths,
	remote: TodoFilesDataPaths
): TodoFilesDataPaths {
	const merged: TodoFilesDataPaths = {};
	// Sorted for the same reason as mergeFilesData: stable key order, no spurious pushes.
	const allKeys = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();

	const addUnique = (list: string[], value: string, normalize: (value: string) => string) => {
		const normalizedValue = normalize(value);
		if (list.some((item) => normalize(item) === normalizedValue)) {
			return;
		}
		list.push(value);
	};

	for (const key of allKeys) {
		const localEntry = local[key];
		const remoteEntry = remote[key];
		const absPaths: string[] = [];
		const relPaths: string[] = [];

		if (localEntry?.absPaths) {
			for (const absPath of localEntry.absPaths) {
				addUnique(absPaths, absPath, normalizeAbsolutePath);
			}
		}

		if (remoteEntry?.absPaths) {
			for (const absPath of remoteEntry.absPaths) {
				addUnique(absPaths, absPath, normalizeAbsolutePath);
			}
		}

		if (localEntry?.relPaths) {
			for (const relPath of localEntry.relPaths) {
				addUnique(relPaths, relPath, normalizeRelativePath);
			}
		}

		if (remoteEntry?.relPaths) {
			for (const relPath of remoteEntry.relPaths) {
				addUnique(relPaths, relPath, normalizeRelativePath);
			}
		}

		merged[key] = { absPaths, relPaths };
	}

	return merged;
}

/**
 * Formats a summary of the workspace merge result for display to the user
 */
export function formatWorkspaceMergeSummary(
	result: WorkspaceMergeResult,
	baseWorkspaceTodos: Todo[],
	baseFilesData: TodoFilesData
): string {
	const parts: string[] = [];

	// Workspace todos summary
	const workspaceSummary = formatMergeSummary(result.workspaceMerge, baseWorkspaceTodos);
	if (workspaceSummary !== "No changes") {
		parts.push(`Workspace: ${workspaceSummary}`);
	}

	// Files data summary
	const baseFileCount = Object.keys(baseFilesData).length;
	const mergedFileCount = Object.keys(result.autoMergedFilesData).length;
	const filesAdded = mergedFileCount - baseFileCount;
	const filesDeleted = baseFileCount - mergedFileCount;

	if (filesAdded > 0) {
		parts.push(`${filesAdded} file(s) added`);
	}
	if (filesDeleted > 0) {
		parts.push(`${filesDeleted} file(s) deleted`);
	}

	// Count modified files (files that exist in both but have different todos)
	let filesModified = 0;
	for (const filePath of Object.keys(result.autoMergedFilesData)) {
		if (baseFilesData[filePath] && !isEqual(baseFilesData[filePath], result.autoMergedFilesData[filePath])) {
			filesModified++;
		}
	}
	if (filesModified > 0) {
		parts.push(`${filesModified} file(s) modified`);
	}

	return parts.length > 0 ? parts.join(", ") : "No changes";
}
