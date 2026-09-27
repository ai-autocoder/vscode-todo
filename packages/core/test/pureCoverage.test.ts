/**
 * The helpers in `pure.ts` that pure.test.ts leaves out: the display sorts (both peers re-sort
 * after a toggle, so they must agree), the path normalization the per-file alias matching relies
 * on, canonical equality, and id generation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
	sortTodosWithNotes,
	normalizeAbsolutePath,
	normalizeRelativePath,
	normalizeSlashes,
	isWindowsPath,
	isEqual,
	generateUniqueId,
	Todo,
} from "../src/index";

const t = (id: number, over: Partial<Todo> = {}): Todo => ({
	id,
	text: `t${id}`,
	completed: false,
	creationDate: "2020-01-01T00:00:00.000Z",
	isMarkdown: false,
	isNote: false,
	...over,
});
const done = (id: number) => t(id, { completed: true });
const note = (id: number) => t(id, { isNote: true });
const order = (todos: Todo[]) => todos.map((x) => x.id);

describe("sortTodosWithNotes", () => {
	it("returns the same array untouched when sorting is disabled", () => {
		const list = [done(1), t(2)];
		expect(sortTodosWithNotes(list, "disabled")).toBe(list);
	});

	it("sortType1 (the default) sinks completed tasks and keeps everything else in order", () => {
		const list = [done(1), t(2), note(3), done(4), t(5)];
		expect(order(sortTodosWithNotes(list))).toEqual([2, 3, 5, 1, 4]);
	});

	it("sortType1 never moves a completed note", () => {
		const list = [t(1, { isNote: true, completed: true }), t(2)];
		expect(order(sortTodosWithNotes(list, "sortType1"))).toEqual([1, 2]);
	});

	it("sortType1 does not mutate its input", () => {
		const list = [done(1), t(2)];
		sortTodosWithNotes(list, "sortType1");
		expect(order(list)).toEqual([1, 2]);
	});

	it("sortType2 sinks completed tasks only within their note-delimited section", () => {
		const list = [done(1), t(2), note(10), done(3), t(4), note(20), t(5), done(6)];
		expect(order(sortTodosWithNotes(list, "sortType2"))).toEqual([2, 1, 10, 4, 3, 20, 5, 6]);
	});

	it("sortType2 is stable among equally-completed tasks", () => {
		const list = [done(1), done(2), t(3), t(4)];
		expect(order(sortTodosWithNotes(list, "sortType2"))).toEqual([3, 4, 1, 2]);
	});

	it("sortType2 keeps adjacent notes in order", () => {
		const list = [note(1), note(2), done(3), t(4)];
		expect(order(sortTodosWithNotes(list, "sortType2"))).toEqual([1, 2, 4, 3]);
	});
});

describe("path normalization", () => {
	it("recognizes drive-letter and UNC paths as Windows paths", () => {
		expect(isWindowsPath("C:\\repo")).toBe(true);
		expect(isWindowsPath("c:/repo")).toBe(true);
		expect(isWindowsPath("\\\\server\\share")).toBe(true);
		expect(isWindowsPath("/home/me")).toBe(false);
		expect(isWindowsPath("C:repo")).toBe(false);
	});

	it("turns backslashes into forward slashes", () => {
		expect(normalizeSlashes("a\\b\\c")).toBe("a/b/c");
	});

	it("lower-cases and cleans Windows absolute paths so both separators match", () => {
		expect(normalizeAbsolutePath("C:\\Repo\\src\\..\\A.ts")).toBe("c:/repo/a.ts");
		expect(normalizeAbsolutePath("c:/repo//./a.ts")).toBe("c:/repo/a.ts");
	});

	it("keeps POSIX absolute paths case-sensitive", () => {
		expect(normalizeAbsolutePath("/Home/Me/../A.ts")).toBe("/Home/A.ts");
	});

	it("keeps a UNC prefix", () => {
		expect(normalizeAbsolutePath("\\\\Server\\Share\\x.ts")).toBe("//server/share/x.ts");
	});

	it("does not climb above the root of an absolute path", () => {
		expect(normalizeAbsolutePath("/../../etc")).toBe("/etc");
		expect(normalizeAbsolutePath("C:\\..\\x")).toBe("c:/x");
	});

	it("reduces a bare root to itself", () => {
		expect(normalizeAbsolutePath("/")).toBe("/");
		expect(normalizeAbsolutePath("C:\\")).toBe("c:");
	});

	it("keeps leading '..' in relative paths, and drops './'", () => {
		expect(normalizeRelativePath("../shared/x.ts")).toBe("../shared/x.ts");
		expect(normalizeRelativePath("./src\\a.ts")).toBe("src/a.ts");
		expect(normalizeRelativePath("src/lib/../a.ts")).toBe("src/a.ts");
	});
});

describe("isEqual", () => {
	it("ignores object key order", () => {
		expect(isEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
	});

	it("respects array order", () => {
		expect(isEqual([1, 2], [2, 1])).toBe(false);
	});

	it("treats an undefined property like an absent one, as JSON does", () => {
		expect(isEqual(t(1, { collapsed: undefined }), t(1))).toBe(true);
	});

	it("does not treat an empty tag list like an absent one", () => {
		// Both reducers clear tags to `undefined` for exactly this reason.
		expect(isEqual(t(1, { tags: [] }), t(1))).toBe(false);
	});
});

describe("generateUniqueId", () => {
	afterEach(() => vi.restoreAllMocks());

	it("draws again until the id is free", () => {
		const max = Number.MAX_SAFE_INTEGER / 10;
		const taken = Math.floor(0.5 * max);
		const random = vi.spyOn(Math, "random").mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);

		const id = generateUniqueId([{ id: taken }]);

		expect(id).toBe(Math.floor(0.25 * max));
		expect(random).toHaveBeenCalledTimes(2);
	});

	it("returns a non-negative safe integer", () => {
		const id = generateUniqueId([]);
		expect(Number.isSafeInteger(id)).toBe(true);
		expect(id).toBeGreaterThanOrEqual(0);
	});
});
