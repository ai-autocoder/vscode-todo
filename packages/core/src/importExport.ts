/**
 * Import/export as pure data transforms, so the standalone PWA can offer both without a
 * VS Code host.
 *
 * The extension's `src/todo/exporter.ts` and `src/todo/importer.ts` interleave three
 * separable concerns:
 *
 *   1. pure data logic — markdown formatting/parsing, shape validation, and the id-keyed merge
 *   2. host I/O — `fs.writeFileSync` / `fs.readFile`, `path`, `getWorkspacePath()`
 *   3. host dialogs — `showSaveDialog`, `showOpenDialog`, `showQuickPick`, `showErrorMessage`
 *
 * Only (1) lives here. (2) and (3) have no browser equivalent and are supplied per surface:
 * the extension keeps using VS Code's dialogs, the PWA builds its own with a file input and a
 * blob download.
 *
 * Kept in step with `src/todo/exporter.ts` and `src/todo/importer.ts` — the PWA runs this copy
 * and the extension runs those, and an import must produce the same result on both.
 * `test/importExport.test.ts` mirrors the extension's own import/export tests so a change to
 * either copy fails visibly.
 *
 * This duplication is now avoidable and should be removed: the extension host DOES consume this
 * package (it compiles `packages/core/src` into its own build — see `src/core.ts`), which is
 * what the sync half was consolidated onto. Import/export was left as peers only because it was
 * out of scope for that change, not because it has to be.
 *
 * Two behavioural notes where this copy is deliberately *not* a transcription:
 *
 *   - `mergeTodoArrays` here copies each incoming item instead of assigning `id` onto the
 *     caller's object. The output is identical; it just does not mutate its input.
 *   - `ensureFilesDataPaths` is not applied. It derives absolute/relative path pairs from a
 *     workspace root, and the PWA has no workspace. Incoming `filesDataPaths` are merged and
 *     preserved (the PWA round-trips them through the gist so the extension's mappings
 *     survive), but none are synthesized.
 */

import { normalizeTags } from "./tagUtils";
import { generateUniqueId, isEqual, normalizeAbsolutePath, normalizeRelativePath } from "./pure";
import {
	ExportFormats,
	ExportObject,
	ImportFormats,
	ImportObject,
	MarkdownImportScopes,
	Todo,
	TodoFilesData,
	TodoFilesDataPartialInput,
	TodoFilesDataPaths,
	TodoPartialInput,
} from "./todoTypes";

/**
 * The *values* of the format/scope enums rather than the enums themselves.
 *
 * TypeScript compares enums nominally, and this logic is duplicated across two surfaces that
 * each declare their own copy (`src/todo/todoTypes.ts` and `./todoTypes.ts`). Their members
 * are identical strings, so accepting the value union lets a caller pass either one — the
 * extension enum, this package's enum, or a plain string — without a cast.
 */
export type ExportFormatValue = `${ExportFormats}`;
export type ImportFormatValue = `${ImportFormats}`;
export type MarkdownImportScopeValue = `${MarkdownImportScopes}`;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Which scopes to include in an export. `files` (every file) wins over `currentFile`, matching
 * the extension's precedence when both are picked.
 */
export interface ExportSelection {
	user?: boolean;
	workspace?: boolean;
	files?: boolean;
	/** Export just this one file's todos. Ignored when `files` is true. */
	currentFile?: string;
}

export interface ExportSource {
	userTodos: Todo[];
	workspaceTodos: Todo[];
	filesData: TodoFilesData;
	filesDataPaths?: TodoFilesDataPaths;
}

/**
 * Assembles the object that gets serialized. Absent scopes are left off entirely rather than
 * written as empty arrays, so a JSON export re-imports as "no opinion" on the scopes it omits.
 */
