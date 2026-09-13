#!/usr/bin/env node
/**
 * Preflight for `npm run deploy:pwa`.
 *
 * The PWA build owns `webview-ui/build-pwa`; the extension build owns `webview-ui/build`.
 * They were one directory, and because the Angular builder clears its output path, whichever
 * target ran last simply replaced the other. That cut both ways: an extension build wiped the
 * bundle a deploy was about to upload, and a PWA build left `webview-ui/build` holding hashed
 * PWA output with no `main.js` at all — which `vsce package` would then ship as the extension
 * webview. Separate directories are the fix; this clear is only belt and braces, so a deploy
 * uploads nothing but what this build produced.
 *
 * The commit/branch line is printed so the deployed revision is visible in the log before the
 * upload starts, which is what makes a wrong-revision release obvious after the fact.
 */

const { execFileSync } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

/** This file lives in <repo>/scripts, so the repo root is always one level up. */
const repoRoot = resolve(__dirname, "..");
const buildDir = join(repoRoot, "webview-ui", "build-pwa");

if (existsSync(buildDir)) {
	rmSync(buildDir, { recursive: true, force: true });
	console.log("  preflight: cleared webview-ui/build-pwa");
}

// Report what is about to be built. Never fail the deploy on this — it is diagnostics only.
try {
	const git = (...args) =>
		execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
	console.log(`  preflight: ${repoRoot}`);
	console.log(`  preflight: ${git("rev-parse", "--abbrev-ref", "HEAD")} — ${git("log", "--oneline", "-1")}`);
	const dirty = git("status", "--porcelain").split("\n").filter(Boolean).length;
	if (dirty) {
		console.log(`  preflight: ${dirty} uncommitted change(s) — these WILL be included`);
	}
} catch {
	/* Not a git checkout, or git unavailable: nothing to report. */
}
