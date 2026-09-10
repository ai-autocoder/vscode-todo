/* eslint-disable @typescript-eslint/naming-convention --
   filesData is keyed by file path, so the fixtures below must use real paths as object keys. */
import { describe, it, expect } from "vitest";
import {
	buildExportFileName,
	buildExportObject,
	ExportFormats,
	filterValidFilesData,
	filterValidTodos,
	formatExportMarkdown,
	hasImportChanges,
	ImportFormats,
	initMissingTodoProperties,
	isImportObject,
	isTodoFilesDataPartialInput,
	isTodoFilesDataPathsInput,
	isTodoPartialInput,
	MarkdownImportScopes,
	mergeImport,
	mergeImportedFilesDataPaths,
	mergeTodoArrays,
	parseImport,
	processAndMergeTodos,
	serializeExport,
	sortFilesDataByFileName,
	Todo,
	TodoPartialInput,
} from "../src/index";

/**
 * Mirrors `src/test/suite/todo/importer.test.ts`, which covers the extension's own copy of this
 * logic in `src/todo/importer.ts`. The two copies must agree — see the "Kept in step with"
 * note at the top of `src/importExport.ts` — so the first block below asserts the same
 * behaviours case for case, with the fixtures condensed. A change to either copy should fail
 * here or there.
 *
 * The blocks after it cover ground the extension has no tests for (markdown formatting, the
 * parse-failure taxonomy, and `mergeImport`), which the PWA depends on directly.
 */

const fixedNow = () => "2026-08-31T18:46:18.000Z";

function todo(overrides: Partial<Todo> & { text: string }): Todo {
	return {
		id: 1,
		text: "task",
		completed: false,
		isMarkdown: false,
		isNote: false,
		collapsed: false,
		creationDate: "2026-08-01T00:00:00.000Z",
		...overrides,
	} as Todo;
}

// ---------------------------------------------------------------------------
// Mirrored from the extension's importer.test.ts
// ---------------------------------------------------------------------------

describe("isTodoPartialInput (mirrors extension)", () => {
	it("returns true if at least one element in the array has a text property", () => {
		expect(
			isTodoPartialInput([
				{ id: 1282947365473357, text: "test", completed: false },
				{ id: 2, completed: false },
			])
		).toBe(true);
	});

	it("returns false if every element is missing text", () => {
		expect(isTodoPartialInput([{ id: 1, completed: false }, { id: 2 }])).toBe(false);
	});

	it("returns false for an empty array, and for an array of empty objects", () => {
		expect(isTodoPartialInput([])).toBe(false);
		// The extension's case: one element, but no `text` on it.
		expect(isTodoPartialInput([{}])).toBe(false);
	});

	it("returns false if the array holds no objects", () => {
		expect(isTodoPartialInput(["text", 3, null])).toBe(false);
	});
});

describe("isTodoFilesDataPartialInput (mirrors extension)", () => {
	it("returns true if at least one entry is valid", () => {
		expect(
			isTodoFilesDataPartialInput({
				"c:\\Users\\someFile.txt": [{ id: 1, text: "yjyj", completed: false }],
				"c:\\Users\\other.txt": [{ id: 2, completed: false }],
			})
		).toBe(true);
	});

	it("returns false for an empty object", () => {
		expect(isTodoFilesDataPartialInput({})).toBe(false);
	});

	it("returns false if the path is not valid", () => {
		expect(isTodoFilesDataPartialInput({ "": [{ id: 1, text: "a", completed: false }] })).toBe(
			false
		);
	});
});

describe("filterValidFilesData (mirrors extension)", () => {
	it("drops an empty path and any todo without text", () => {
		const files = {
			"c:\\Users\\someFile.txt": [
				{
					id: 2418412004652330,
					text: "yjyj",
					completed: false,
					creationDate: "2024-05-05T19:00:14.340Z",
					isMarkdown: false,
					isNote: false,
				},
			],
			"": [
				{
					id: 2530813296708339,
					text: "dthjtn",
					completed: false,
					creationDate: "2024-05-05T19:00:10.920Z",
					isMarkdown: false,
					isNote: false,
				},
			],
			"c:\\Users\\someFile2.txt": [
				{
					id: 2530813296708340,
					completed: false,
					creationDate: "2024-05-05T19:00:10.920Z",
					isMarkdown: false,
					isNote: false,
				} as unknown as TodoPartialInput,
			],
		};

		expect(filterValidFilesData(files)).toEqual({
			"c:\\Users\\someFile.txt": [
				{
					id: 2418412004652330,
					text: "yjyj",
					completed: false,
					creationDate: "2024-05-05T19:00:14.340Z",
					isMarkdown: false,
					isNote: false,
				},
			],
		});
	});
});

