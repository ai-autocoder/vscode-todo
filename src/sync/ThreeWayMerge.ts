import { Todo, TodoFilesData, TodoFilesDataPaths } from "../todo/todoTypes";
import { isEqual, normalizeAbsolutePath, normalizeRelativePath } from "../todo/todoUtils";
import { WorkspaceMergeResult, FileConflictSet } from "./syncTypes";

/**
 * Result of a three-way merge operation
 */
export interface MergeResult {
	/** Todos that were successfully auto-merged */
	autoMerged: Todo[];
	/** Conflicts that require user resolution */
	conflicts: ConflictSet[];
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

	// Second pass: Build position-aware merge result
	const autoMerged: Todo[] = [];
	const addedIds = new Set<number>();

	// Walk through local array to preserve local positions and additions
	for (const localTodo of local) {
		if (processedIds.has(localTodo.id)) {
			continue; // Skip conflicted items
		}

		const baseTodo = baseMap.get(localTodo.id);
		const remoteTodo = remoteMap.get(localTodo.id);

		if (!baseTodo && !remoteTodo) {
			// CASE 1: Only in local (added locally) - preserve local position
			autoMerged.push(localTodo);
			addedIds.add(localTodo.id);
		} else if (baseTodo && remoteTodo) {
			// CASE 6: In all three - check which version to use
			const remoteModified = !isEqual(baseTodo, remoteTodo);
			const todoToAdd = remoteModified ? remoteTodo : localTodo;
			autoMerged.push(todoToAdd);
			addedIds.add(localTodo.id);
		} else if (baseTodo && !remoteTodo) {
			// CASE 3a: Deleted remotely, local unchanged - already handled, skip
		} else if (!baseTodo && remoteTodo) {
			// CASE 5a: Added on both sides with same content - add once
			autoMerged.push(localTodo);
			addedIds.add(localTodo.id);
		}
	}

	// Walk through remote array to add remote-only items, preserving remote positions
	for (let i = 0; i < remote.length; i++) {
		const remoteTodo = remote[i];

		if (addedIds.has(remoteTodo.id) || processedIds.has(remoteTodo.id)) {
			continue; // Already added or conflicted
		}

		const baseTodo = baseMap.get(remoteTodo.id);
		const localTodo = localMap.get(remoteTodo.id);

		if (!baseTodo && !localTodo) {
			// CASE 2: Only in remote (added remotely) - preserve remote position
			// Find insertion index based on surrounding items in remote array
			const insertIndex = findInsertionIndex(autoMerged, remote, i, addedIds);
			autoMerged.splice(insertIndex, 0, remoteTodo);
			addedIds.add(remoteTodo.id);
		} else if (baseTodo && !localTodo) {
			// CASE 4a: Deleted locally, remote unchanged - already handled, skip
		}
	}

	return { autoMerged, conflicts };
}

/**
 * Finds the appropriate insertion index for a remote-only item
 * based on its surrounding items (anchors) in the remote array
 *
 * @param autoMerged - Current merged result array
 * @param remote - Remote array
 * @param remoteIndex - Index of item to insert in remote array
 * @param addedIds - Set of IDs already in autoMerged
 * @returns Index where the item should be inserted
 */
