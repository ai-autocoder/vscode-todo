#!/usr/bin/env node
/**
 * Preflight for `npm run deploy:pwa`.
 *
 * The extension build (`build:webview`) and the PWA build (`build:webview:pwa`) both emit to
 * `webview-ui/build`, and the extension build runs with `--output-hashing=none`. Its unhashed
 * `main.js` / `styles.css` are therefore *not* replaced by a later hashed PWA build — they sit
 * alongside it and get uploaded, so a release can carry files from the wrong target.
 *
 * Clearing the directory first makes each deploy start from nothing but the PWA build. The
 * commit/branch line is printed so the deployed revision is visible in the log before the
 * upload starts, which is what makes a wrong-revision release obvious after the fact.
 */

const { execFileSync } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

/** This file lives in <repo>/scripts, so the repo root is always one level up. */
const repoRoot = resolve(__dirname, "..");
const buildDir = join(repoRoot, "webview-ui", "build");

if (existsSync(buildDir)) {
	rmSync(buildDir, { recursive: true, force: true });
	console.log("  preflight: cleared webview-ui/build (shared by the extension and PWA builds)");
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