describe("initMissingTodoProperties tags (mirrors extension)", () => {
	it("sanitizes imported tags through the shared rules", () => {
		const [item] = initMissingTodoProperties(
			[{ text: "task", tags: ["  bug  ", "Bug", "a b", "feature"] }],
			fixedNow
		);
		// Trimmed, deduped case-insensitively (first-seen casing kept), invalid dropped.
		expect(item.tags).toEqual(["bug", "feature"]);
	});

	it("omits the tags field entirely when nothing valid remains", () => {
		const [noTags] = initMissingTodoProperties([{ text: "task" }], fixedNow);
		expect(noTags.tags).toBeUndefined();

		const [allInvalid] = initMissingTodoProperties(
			[{ text: "task", tags: ["a b", ""] }],
			fixedNow
		);
		expect(allInvalid.tags).toBeUndefined();
	});

	it("replaces an id that is not a number", () => {
		// A hand-written import file can carry anything. Only a *falsy* id used to be replaced,
		// so `"42"` reached the store and then the gist — where the model, the gist schema and
		// the MCP tools all declare `id: number`, and the MCP output schema rejects the whole
		// page rather than the one item.
		const [stringId] = initMissingTodoProperties(
			[{ text: "task", id: "42" } as unknown as TodoPartialInput],
			fixedNow
		);
		expect(typeof stringId.id).toBe("number");
		expect(stringId.id).not.toBe(42);

		// A real id is still kept as it is.
		const [kept] = initMissingTodoProperties([{ text: "task", id: 7 }], fixedNow);
		expect(kept.id).toBe(7);
	});
});