export function buildExportObject(selection: ExportSelection, source: ExportSource): ExportObject {
	const data: ExportObject = {};

	if (selection.user) {
		data.user = Array.isArray(source.userTodos) ? source.userTodos : [];
	}
	if (selection.workspace) {
		data.workspace = Array.isArray(source.workspaceTodos) ? source.workspaceTodos : [];
	}

	const filesData = source.filesData ?? {};
	const filesDataPaths = source.filesDataPaths ?? {};

	if (selection.files) {
		data.files = filesData;
		if (Object.keys(filesDataPaths).length > 0) {
			data.filesDataPaths = filesDataPaths;
		}
	} else if (selection.currentFile) {
		const key = selection.currentFile;
		data.files = { [key]: filesData[key] ?? [] };
		if (filesDataPaths[key]) {
			data.filesDataPaths = { [key]: filesDataPaths[key] };
		}
	}

	return data;
}

/** Serializes an export object in the chosen format. Markdown is lossy; JSON round-trips. */
export function serializeExport(data: ExportObject, format: ExportFormatValue): string {
	switch (format) {
		case "json":
			return JSON.stringify(data, null, 2);
		case "md":
			return formatExportMarkdown(data);
		default: {
			const exhaustive: never = format;
			throw new Error(`Unsupported export format: ${String(exhaustive)}`);
		}
	}
}

/**
 * Renders todos as markdown: checklist items for tasks, raw text for notes.
 *
 * Notes are separated by a blank line and consecutive tasks by a single newline, so a list of
 * tasks stays a single markdown list while a note keeps its own block.
 */
export function formatExportMarkdown(data: ExportObject): string {
	const formatItems = (items?: Todo[]): string => {
		if (!items || items.length === 0) {
			return "";
		}

		let result = "";
		let prevIsNote = false;

		items.forEach((item, index) => {
			const currentIsNote = item.isNote;

			if (index > 0) {
				result += currentIsNote || prevIsNote ? "\n\n" : "\n";
			}

			result += currentIsNote ? item.text : `- [${item.completed ? "x" : " "}] ${item.text}`;
			prevIsNote = currentIsNote;
		});

		return result;
	};

	let text = "";
	if ("user" in data) {
		text += formatItems(data.user);
	}
	if ("workspace" in data) {
		text += (text ? "\n\n" : "") + formatItems(data.workspace);
	}
	if (data.files !== undefined) {
		for (const key of Object.keys(data.files)) {
			if (data.files[key] !== undefined) {
				text += (text ? "\n\n" : "") + formatItems(data.files[key]);
			}
		}
	}

	if (text.trim()) {
		text += "\n";
	}

	return text;
}

// ---------------------------------------------------------------------------
// Import — shape validation
// ---------------------------------------------------------------------------

function isTodo(todo: unknown): todo is TodoPartialInput {
	return !!todo && typeof todo === "object" && "text" in todo;
}

export function isTodoPartialInput(value: unknown): value is TodoPartialInput[] {
	return Array.isArray(value) && value.some(isTodo);
}

export function isTodoFilesDataPartialInput(value: unknown): value is TodoFilesDataPartialInput {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return Object.entries(value).some(
		([key, entry]) => key.trim() !== "" && isTodoPartialInput(entry)
	);
}

export function isTodoFilesDataPathsInput(value: unknown): value is TodoFilesDataPaths {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	return Object.entries(value).some(([key, entry]) => {
		if (key.trim() === "" || typeof entry !== "object" || entry === null) {
			return false;
		}

		const candidate = entry as { absPaths?: unknown; relPaths?: unknown };
		const absPaths = Array.isArray(candidate.absPaths)
			? candidate.absPaths.filter((item) => typeof item === "string" && item.trim())
			: [];
		const relPaths = Array.isArray(candidate.relPaths)
			? candidate.relPaths.filter((item) => typeof item === "string" && item.trim())
			: [];

		return absPaths.length > 0 || relPaths.length > 0;
	});
}

/**
 * True when at least one recognized scope carries usable data. A file whose every scope is
 * unrecognized is rejected rather than silently importing nothing.
 */
