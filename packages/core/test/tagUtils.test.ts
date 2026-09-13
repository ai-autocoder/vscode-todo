import { describe, it, expect } from "vitest";
import { normalizeTags, isValidTag, tagsInclude, MAX_TAGS_PER_ITEM } from "../src/index";

describe("normalizeTags", () => {
	it("trims, drops invalid, and de-duplicates case-insensitively keeping first casing", () => {
		expect(normalizeTags([" Bug ", "bug", "feature"])).toEqual(["Bug", "feature"]);
	});

	it("rejects tags with internal whitespace or illegal characters", () => {
		expect(normalizeTags(["has space", "ok-tag", "bad*char"])).toEqual(["ok-tag"]);
	});

	it("treats non-array input as no tags", () => {
		expect(normalizeTags(undefined)).toEqual([]);
		expect(normalizeTags("nope")).toEqual([]);
	});

	it("caps the number of tags", () => {
		const many = Array.from({ length: MAX_TAGS_PER_ITEM + 5 }, (_, i) => `t${i}`);
		expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_ITEM);
	});
});

describe("isValidTag / tagsInclude", () => {
	it("validates allowed punctuation", () => {
		expect(isValidTag("area/ui")).toBe(true);
		expect(isValidTag("v1.2")).toBe(true);
		expect(isValidTag("")).toBe(false);
	});

	it("matches tags case-insensitively", () => {
		expect(tagsInclude(["Bug", "UI"], "bug")).toBe(true);
		expect(tagsInclude(["Bug"], "feature")).toBe(false);
		expect(tagsInclude(undefined, "bug")).toBe(false);
	});
});
