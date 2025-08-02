import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
	files: "out/test/suite/**/*.js",
	env: {
		NODE_ENV: "test",
	},
});
