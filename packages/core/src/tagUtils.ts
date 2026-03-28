/**
 * Shared tag rules for the Tags feature. A single source of truth reused by every
 * surface that accepts tags — the MCP write tool, the importer, and (mirrored in the
 * webview) the `tag:` search parser — so a tag that is valid in one place is valid in
 * all of them and the stored shape is always consistent.
 *
 * Rules:
 * - A tag is trimmed of surrounding whitespace; empty (or whitespace-only) tags are dropped.
 * - Allowed characters are letters, digits, and the set `-_/.:+#` (common label/category
 *   punctuation). Any tag containing other characters — including internal whitespace — is
 *   rejected so tags stay single-token and safe to render as chips and parse from search.
 * - Tags are compared case-insensitively for de-duplication, but the first-seen casing is
 *   preserved for display (so "Bug" and "bug" collapse to one entry keeping "Bug").
 * - At most {@link MAX_TAG_LENGTH} characters per tag and {@link MAX_TAGS_PER_ITEM} tags per
 *   item; extra tags beyond the cap are dropped.
 */

/** Maximum length, in characters, of a single tag after trimming. */
export const MAX_TAG_LENGTH = 50;

/** Maximum number of tags retained on a single item. */
export const MAX_TAGS_PER_ITEM = 20;

// Letters, digits, and a small set of label punctuation. Anchored, one-or-more, so a tag
// is a single whitespace-free token. Unicode letters are allowed so non-ASCII tags work.
const VALID_TAG_PATTERN = /^[\p{L}\p{N}_\-/.:+#]+$/u;

/**
 * Returns true when `tag` (already trimmed) satisfies the character and length rules for a
 * single tag. Does not trim — callers pass the trimmed candidate.
 */
export function isValidTag(tag: string): boolean {
	return tag.length > 0 && tag.length <= MAX_TAG_LENGTH && VALID_TAG_PATTERN.test(tag);
}

/**
 * Normalize an arbitrary list of candidate tags into the canonical stored form: each tag is
 * trimmed, invalid tags are dropped, duplicates are removed case-insensitively (keeping the
 * first-seen casing), and the result is capped at {@link MAX_TAGS_PER_ITEM}. Non-string and
 * non-array inputs are treated as "no tags" and yield an empty array, so this doubles as the
 * sanitizer for untrusted import/MCP input.
 */
export function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) {
		return [];
	}

	const result: string[] = [];
	const seen = new Set<string>();

	for (const raw of tags) {
		if (typeof raw !== "string") {
			continue;
		}
		const trimmed = raw.trim();
		if (!isValidTag(trimmed)) {
			continue;
		}
		const key = trimmed.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(trimmed);
		if (result.length >= MAX_TAGS_PER_ITEM) {
			break;
		}
	}

	return result;
}

/**
 * True when `tags` contains `target`, matched case-insensitively. The single predicate behind
 * both the MCP `tag` read filter and the webview `tag:` search, so the two surfaces agree on
 * what "an item in this tag/plan" means.
 */
export function tagsInclude(tags: string[] | undefined, target: string): boolean {
	if (!tags || tags.length === 0) {
		return false;
	}
	const needle = target.trim().toLowerCase();
	if (!needle) {
		return false;
	}
	return tags.some((tag) => tag.toLowerCase() === needle);
}