describe("isImportObject (mirrors extension)", () => {
	it("returns true when it contains valid data", () => {
		expect(isImportObject({ user: [], workspace: [{ id: 1, text: "a", completed: false }] })).toBe(
			true
		);
	});

	it("returns false for a non-object and for a shape with nothing recognizable", () => {
		expect(isImportObject(null)).toBe(false);
		expect(isImportObject("nope")).toBe(false);
		expect(isImportObject({ somethingElse: [1, 2, 3] })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Core-only: filling in properties
// ---------------------------------------------------------------------------

describe("initMissingTodoProperties", () => {
	it("fills defaults and keeps an existing id", () => {
		const [item] = initMissingTodoProperties([{ id: 42, text: "  padded  " }], fixedNow);
		expect(item).toMatchObject({
			id: 42,
			text: "padded",
			completed: false,
			isMarkdown: false,
			isNote: false,
			collapsed: false,
			creationDate: fixedNow(),
		});
		expect(item.completionDate).toBeUndefined();
	});

	it("stamps a completionDate only for completed items", () => {
		const [done] = initMissingTodoProperties([{ text: "done", completed: true }], fixedNow);
		expect(done.completionDate).toBe(fixedNow());

		const [open] = initMissingTodoProperties([{ text: "open", completed: false }], fixedNow);
		expect(open.completionDate).toBeUndefined();
	});

	it("assigns an id when the import omits one", () => {
		const [item] = initMissingTodoProperties([{ text: "no id" }], fixedNow);
		expect(typeof item.id).toBe("number");
		expect(item.id).toBeGreaterThan(0);
	});
});

describe("filterValidTodos", () => {
	it("drops entries whose text is missing or whitespace", () => {
		expect(
			filterValidTodos([
				{ text: "keep" },
				{ text: "   " },
				{ text: "" },
				{ id: 9 } as unknown as TodoPartialInput,
			])
		).toEqual([{ text: "keep" }]);
	});
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("mergeTodoArrays", () => {
	it("overlays fields onto a matching id and appends an unknown one", () => {
		const previous = [todo({ id: 1, text: "original" }), todo({ id: 2, text: "untouched" })];
		const merged = mergeTodoArrays(previous, [
			{ id: 1, text: "edited" },
			{ id: 3, text: "brand new" },
		]);

		expect(merged).toHaveLength(3);
		expect(merged.find((t) => t.id === 1)?.text).toBe("edited");
		expect(merged.find((t) => t.id === 2)?.text).toBe("untouched");
		expect(merged.find((t) => t.id === 3)?.text).toBe("brand new");
	});

	it("does not mutate the caller's imported array", () => {
		const imported: TodoPartialInput[] = [{ text: "no id yet" }];
		mergeTodoArrays([], imported);
		expect(imported[0].id).toBeUndefined();
	});

	it("is additive — nothing already present is dropped", () => {
		const previous = [todo({ id: 1, text: "keep me" })];
		expect(mergeTodoArrays(previous, []).map((t) => t.id)).toEqual([1]);
	});
});

describe("processAndMergeTodos", () => {
	it("filters invalid input, merges by id, then fills defaults", () => {
		const previous = [todo({ id: 1, text: "first" })];
		const merged = processAndMergeTodos(
			previous,
			[{ id: 1, text: "first edited" }, { text: "   " }, { text: "second" }],
			fixedNow
		);

		expect(merged.map((t) => t.text)).toEqual(["first edited", "second"]);
		expect(merged.every((t) => typeof t.id === "number")).toBe(true);
	});
});

describe("mergeImportedFilesDataPaths", () => {
	it("unions path lists and de-duplicates on the normalized form", () => {
		const merged = mergeImportedFilesDataPaths(
			{ "a.ts": { absPaths: ["C:\\repo\\a.ts"], relPaths: ["a.ts"] } },
			{ "a.ts": { absPaths: ["c:/repo/a.ts"], relPaths: ["./a.ts", "sub/b.ts"] } }
		);

		// The differently-spelled duplicate is recognized and not added twice.
		expect(merged["a.ts"].absPaths).toEqual(["C:\\repo\\a.ts"]);
		expect(merged["a.ts"].relPaths).toContain("a.ts");
		expect(merged["a.ts"].relPaths).toContain("sub/b.ts");
	});

	it("keeps entries that the incoming map does not mention", () => {
		const merged = mergeImportedFilesDataPaths(
			{ "keep.ts": { absPaths: ["/x/keep.ts"], relPaths: ["keep.ts"] } },
			{ "new.ts": { absPaths: ["/x/new.ts"], relPaths: ["new.ts"] } }
		);
		expect(Object.keys(merged).sort()).toEqual(["keep.ts", "new.ts"]);
	});
});

describe("sortFilesDataByFileName", () => {
	it("orders by basename, not by full path", () => {
		const sorted = sortFilesDataByFileName({
			"src/z/apple.ts": [],
			"src/a/zebra.ts": [],
			"src/m/mango.ts": [],
		});
		expect(Object.keys(sorted)).toEqual(["src/z/apple.ts", "src/m/mango.ts", "src/a/zebra.ts"]);
	});
});

describe("mergeImport", () => {
	const state = () => ({
		userTodos: [todo({ id: 1, text: "user one" })],
		workspaceTodos: [todo({ id: 2, text: "workspace one" })],
		filesData: { "a.ts": [todo({ id: 3, text: "file one" })] },
		filesDataPaths: {},
	});

	it("leaves scopes the import does not mention untouched", () => {
		const before = state();
		const result = mergeImport({ user: [{ text: "added" }] }, before, fixedNow);

		expect(result.changed.user).toBe(true);
		expect(result.changed.workspace).toBe(false);
		expect(result.changed.filesData).toBe(false);
		// Identity, not just equality: an unmentioned scope is passed straight through.
		expect(result.workspaceTodos).toBe(before.workspaceTodos);
		expect(result.filesData).toBe(before.filesData);
	});

	it("reports no change when the import repeats what is already stored", () => {
		const before = state();
		const result = mergeImport({ user: [{ ...before.userTodos[0] }] }, before, fixedNow);

		expect(result.changed.user).toBe(false);
		expect(hasImportChanges(result)).toBe(false);
	});

	it("does not modify the state object it is given", () => {
		const before = state();
		const snapshot = JSON.parse(JSON.stringify(before));
		mergeImport({ user: [{ text: "added" }], workspace: [{ text: "added" }] }, before, fixedNow);
		expect(before).toEqual(snapshot);
	});

	it("merges files data and sorts the result by basename", () => {
		const before = state();
		const result = mergeImport(
			{ files: { "z/aaa.ts": [{ text: "new file" }] } },
			before,
			fixedNow
		);

		expect(result.changed.filesData).toBe(true);
		expect(Object.keys(result.filesData)).toEqual(["a.ts", "z/aaa.ts"]);
	});

	it("preserves incoming filesDataPaths without synthesizing any", () => {
		const before = state();
		const result = mergeImport(
			{ filesDataPaths: { "a.ts": { absPaths: ["/repo/a.ts"], relPaths: ["a.ts"] } } },
			before,
			fixedNow
		);

		expect(result.changed.filesDataPaths).toBe(true);
		expect(result.filesDataPaths["a.ts"].relPaths).toEqual(["a.ts"]);
		// filesData was not mentioned, so it is untouched — no paths were invented for it.
		expect(result.changed.filesData).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseImport failures", () => {
	it("rejects empty or whitespace-only text", () => {
		const result = parseImport({ text: "   \n  ", format: ImportFormats.JSON });
		expect(result).toMatchObject({ ok: false, reason: "empty" });
	});

	it("rejects malformed JSON rather than throwing", () => {
		const result = parseImport({ text: "{ not json", format: ImportFormats.JSON });
		expect(result).toMatchObject({ ok: false, reason: "invalid-json" });
	});

	it("rejects JSON with no recognizable scope", () => {
		const result = parseImport({
			text: JSON.stringify({ unrelated: true }),
			format: ImportFormats.JSON,
		});
		expect(result).toMatchObject({ ok: false, reason: "unrecognized-shape" });
	});

	it("requires a scope for markdown, which carries none of its own", () => {
		const result = parseImport({ text: "- [ ] task", format: ImportFormats.MARKDOWN });
		expect(result).toMatchObject({ ok: false, reason: "scope-required" });
	});

	it("refuses a currentFile-scoped markdown import with no file selected", () => {
		const result = parseImport({
			text: "- [ ] task",
			format: ImportFormats.MARKDOWN,
			scope: MarkdownImportScopes.currentFile,
			currentFilePath: "   ",
		});
		expect(result).toMatchObject({ ok: false, reason: "no-file-selected" });
	});

	it("every failure carries a message fit to show a user", () => {
		const result = parseImport({ text: "", format: ImportFormats.JSON });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message.length).toBeGreaterThan(0);
		}
	});
});

describe("parseImport markdown", () => {
	it("reads checklist markers, including + * and 1., and their completed state", () => {
		const result = parseImport({
			text: "- [ ] dash\n+ [x] plus done\n* [X] star done",
			format: ImportFormats.MARKDOWN,
			scope: MarkdownImportScopes.user,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.data.user).toEqual([
			{ text: "dash", isNote: false, completed: false, isMarkdown: true },
			{ text: "plus done", isNote: false, completed: true, isMarkdown: true },
			{ text: "star done", isNote: false, completed: true, isMarkdown: true },
		]);
	});

	it("keeps consecutive non-task lines together as one multi-line note", () => {
		const result = parseImport({
			text: "First line\nsecond line\n\n- [ ] a task",
			format: ImportFormats.MARKDOWN,
			scope: MarkdownImportScopes.user,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.data.user?.[0]).toMatchObject({
			text: "First line\nsecond line",
			isNote: true,
		});
		expect(result.data.user?.[1]).toMatchObject({ text: "a task", isNote: false });
	});

	it("routes into the chosen scope", () => {
		const workspace = parseImport({
			text: "- [ ] w",
			format: ImportFormats.MARKDOWN,
			scope: MarkdownImportScopes.workspace,
		});
		expect(workspace.ok && workspace.data.workspace).toHaveLength(1);

		const file = parseImport({
			text: "- [ ] f",
			format: ImportFormats.MARKDOWN,
			scope: MarkdownImportScopes.currentFile,
			currentFilePath: "src/a.ts",
		});
		expect(file.ok && file.data.files?.["src/a.ts"]).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("buildExportObject", () => {
	const source = {
		userTodos: [todo({ id: 1, text: "u" })],
		workspaceTodos: [todo({ id: 2, text: "w" })],
		filesData: { "a.ts": [todo({ id: 3, text: "a" })], "b.ts": [todo({ id: 4, text: "b" })] },
		filesDataPaths: { "a.ts": { absPaths: ["/r/a.ts"], relPaths: ["a.ts"] } },
	};

	it("omits scopes that were not selected rather than writing them empty", () => {
		const data = buildExportObject({ user: true }, source);
		expect(Object.keys(data)).toEqual(["user"]);
		expect("workspace" in data).toBe(false);
	});

	it("exports every file when files is selected", () => {
		const data = buildExportObject({ files: true }, source);
		expect(Object.keys(data.files ?? {})).toEqual(["a.ts", "b.ts"]);
		expect(data.filesDataPaths).toEqual(source.filesDataPaths);
	});

	it("narrows to one file for currentFile, with only that file's paths", () => {
		const data = buildExportObject({ currentFile: "a.ts" }, source);
		expect(Object.keys(data.files ?? {})).toEqual(["a.ts"]);
		expect(Object.keys(data.filesDataPaths ?? {})).toEqual(["a.ts"]);
	});

	it("lets files win over currentFile when both are given", () => {
		const data = buildExportObject({ files: true, currentFile: "a.ts" }, source);
		expect(Object.keys(data.files ?? {})).toEqual(["a.ts", "b.ts"]);
	});

	it("exports an empty array for a currentFile that holds nothing", () => {
		const data = buildExportObject({ currentFile: "missing.ts" }, source);
		expect(data.files).toEqual({ "missing.ts": [] });
	});
});

describe("formatExportMarkdown", () => {
	it("renders tasks as checkboxes and notes as raw text", () => {
		const text = formatExportMarkdown({
			user: [
				todo({ id: 1, text: "open" }),
				todo({ id: 2, text: "done", completed: true }),
				todo({ id: 3, text: "a note", isNote: true }),
			],
		});
		expect(text).toBe("- [ ] open\n- [x] done\n\na note\n");
	});

	it("separates consecutive tasks by a single newline", () => {
		const text = formatExportMarkdown({
			user: [todo({ id: 1, text: "one" }), todo({ id: 2, text: "two" })],
		});
		expect(text).toBe("- [ ] one\n- [ ] two\n");
	});

	it("separates a note from its neighbours by a blank line", () => {
		const text = formatExportMarkdown({
			user: [
				todo({ id: 1, text: "task" }),
				todo({ id: 2, text: "note", isNote: true }),
				todo({ id: 3, text: "after" }),
			],
		});
		expect(text).toBe("- [ ] task\n\nnote\n\n- [ ] after\n");
	});

	it("returns empty text for an empty export, with no stray newline", () => {
		expect(formatExportMarkdown({})).toBe("");
		expect(formatExportMarkdown({ user: [] })).toBe("");
	});
});

describe("serializeExport", () => {
	it("pretty-prints JSON", () => {
		const text = serializeExport({ user: [todo({ id: 1, text: "x" })] }, ExportFormats.JSON);
		expect(text).toContain('\n  "user"');
		expect(JSON.parse(text).user[0].text).toBe("x");
	});

	it("round-trips JSON back through parseImport", () => {
		const original = [todo({ id: 7, text: "round trip", completed: true })];
		const text = serializeExport({ user: original }, ExportFormats.JSON);
		const result = parseImport({ text, format: ImportFormats.JSON });

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.data.user).toEqual(original);
	});

	it("survives a full export → import → merge cycle without duplicating by id", () => {
		const existing = [todo({ id: 7, text: "round trip" })];
		const text = serializeExport({ user: existing }, ExportFormats.JSON);
		const parsed = parseImport({ text, format: ImportFormats.JSON });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}

		const merged = mergeImport(
			parsed.data,
			{ userTodos: existing, workspaceTodos: [], filesData: {}, filesDataPaths: {} },
			fixedNow
		);

		// Same ids in, same ids out: re-importing your own export is a no-op.
		expect(merged.userTodos).toHaveLength(1);
		expect(merged.changed.user).toBe(false);
	});
});

describe("buildExportFileName", () => {
	it("stamps the date and uses the format as the extension", () => {
		const at = new Date("2026-08-31T18:46:18.000Z");
		expect(buildExportFileName(ExportFormats.JSON, at)).toBe(
			"todo_export_2026-08-31T18-46-18.json"
		);
		expect(buildExportFileName(ExportFormats.MARKDOWN, at)).toBe(
			"todo_export_2026-08-31T18-46-18.md"
		);
	});
});

describe("isTodoFilesDataPathsInput", () => {
	it("requires at least one entry with a usable path list", () => {
		expect(isTodoFilesDataPathsInput({ "a.ts": { absPaths: ["/r/a.ts"], relPaths: [] } })).toBe(
			true
		);
		expect(isTodoFilesDataPathsInput({ "a.ts": { absPaths: [], relPaths: [] } })).toBe(false);
		expect(isTodoFilesDataPathsInput({ "": { absPaths: ["/r/a.ts"], relPaths: [] } })).toBe(false);
		expect(isTodoFilesDataPathsInput(null)).toBe(false);
	});
});