function findInsertionIndex(
	autoMerged: Todo[],
	remote: Todo[],
	remoteIndex: number,
	addedIds: Set<number>
): number {
	const remoteTodo = remote[remoteIndex];

	// Find the closest previous item in remote that exists in autoMerged (anchor before)
	let prevAnchorId: number | null = null;
	for (let i = remoteIndex - 1; i >= 0; i--) {
		if (addedIds.has(remote[i].id)) {
			prevAnchorId = remote[i].id;
			break;
		}
	}

	// Find the closest next item in remote that exists in autoMerged (anchor after)
	let nextAnchorId: number | null = null;
	for (let i = remoteIndex + 1; i < remote.length; i++) {
		if (addedIds.has(remote[i].id)) {
			nextAnchorId = remote[i].id;
			break;
		}
	}

	// Find positions of anchors in autoMerged
	let prevAnchorIndex = -1;
	let nextAnchorIndex = autoMerged.length;

	if (prevAnchorId !== null) {
		prevAnchorIndex = autoMerged.findIndex((t) => t.id === prevAnchorId);
	}

	if (nextAnchorId !== null) {
		nextAnchorIndex = autoMerged.findIndex((t) => t.id === nextAnchorId);
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
	} else if (nextAnchorIndex < autoMerged.length) {
		// No prev anchor, insert before next anchor
		return nextAnchorIndex;
	} else {
		// No anchors found, append at end (fallback)
		return autoMerged.length;
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
 * Merges auto-merged todos with user-resolved conflict todos while preserving their original positions.
 *
 * The function reconstructs the final array based on the original order from the base array:
 * - Todos that existed in base maintain their relative positions
 * - Newly added todos (not in base) are appended at the end
 *
 * @param autoMerged - Todos that were successfully auto-merged (may include modified, added, or kept todos)
 * @param resolved - Todos from conflicts that user resolved
 * @param base - The original base array used as reference for ordering
 * @returns Final merged array with preserved positions
 */
export function mergeWithPreservedPositions(autoMerged: Todo[], resolved: Todo[], base: Todo[]): Todo[] {
	// Create maps for quick lookup
	const autoMergedMap = new Map(autoMerged.map((t) => [t.id, t]));
	const resolvedMap = new Map(resolved.map((t) => [t.id, t]));

	// Combine into single map (resolved takes precedence over autoMerged)
	const combinedMap = new Map([...autoMergedMap, ...resolvedMap]);

	// Build result array preserving base order
	const result: Todo[] = [];

	// First, add todos that existed in base, maintaining their order
	for (const baseTodo of base) {
		const merged = combinedMap.get(baseTodo.id);
		if (merged) {
			result.push(merged);
			combinedMap.delete(baseTodo.id); // Mark as processed
		}
		// If not in combined map, it was deleted - skip it
	}

	// Then, append any newly added todos (not in base)
	for (const todo of combinedMap.values()) {
		result.push(todo);
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
 * @param baseWorkspaceTodos - The last known clean remote workspace todos (baseline)
 * @param localWorkspaceTodos - Current local workspace todos
 * @param remoteWorkspaceTodos - Current remote workspace todos
 * @param baseFilesData - The last known clean remote files data (baseline)
 * @param localFilesData - Current local files data
 * @param remoteFilesData - Current remote files data
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
		autoMergedWorkspaceTodos: workspaceMergeResult.autoMerged,
		autoMergedFilesData: filesDataMergeResult.autoMerged,
		autoMergedFilesDataPaths: filesDataPathsMergeResult,
		workspaceConflicts: workspaceMergeResult.conflicts,
		fileConflicts: filesDataMergeResult.conflicts,
	};
}

/**
 * Merges the filesData dictionary (file paths -> todo arrays).
 *
 * Algorithm:
 * - Finds all file paths across base, local, and remote
 * - For each file path:
 *   1. If file exists in all three, perform three-way merge on todos
 *   2. If file added in both local and remote, check if contents are identical
 *   3. If file deleted on one side and modified on other, create conflict
 *   4. If file only exists on one side, include it (added or kept)
 *
 * @param base - Base files data (last known clean remote state)
 * @param local - Local files data (current local state)
 * @param remote - Remote files data (current remote state)
 * @returns Merged files data and file-level conflicts
 */
export function mergeFilesData(
	base: TodoFilesData,
	local: TodoFilesData,
	remote: TodoFilesData
): { autoMerged: TodoFilesData; conflicts: FileConflictSet[] } {
	const allFilePaths = new Set([
		...Object.keys(base),
		...Object.keys(local),
		...Object.keys(remote),
	]);

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
				// FILE CONFLICT: Both sides modified file differently
				conflicts.push({
					filePath,
					base: baseTodos,
					local: localTodos,
					remote: remoteTodos,
					conflictType: "file-edit-edit",
				});
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
				// FILE CONFLICT: File added on both sides with different content
				conflicts.push({
					filePath,
					base: null,
					local: localTodos,
					remote: remoteTodos,
					conflictType: "file-added-both",
				});
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
	const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);

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
	const workspaceSummary = formatMergeSummary(
		{ autoMerged: result.autoMergedWorkspaceTodos, conflicts: result.workspaceConflicts },
		baseWorkspaceTodos
	);
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
