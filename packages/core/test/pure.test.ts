import { describe, it, expect } from "vitest";
import { getPathBasename, buildFileLabels } from "../src/index";

const WIN = "c:\\Users\\francesco.anzalone\\Downloads\\vscode-todo\\README.md";

describe("getPathBasename", () => {
	it("takes the last segment of a Windows path", () => {
		expect(getPathBasename(WIN)).toBe("README.md");
	});

	it("takes the last segment of a POSIX path", () => {
		expect(getPathBasename("/home/user/vscode-todo/src/extension.ts")).toBe("extension.ts");
	});

	it("handles mixed separators", () => {
		expect(getPathBasename("c:/Users\\frans/notes\\todo.md")).toBe("todo.md");
	});

	it("returns a bare filename unchanged", () => {
		expect(getPathBasename("README.md")).toBe("README.md");
	});

	it("passes a non-path string through unchanged", () => {
		expect(getPathBasename("FrancescoAnzalone.vsc-todo.VS Code Todo MCP.log")).toBe(
			"FrancescoAnzalone.vsc-todo.VS Code Todo MCP.log"
		);
	});

	it("ignores trailing separators", () => {
		expect(getPathBasename("/home/user/project/")).toBe("project");
	});

	it("returns the input when there is no usable segment", () => {
		expect(getPathBasename("")).toBe("");
		expect(getPathBasename("///")).toBe("///");
	});
});

describe("buildFileLabels", () => {
	it("uses the plain basename when it is unique", () => {
		const paths = ["c:\\repo\\README.md", "/home/user/repo/src/extension.ts"];
		expect(buildFileLabels(paths)).toEqual({
			[paths[0]]: "README.md",
			[paths[1]]: "extension.ts",
		});
	});

	it("adds one parent segment to disambiguate colliding basenames", () => {
		const paths = ["c:\\repo\\todo\\store.ts", "c:\\repo\\sync\\store.ts"];
		expect(buildFileLabels(paths)).toEqual({
			[paths[0]]: "todo/store.ts",
			[paths[1]]: "sync/store.ts",
		});
	});

	it("keeps adding segments until the labels differ", () => {
		const paths = ["c:\\a\\shared\\store.ts", "c:\\b\\shared\\store.ts"];
		expect(buildFileLabels(paths)).toEqual({
			[paths[0]]: "a/shared/store.ts",
			[paths[1]]: "b/shared/store.ts",
		});
	});

	it("disambiguates the same relative path coming from two machines", () => {
		const paths = [
			WIN,
			"c:\\Users\\frans\\Downloads\\vscode-todo\\README.md",
		];
		expect(buildFileLabels(paths)).toEqual({
			[paths[0]]: "francesco.anzalone/Downloads/vscode-todo/README.md",
			[paths[1]]: "frans/Downloads/vscode-todo/README.md",
		});
	});

	it("falls back to the full key when segments cannot tell two keys apart", () => {
		const paths = ["c:\\repo\\notes.md", "c:/repo/notes.md"];
		expect(buildFileLabels(paths)).toEqual({
			[paths[0]]: paths[0],
			[paths[1]]: paths[1],
		});
	});

	it("labels non-path keys with themselves", () => {
		const paths = ["FrancescoAnzalone.vsc-todo.VS Code Todo MCP.log", "/repo/notes.md"];
		expect(buildFileLabels(paths)).toEqual({
			[paths[0]]: "FrancescoAnzalone.vsc-todo.VS Code Todo MCP.log",
			[paths[1]]: "notes.md",
		});
	});

	it("returns an empty map for no paths", () => {
		expect(buildFileLabels([])).toEqual({});
	});
});