export function isImportObject(value: unknown): value is ImportObject {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	// An explicit shape rather than `Record<string, unknown>`: webview-ui compiles this package
	// from source with `noPropertyAccessFromIndexSignature`, which rejects dot access on an
	// index signature. Core's own tsconfig is laxer, so only the webview build catches it.
	const candidate = value as {
		user?: unknown;
		workspace?: unknown;
		files?: unknown;
		filesDataPaths?: unknown;
	};
	return (
		(candidate.user !== undefined && isTodoPartialInput(candidate.user)) ||
		(candidate.workspace !== undefined && isTodoPartialInput(candidate.workspace)) ||
		(candidate.files !== undefined && isTodoFilesDataPartialInput(candidate.files)) ||
		(candidate.filesDataPaths !== undefined &&
			isTodoFilesDataPathsInput(candidate.filesDataPaths))
	);
}

// ---------------------------------------------------------------------------
// Import — parsing
// ---------------------------------------------------------------------------

export type ImportParseFailure =
	| "empty"
	| "invalid-json"
	| "unrecognized-shape"
	| "scope-required"
	| "no-file-selected";

export type ImportParseResult =
	| { ok: true; data: ImportObject }
	| { ok: false; reason: ImportParseFailure; message: string };

export interface ImportParseInput {
	text: string;
	format: ImportFormatValue;
	/** Required for markdown, which carries no scope of its own. Ignored for JSON. */
	scope?: MarkdownImportScopeValue;
	/** The file a `currentFile`-scoped markdown import targets. */
	currentFilePath?: string;
}

/**
 * Parses and validates import text without touching any state.
 *
 * Every rejection is a value, not a thrown error or a dialog, so each surface can render it
 * however it likes — the extension in a `showErrorMessage`, the PWA in a snackbar.
 */
export function parseImport(input: ImportParseInput): ImportParseResult {
	if (!input.text.trim()) {
		return { ok: false, reason: "empty", message: "The file is empty." };
	}

	let parsed: unknown;

	if (input.format === "md") {
		if (!input.scope) {
			return {
				ok: false,
				reason: "scope-required",
				message: "Choose which list to import the markdown into.",
			};
		}
		if (input.scope === "File" && !input.currentFilePath?.trim()) {
			return {
				ok: false,
				reason: "no-file-selected",
				message: "Select a file first, or import into User or Workspace instead.",
			};
		}
		parsed = parseMarkdownImport(input.text, input.scope, input.currentFilePath ?? "");
	} else {
		try {
			parsed = JSON.parse(input.text);
		} catch {
			return { ok: false, reason: "invalid-json", message: "The file is not valid JSON." };
		}
	}

	if (!isImportObject(parsed)) {
		return {
			ok: false,
			reason: "unrecognized-shape",
			message: "The file has no todos this app recognizes.",
		};
	}

	return { ok: true, data: parsed };
}

/**
 * Turns markdown into todos: every `- [ ]` / `- [x]` line (also `+`, `*` and `1.` markers)
 * becomes a task, and any other run of non-blank lines becomes one note. A blank line closes
 * the current item, which is what lets a multi-line note stay a single note.
 *
 * The matchers are built per call on purpose: they carry `/g`, and a hoisted global regex would
 * keep `lastIndex` between `.test()` calls and start skipping lines.
 */
