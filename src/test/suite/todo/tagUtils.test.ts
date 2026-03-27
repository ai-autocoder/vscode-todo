import * as assert from "assert";
import {
	MAX_TAG_LENGTH,
	MAX_TAGS_PER_ITEM,
	isValidTag,
	normalizeTags,
	tagsInclude,
} from "../../../todo/tagUtils";

/**
 * Phase 4a coverage: the shared tag rules used by the importer, the MCP write tool
 * (todo_set_tags), and — mirrored — the webview tag: search parser. These tests pin the
 * validation, normalization, and membership semantics all three surfaces rely on.
 */
suite("tagUtils.isValidTag", () => {
	test("accepts letters, digits, and the allowed punctuation set", () => {
		for (const tag of [
			"bug",
			"Bug",
			"v1.2.3",
			"area/api",
			"type:task",
			"c++",
			"feature_x",
			"#urgent",
		]) {
			assert.strictEqual(isValidTag(tag), true, `expected "${tag}" to be valid`);
		}
	});

	test("accepts non-ASCII letters", () => {
		assert.strictEqual(isValidTag("café"), true);
		assert.strictEqual(isValidTag("日本語"), true);
	});

	test("rejects empty, whitespace, and over-length tags", () => {
		assert.strictEqual(isValidTag(""), false);
		assert.strictEqual(isValidTag("a b"), false, "internal whitespace is rejected");
		assert.strictEqual(isValidTag("a".repeat(MAX_TAG_LENGTH)), true);
		assert.strictEqual(isValidTag("a".repeat(MAX_TAG_LENGTH + 1)), false);
	});

	test("rejects disallowed characters", () => {
		for (const tag of ["a*b", "a%b", "a(b)", "a!b", "a@b"]) {
			assert.strictEqual(isValidTag(tag), false, `expected "${tag}" to be invalid`);
		}
	});
});

suite("tagUtils.normalizeTags", () => {
	test("trims, drops invalid, and keeps valid tags", () => {
		assert.deepStrictEqual(normalizeTags(["  bug  ", "a b", "", "feature"]), ["bug", "feature"]);
	});

	test("de-duplicates case-insensitively, keeping first-seen casing", () => {
		assert.deepStrictEqual(normalizeTags(["Bug", "bug", "BUG", "feat"]), ["Bug", "feat"]);
	});

	test("caps the number of tags at MAX_TAGS_PER_ITEM", () => {
		const many = Array.from({ length: MAX_TAGS_PER_ITEM + 5 }, (_v, i) => `tag${i}`);
		assert.strictEqual(normalizeTags(many).length, MAX_TAGS_PER_ITEM);
	});

	test("treats non-array and non-string input as no tags", () => {
		assert.deepStrictEqual(normalizeTags(undefined), []);
		assert.deepStrictEqual(normalizeTags(null), []);
		assert.deepStrictEqual(normalizeTags("bug"), []);
		assert.deepStrictEqual(normalizeTags([1, true, {}, "ok"]), ["ok"]);
	});
});

suite("tagUtils.tagsInclude", () => {
	test("matches case-insensitively", () => {
		assert.strictEqual(tagsInclude(["Bug", "Feature"], "bug"), true);
		assert.strictEqual(tagsInclude(["Bug"], "BUG"), true);
	});

	test("returns false for missing, empty, or non-matching tags", () => {
		assert.strictEqual(tagsInclude(undefined, "bug"), false);
		assert.strictEqual(tagsInclude([], "bug"), false);
		assert.strictEqual(tagsInclude(["feature"], "bug"), false);
		assert.strictEqual(tagsInclude(["bug"], "   "), false);
	});
});
