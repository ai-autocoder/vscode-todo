/**
 * Unit tests for GitHubApiClient
 */

import * as assert from "assert";
import { GitHubApiClient } from "../../sync/GitHubApiClient";

suite("GitHubApiClient Test Suite", () => {
	test("isValidGistId should validate correct gist ID format", () => {
		const client = new GitHubApiClient({} as any);

		// Valid gist IDs (32-char hex)
		assert.strictEqual(client.isValidGistId("a".repeat(32)), true);
		assert.strictEqual(client.isValidGistId("1234567890abcdef1234567890abcdef"), true);
		assert.strictEqual(client.isValidGistId("ABCDEF1234567890abcdef1234567890"), true);

		// Invalid gist IDs
		assert.strictEqual(client.isValidGistId(""), false);
		assert.strictEqual(client.isValidGistId("abc"), false);
		assert.strictEqual(client.isValidGistId("a".repeat(31)), false); // Too short
		assert.strictEqual(client.isValidGistId("a".repeat(33)), false); // Too long
		assert.strictEqual(client.isValidGistId("g".repeat(32)), false); // Invalid hex char
		assert.strictEqual(client.isValidGistId("abc-123-def-456-abc-123-def-456"), false); // Has dashes
	});

	test("getGistUrl should return correct GitHub URL", () => {
		const client = new GitHubApiClient({} as any);
		const gistId = "a".repeat(32);
		const expected = `https://gist.github.com/${gistId}`;

		assert.strictEqual(client.getGistUrl(gistId), expected);
	});
});
