import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
	// Match every `*.test.js` under `out/src/test`, not just `.../suite`. The sync suites live
	// in `out/src/test/sync`, so a `suite/**` glob silently skipped them.
	//
	// `src` is in the path because the build compiles `packages/core/src` alongside `src`, so
	// tsc's inferred root is the repo root — see tsconfig.json.
	files: "out/src/test/**/*.test.js",
	env: {
		NODE_ENV: "test",
	},
});
