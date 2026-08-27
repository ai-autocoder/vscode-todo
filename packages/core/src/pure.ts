/**
 * Pure, dependency-free helpers extracted from the extension's `todoUtils.ts`. These are
 * the parts the three-way merge and the UI need that do NOT touch the VS Code API
 * (path normalization, equality, id generation, and the display sort). Kept byte-for-byte
 * equivalent to the extension so cross-device path matching and merge behavior stay
 * identical on both surfaces.
 */

import { Todo } from "./todoTypes";

/** Sorting strategy for the todo list. Mirrors `vscodeTodo.taskSortingOptions`. */
export type TaskSortOption = "sortType1" | "sortType2" | "disabled";

/**
 * Structural equality via JSON serialization — the predicate the merge uses to decide whether a
 * todo (or list) changed.
 *
 * Array order is significant (todo order is user-visible), but object *key* order is not: the
 * same todo reaches us with different key ordering depending on whether it was parsed from the
 * gist or built in code, and treating that as a change made every reconcile report false
 * modifications on both sides, producing phantom conflicts and needless pushes.
 */
export function isEqual(a: object, b: object): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/** JSON with object keys emitted in sorted order; array order is preserved. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val === null || typeof val !== "object" || Array.isArray(val)) {
			return val;
		}
		const source = val as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			sorted[key] = source[key];
		}
		return sorted;
	});
}

/**
 * Generates a random id not already present in `todos`. Ids are immutable once assigned and
 * are the key the three-way merge matches on, so they must be unique within a list.
 */
export function generateUniqueId(todos: Array<{ id: number }>): number {
	let newId: number;
	const maxRandom = Number.MAX_SAFE_INTEGER / 10;

	do {
		newId = Math.floor(Math.random() * maxRandom);
	} while (todos.some((todo) => todo.id === newId));

	return newId;
}

// ---------------------------------------------------------------------------
// Path normalization (used by the workspace merge to match the same logical file
// across machines/OSes). Copied verbatim from the extension's todoUtils.
// ---------------------------------------------------------------------------