export function parseMarkdownImport(
	text: string,
	scope: MarkdownImportScopeValue,
	currentFilePath: string
): ImportObject {
	const lines = text.split("\n");
	const records: TodoPartialInput[] = [];
	let currentRecord: TodoPartialInput | null = null;

	const isTaskLine = (line: string) => /^\s*[-+*] \[[ xX]\] |\s*\d+. \[[ xX]\] /gm.test(line);
	const isCompletedLine = (line: string) => /^\s*[-+*] \[[xX]\] |\s*\d+. \[[xX]\] /gm.test(line);
	const getText = (line: string) =>
		line.replace(/^\s*[-+*] \[[ xX]\] |\s*\d+. \[[ xX]\] /gm, "");

	for (const line of lines) {
		if (line.trim() === "") {
			if (currentRecord !== null) {
				records.push(currentRecord);
				currentRecord = null;
			}
			continue;
		}

		if (isTaskLine(line)) {
			if (currentRecord !== null) {
				records.push(currentRecord);
			}
			currentRecord = {
				text: getText(line),
				isNote: false,
				completed: isCompletedLine(line),
				isMarkdown: true,
			};
		} else if (currentRecord === null) {
			currentRecord = { text: line, isNote: true, completed: false, isMarkdown: true };
		} else {
			currentRecord.text += "\n" + line;
		}
	}

	if (currentRecord !== null) {
		records.push(currentRecord);
	}

	return buildImportObject(records, scope, currentFilePath);
}

function buildImportObject(
	records: TodoPartialInput[],
	scope: MarkdownImportScopeValue,
	filePath: string
): ImportObject {
	switch (scope) {
		case "User":
			return { user: records };
		case "Workspace":
			return { workspace: records };
		case "File":
			return { files: { [filePath]: records } };
		default:
			return {};
	}
}

// ---------------------------------------------------------------------------
// Import — merge
// ---------------------------------------------------------------------------

export function filterValidTodos(todos: TodoPartialInput[]): TodoPartialInput[] {
	return todos.filter((todo) => todo?.text?.trim());
}

export function filterValidFilesData(input: TodoFilesDataPartialInput): TodoFilesDataPartialInput {
	const filtered: TodoFilesDataPartialInput = {};

	for (const filePath in input) {
		if (typeof filePath === "string" && filePath.trim()) {
			const validTodos = filterValidTodos(input[filePath]);
			if (validTodos.length > 0) {
				filtered[filePath] = validTodos;
			}
		}
	}

	return filtered;
}

/**
 * Fills in everything a partial import leaves out. `tags` is assigned last so it always
 * overrides whatever the spread brought in: a normalized array, or `undefined` when nothing
 * valid remains — never the raw input.
 *
 * `nowIso` is injectable only so tests can pin the timestamps; it defaults to the clock.
 */
export function initMissingTodoProperties(
	input: TodoPartialInput[],
	nowIso: () => string = () => new Date().toISOString()
): Todo[] {
	return input.map((todo) => {
		const tags = normalizeTags(todo.tags);
		return {
			...todo,
			// Replaced unless it is genuinely a number. Only a *falsy* id used to be replaced, so a
			// string id in a hand-written import file survived all the way onto the gist — where the
			// model, the gist schema and the MCP tools all declare `id: number`, and the MCP output
			// schema then rejects the whole page rather than the one item.
			id: typeof todo.id === "number" && Number.isFinite(todo.id)
				? todo.id
				: generateUniqueId(input as Array<{ id: number }>),
			text: todo.text.trim(),
			completed: todo.completed ?? false,
			isMarkdown: todo.isMarkdown ?? false,
			isNote: todo.isNote ?? false,
			collapsed: todo.collapsed ?? false,
			creationDate: todo.creationDate ?? nowIso(),
			completionDate: todo.completed ? (todo.completionDate ?? nowIso()) : undefined,
			tags: tags.length > 0 ? tags : undefined,
		};
	});
}

/**
 * Merges imported todos into existing ones **by id**: a matching id has its fields overlaid,
 * an unknown id is appended. Import is therefore additive, never destructive — nothing already
 * present is dropped because it was missing from the file.
 */
