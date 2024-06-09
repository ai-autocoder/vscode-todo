import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
	files: "out/test/**/*.test.js",
	env: {
		NODE_ENV: "test",
	},
});
