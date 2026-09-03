import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
	// Match every `*.test.js` under `out/test`, not just `out/test/suite`. The sync suites
	// live in `out/test/sync`, so a `suite/**` glob silently skipped them.
	files: "out/test/**/*.test.js",
	env: {
		NODE_ENV: "test",
	},
});