export function mergeTodoArrays(
	previousTodos: Todo[],
	importedTodos: TodoPartialInput[]
): TodoPartialInput[] {
	const lookupMap = new Map<number, TodoPartialInput>();
	previousTodos.forEach((todo) => {
		lookupMap.set(todo.id, { ...todo });
	});

	importedTodos.forEach((incoming) => {
		// Copy before assigning an id, so the caller's array is left alone.
		const todo: TodoPartialInput = { ...incoming };
		if (!todo.id) {
			todo.id = generateUniqueId(Array.from(lookupMap.values()) as Array<{ id: number }>);
		}
		const existing = lookupMap.get(todo.id);
		lookupMap.set(todo.id, existing ? { ...existing, ...todo } : todo);
	});

	return Array.from(lookupMap.values());
}

function mergeTodoFilesData(
	previousData: TodoFilesData,
	validImportData: TodoFilesDataPartialInput,
	nowIso?: () => string
): TodoFilesData {
	const lookupMap = new Map<string, Todo[]>();
	for (const filePath in previousData) {
		lookupMap.set(filePath, [...previousData[filePath]]);
	}

	for (const filePath in validImportData) {
		const previousTodos = lookupMap.get(filePath);
		if (previousTodos && previousTodos.length > 0) {
			const merged = mergeTodoArrays(previousTodos, validImportData[filePath]);
			lookupMap.set(filePath, initMissingTodoProperties(merged, nowIso));
		} else {
			lookupMap.set(filePath, initMissingTodoProperties(validImportData[filePath], nowIso));
		}
	}

	return Object.fromEntries(lookupMap);
}

export function processAndMergeTodos(
	previousData: Todo[],
	rawImportData: TodoPartialInput[],
	nowIso?: () => string
): Todo[] {
	const validImportData = filterValidTodos(rawImportData);
	const merged = mergeTodoArrays(previousData, validImportData);
	return initMissingTodoProperties(merged, nowIso);
}

export function processAndMergeFilesData(
	previousData: TodoFilesData,
	rawImportData: TodoFilesDataPartialInput,
	nowIso?: () => string
): TodoFilesData {
	return mergeTodoFilesData(previousData, filterValidFilesData(rawImportData), nowIso);
}

/**
 * Unions the per-file path lists, comparing normalized forms so the same logical file recorded
 * on another OS does not land twice. The original spelling is what gets stored.
 *
 * Distinct from `threeWayMerge.ts`'s `mergeFilesDataPaths`, which reconciles base/local/remote
 * for sync and rebuilds the map with sorted keys. This one is the two-way import merge: it
 * starts from `current` and so preserves its key order, matching `src/todo/importer.ts`.
 */
export function mergeImportedFilesDataPaths(
	current: TodoFilesDataPaths,
	incoming: TodoFilesDataPaths
): TodoFilesDataPaths {
	const merged: TodoFilesDataPaths = { ...current };

	const addUniquePath = (list: string[], value: string, normalize: (v: string) => string) => {
		const normalizedValue = normalize(value);
		if (list.some((item) => normalize(item) === normalizedValue)) {
			return;
		}
		list.push(value);
	};

	for (const [primaryKey, entry] of Object.entries(incoming)) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const absPaths = Array.isArray(entry.absPaths) ? entry.absPaths : [];
		const relPaths = Array.isArray(entry.relPaths) ? entry.relPaths : [];
		const existing = merged[primaryKey];
		const nextEntry = {
			absPaths: existing?.absPaths ? [...existing.absPaths] : [],
			relPaths: existing?.relPaths ? [...existing.relPaths] : [],
		};

		for (const absPath of absPaths) {
			if (typeof absPath === "string" && absPath.trim()) {
				addUniquePath(nextEntry.absPaths, absPath, normalizeAbsolutePath);
			}
		}
		for (const relPath of relPaths) {
			if (typeof relPath === "string" && relPath.trim()) {
				addUniquePath(nextEntry.relPaths, relPath, normalizeRelativePath);
			}
		}

		merged[primaryKey] = nextEntry;
	}

	return merged;
}

/**
 * Orders `filesData` by file *basename*, matching how the extension writes the map
 * (`sortByFileName` in `src/todo/todoUtils.ts`) so both surfaces produce the same key order.
 */
