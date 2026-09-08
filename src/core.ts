/**
 * The extension's single door onto `@vsc-todo/core`.
 *
 * Extension code imports the shared model, merge and sync engine from **here**, never by the
 * package name. The package is consumed from source (the same way the webview consumes it, see
 * webview-ui/tsconfig.json) because it ships as ESM with bundler-style resolution, which the
 * CommonJS extension host cannot `require`. A `paths` mapping would satisfy the type checker and
 * then fail at runtime: `paths` is compile-time only, so tsc emits `require("@vsc-todo/core")`
 * verbatim and Node has nothing to resolve it to. Hence a real relative import.
 *
 * One module holds the path so the `../..` hop is written once rather than at every call site
 * with a different depth, and so there is a single place to look when the layout changes. The
 * build compiles `packages/core/src` alongside `src` into `out/`, which is what makes the
 * emitted `require("../packages/core/src/index")` resolve — see tsconfig.json.
 */

export * from "../packages/core/src/index";