function isWindowsPath(filePath: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

function normalizeSlashes(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function normalizePathSegments(filePath: string, allowAboveRoot: boolean): string {
	const segments = normalizeSlashes(filePath).split("/");
	const result: string[] = [];

	for (const segment of segments) {
		if (!segment || segment === ".") {
			continue;
		}
		if (segment === "..") {
			if (result.length > 0) {
				result.pop();
			} else if (allowAboveRoot) {
				result.push("..");
			}
			continue;
		}
		result.push(segment);
	}

	return result.join("/");
}

export function normalizeAbsolutePath(filePath: string): string {
	const normalized = normalizeSlashes(filePath);
	let prefix = "";
	let rest = normalized;

	if (/^[a-zA-Z]:\//.test(normalized)) {
		prefix = normalized.slice(0, 2);
		rest = normalized.slice(2);
	} else if (normalized.startsWith("//")) {
		prefix = "//";
		rest = normalized.slice(2);
	} else if (normalized.startsWith("/")) {
		prefix = "/";
		rest = normalized.slice(1);
	}

	const cleaned = normalizePathSegments(rest, false);
	let result = prefix;
	if (cleaned) {
		if (prefix && !prefix.endsWith("/")) {
			result += "/";
		}
		result += cleaned;
	}

	return isWindowsPath(filePath) ? result.toLowerCase() : result;
}

export function normalizeRelativePath(filePath: string): string {
	const normalized = normalizePathSegments(filePath, true);
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

// ---------------------------------------------------------------------------
// Display sort. The extension reads the option from config; here it is a parameter so the
// same logic serves the webview, the PWA, and tests.
// ---------------------------------------------------------------------------

/**
 * Sorts todos/notes for display according to `option`. `"disabled"` preserves array order.
 */
export function sortTodosWithNotes(todos: Todo[], option: TaskSortOption = "sortType1"): Todo[] {
	switch (option) {
		case "disabled":
			return todos;
		case "sortType1":
			return sortType1(todos);
		case "sortType2":
			return sortType2(todos);
	}
}

/** Moves completed tasks to the bottom; notes keep their position. */
function sortType1(todos: Todo[]): Todo[] {
	return todos.slice().sort((a, b) => {
		const isACompleted = !a.isNote && a.completed;
		const isBCompleted = !b.isNote && b.completed;

		if (a.isNote && b.isNote) {
			return 0;
		}

		if (!a.isNote && !b.isNote) {
			if (isACompleted === isBCompleted) {
				return 0;
			}
			if (isACompleted) {
				return 1;
			}
			return -1;
		}

		if (a.isNote) {
			if (!isBCompleted) {
				return 0;
			}
			return -1;
		}

		if (b.isNote) {
			if (!isACompleted) {
				return 0;
			}
			return 1;
		}

		return 0;
	});
}

/** Like sortType1, but completed tasks stay grouped within note-delimited sections. */
function sortType2(todos: Todo[]): Todo[] {
	let currentGroup = 0;
	const mappedTodos = todos.map((todo, index) => ({
		originalIndex: index,
		todo,
		group: todo.isNote ? ++currentGroup : currentGroup,
	}));

	const sortedMappedTodos = mappedTodos.sort((a, b) => {
		if (a.group !== b.group) {
			return a.group - b.group;
		}
		if (!a.todo.isNote && !b.todo.isNote) {
			return Number(a.todo.completed) - Number(b.todo.completed);
		}
		return a.originalIndex - b.originalIndex;
	});

	return sortedMappedTodos.map((mappedItem) => mappedItem.todo);
}

// ---------------------------------------------------------------------------
// Display labels for per-file todo lists. The keys of `filesData` are raw absolute paths
// from whichever machine wrote them, so they mix `\` and `/` separators, come from several
// machines, and are occasionally not paths at all. On a phone the full path is unreadable,
// so the UI shows a basename and keeps the full key in the tooltip.
// ---------------------------------------------------------------------------

/** Matches either separator — the gist can hold paths written by a Windows or a POSIX machine. */
const PATH_SEPARATOR = /[\\/]/;

function splitPathSegments(filePath: string): string[] {
	return filePath.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * Last path segment of `filePath`, treating both `\` and `/` as separators. Trailing
 * separators are ignored; a string with no separator (or no usable segment) is returned
 * unchanged, so non-path keys such as a bare log name still render as themselves.
 */
export function getPathBasename(filePath: string): string {
	const segments = splitPathSegments(filePath);
	return segments.length > 0 ? segments[segments.length - 1] : filePath;
}

/**
 * Labels a set of file keys for display: the basename when it is unique, otherwise as many
 * trailing segments as it takes to tell the colliding keys apart (`todo/store.ts` vs
 * `sync/store.ts`). Keys that remain identical after exhausting their segments fall back to
 * the full key. Returns a map keyed by the original path.
 */
export function buildFileLabels(filePaths: string[]): Record<string, string> {
	const segmentsByPath = new Map<string, string[]>();
	for (const filePath of filePaths) {
		segmentsByPath.set(filePath, splitPathSegments(filePath));
	}

	const labels: Record<string, string> = {};
	const suffix = (segments: string[], depth: number) =>
		segments.slice(Math.max(0, segments.length - depth)).join("/");

	// Group by basename; only colliding groups need deeper suffixes.
	const groups = new Map<string, string[]>();
	for (const filePath of segmentsByPath.keys()) {
		const base = getPathBasename(filePath);
		const group = groups.get(base);
		if (group) {
			group.push(filePath);
		} else {
			groups.set(base, [filePath]);
		}
	}

	for (const group of groups.values()) {
		if (group.length === 1) {
			labels[group[0]] = getPathBasename(group[0]);
			continue;
		}

		const maxDepth = Math.max(...group.map((filePath) => segmentsByPath.get(filePath)!.length));
		let depth = 1;
		for (; depth <= maxDepth; depth++) {
			const seen = new Set(
				group.map((filePath) => suffix(segmentsByPath.get(filePath)!, depth))
			);
			if (seen.size === group.length) {
				break;
			}
		}

		for (const filePath of group) {
			const segments = segmentsByPath.get(filePath)!;
			labels[filePath] =
				depth > maxDepth ? filePath : suffix(segments, depth) || getPathBasename(filePath);
		}
	}

	return labels;
}