export function sortFilesDataByFileName(data: TodoFilesData = {}): TodoFilesData {
	const keys = Object.keys(data).sort((a, b) => {
		const fileNameA = a.split(/[/]/).pop()?.toLowerCase() || "";
		const fileNameB = b.split(/[/]/).pop()?.toLowerCase() || "";
		return fileNameA.localeCompare(fileNameB);
	});

	const sorted: TodoFilesData = {};
	for (const key of keys) {
		sorted[key] = data[key];
	}
	return sorted;
}

export interface ImportMergeState {
	userTodos: Todo[];
	workspaceTodos: Todo[];
	filesData: TodoFilesData;
	filesDataPaths: TodoFilesDataPaths;
}

export interface ImportMergeResult extends ImportMergeState {
	/**
	 * Which scopes actually changed. A scope the file did not mention, or mentioned with data
	 * identical to what is already stored, reports `false` — so a caller can persist and report
	 * only real changes instead of dirtying every scope on every import.
	 */
	changed: {
		user: boolean;
		workspace: boolean;
		filesData: boolean;
		filesDataPaths: boolean;
	};
}

/** True when any scope changed. */
export function hasImportChanges(result: ImportMergeResult): boolean {
	return (
		result.changed.user ||
		result.changed.workspace ||
		result.changed.filesData ||
		result.changed.filesDataPaths
	);
}

/**
 * Applies a parsed import to current state and reports what moved.
 *
 * Pure: the input state is not modified. Scopes absent from the import are passed through
 * untouched, so importing a user-only file cannot disturb the workspace list.
 */
export function mergeImport(
	data: ImportObject,
	state: ImportMergeState,
	nowIso?: () => string
): ImportMergeResult {
	const result: ImportMergeResult = {
		userTodos: state.userTodos,
		workspaceTodos: state.workspaceTodos,
		filesData: state.filesData,
		filesDataPaths: state.filesDataPaths,
		changed: { user: false, workspace: false, filesData: false, filesDataPaths: false },
	};

	if (data.user?.length) {
		const merged = processAndMergeTodos(state.userTodos, data.user, nowIso);
		if (!isEqual(state.userTodos, merged)) {
			result.userTodos = merged;
			result.changed.user = true;
		}
	}

	if (data.workspace?.length) {
		const merged = processAndMergeTodos(state.workspaceTodos, data.workspace, nowIso);
		if (!isEqual(state.workspaceTodos, merged)) {
			result.workspaceTodos = merged;
			result.changed.workspace = true;
		}
	}

	const hasFilesData = isTodoFilesDataPartialInput(data.files);
	const hasFilesDataPaths = isTodoFilesDataPathsInput(data.filesDataPaths);

	if (hasFilesData || hasFilesDataPaths) {
		const nextFilesData = hasFilesData
			? sortFilesDataByFileName(
					processAndMergeFilesData(
						state.filesData,
						data.files as TodoFilesDataPartialInput,
						nowIso
					)
				)
			: state.filesData;

		const nextFilesDataPaths = hasFilesDataPaths
			? mergeImportedFilesDataPaths(state.filesDataPaths, data.filesDataPaths as TodoFilesDataPaths)
			: state.filesDataPaths;

		if (!isEqual(state.filesData, nextFilesData)) {
			result.filesData = nextFilesData;
			result.changed.filesData = true;
		}
		if (!isEqual(state.filesDataPaths, nextFilesDataPaths)) {
			result.filesDataPaths = nextFilesDataPaths;
			result.changed.filesDataPaths = true;
		}
	}

	return result;
}

/** Default export filename, e.g. `todo_export_2026-08-31T18-46-18.json`. */
export function buildExportFileName(format: ExportFormatValue, now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/:/g, "-").split(".")[0];
	return `todo_export_${stamp}.${format}`;
}
