# PWA — running and testing it

PWA-only code lives in two places: this directory (shell, conflict review) and
`webview-ui/src/pwa/vscode-theme.css` (the stylesheet only the `pwa` build prepends).
Everything else under `webview-ui/src/app/**` is **shared with the extension webview** — see
AGENTS.md before editing it.

## Testing without a GitHub login

You do **not** need to sign in to GitHub to exercise the PWA. All of its state lives in
IndexedDB (`vsc-todo-pwa`), and `GistGateway.restoreSession()` reaches phase `"connected"` from
a stored token + gist id + file names **with no network call on that path**. Writing those keys
directly is enough to get past the connect screen.

```bash
npm run start:webview:pwa
```

Then open `http://localhost:4200` and paste `scripts/seed-pwa-conflicts.js` into the console and
reload. It seeds a placeholder session, a todo list, and one of every conflict card. The
placeholder token makes the first reconcile 401 onto the retry path, which is harmless and leaves
the seeded state on screen. `.claude/launch.json` has a `pwa` entry so the Browser pane can start
the same server.

Reset with `indexedDB.deleteDatabase("vsc-todo-pwa")` and reload.

What this does **not** cover: real gist reads/writes, so the true conflict-generation path in
`threeWayMerge` is never exercised — the conflicts above are handed to the UI ready-made.

### Going further: real conflicts, one login, no second device

A real conflict only needs a baseline plus two divergent edits, not two machines. Once the user
has completed the device flow **once** in a browser that can be driven, the "other device" can be
simulated by PATCHing the gist directly with `fetch("https://api.github.com/gists/<id>", …)` from
the page — `api.github.com` allows CORS and the token is already in IndexedDB. Then dispatch a
`focus` event to trigger a reconcile, and the real merge produces a real conflict.

The login itself must be done by the user; never enter credentials on their behalf. Device flow
helps here: the PWA shows an 8-character code, and it can be approved from any already-signed-in
device (a phone, their normal browser), so no GitHub password is ever typed into the pane. Ask
first, and use a throwaway gist — this writes to their account.

## Test every size, not just the phone

The app has to work at five meaningfully different combinations, and the breakpoints do **not**
line up with each other. Checking a phone only will miss real breakage.

| Size      | Pointer | Why it is its own case                                                         |
| --------- | ------- | ------------------------------------------------------------------------------ |
| 375×812   | coarse  | Phone. 48px targets, stacked comparison panes                                  |
| 740×420   | coarse  | Phone in landscape. The only place two columns **and** 48px targets coexist    |
| 768×1024  | fine    | Small window. Two columns, no touch floor                                      |
| 1280×800  | fine    | Desktop. Review caps at 640 and centres                                        |
| ~375 wide | fine    | Narrow with a fine pointer — the extension sidebar geometry (`styles.css:330`) |

In the Browser pane, `resize_window` emulates a **mobile device (coarse pointer) for any width
under 768** and a fine pointer at 768 or above — so the `tablet` preset is a _fine_-pointer case,
and coarse-plus-wide has to be requested as a custom size like 740×420. Do not assume a preset
name implies its pointer type; read `matchMedia("(pointer: coarse)").matches` instead.

The breakpoints that actually bite:

- **`pointer: coarse`** gates every mobile rule in `vscode-theme.css` — _not_ viewport width. In
  DevTools you must pick a device preset; merely narrowing the window leaves `pointer: fine` and
  none of the mobile layout applies. Check with
  `getComputedStyle(document.documentElement).getPropertyValue('--touch-target-size')` — empty
  means the non-PWA build or a fine pointer, `48px` means the mobile rules are live.
- **`max-width: 500px`** (`styles.css:346`) re-sizes `main` to `height: 100%; min-height: 100%`.
  Test either side of 500px.
- **`max-width: 500px` _and_ `pointer: fine`** (`styles.css:330`) stacks the tab row vertically.
  That is the extension sidebar, and it is easy to forget it exists.
- **`min-width: 560px`** flips the conflict review's `.sides` from stacked to two columns.

## Layout hazards specific to this app

`app.component.scss` sizes `main` at `100dvh` — a viewport unit that **ignores its container** —
and `styles.css:346` additionally floors it at `min-height: 100%`, which resolves against the
full-height body. So anything that adds chrome around the app (the conflict banner, say) cannot
just be a normal-flow sibling and cannot be fixed by overriding `height` alone; it must override
`min-height` too. `vscode-theme.css` does this under `body.has-conflict-banner`.

Watch for **margin collapsing**: `app-pwa-shell` has no border or padding, so a `margin-top` on
`main` collapses through it and moves the host itself, adding that height to the page scroll.
Reserve space with `padding` on the host, not a margin on the child.

## Verify layout by measuring, not by eye

Screenshots hide off-by-tens. Measure instead — this is what caught both bugs above:

```js
const de = document.documentElement,
	main = document.querySelector("main");
({
	pageScrolls: de.scrollHeight > de.clientHeight, // must be false
	main: main.getBoundingClientRect(), // bottom must equal innerHeight
	composerVisible: document.querySelector("new-todo").getBoundingClientRect().bottom <= innerHeight,
});
```

When hunting which CSS rule wins, note that a modern `CSSStyleRule` exposes an **empty**
`cssRules` list (for nesting), so a naive `if (rule.cssRules) recurse; else check;` walker skips
every style rule and silently finds nothing. Test `rule.cssRules && rule.cssRules.length`.
