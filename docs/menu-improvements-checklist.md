# Menu Improvements Checklist

Track and check off each task as we implement it. Keep VS Code UI consistency; only deviate when required for functionality.

## Menu Visuals
- [ ] Normalize row layout: fixed left icon slot, text, fixed right status slot (checks/chevrons).
- [ ] Use codicons for glyphs: `chevron-right`/`chevron-down`, `check`, `trash`.
- [ ] Align padding/spacing for every row so text baselines and gutters match (including Expand/Collapse).
- [ ] Remove redundant header for Expand/Collapse; keep only the actionable row.
- [ ] Keep section headers “Type” and “View as” with VS Code-like separators.
- [ ] Use VS Code theme vars in CSS for text, hover, and focus states.

## Menu Behavior
- [ ] Close on selection for one-off actions: Expand/Collapse, Delete.
- [ ] Keep menu open for grouped state changes: Type, View as, Mermaid checkbox.
- [ ] Implement `data-close="true|false"` (or equivalent) and centralize conditional close handler.

## Radio/Checkbox Semantics
- [ ] Convert “Type” options to radio items with right-side checks (single selection).
- [ ] Convert “View as” options to radio items with right-side checks (single selection).
- [ ] Add “Render Mermaid diagrams” as a checkbox under “View as”.
- [ ] Apply ARIA roles: `menu`, `menuitemradio`, `menuitemcheckbox` with `aria-checked`.
- [ ] Disable Mermaid checkbox with `aria-disabled` when not applicable.

## Mermaid Toggle & Rendering Logic
- [ ] Enable Mermaid checkbox only when `View as = Markdown`; otherwise disabled with tooltip.
- [ ] If `viewAs === 'markdown' && renderMermaid`, render ```mermaid fences as diagrams.
- [ ] If `viewAs === 'markdown' && !renderMermaid`, render mermaid fences as highlighted code blocks.
- [ ] If `viewAs === 'text'`, show plain text; Mermaid toggle has no effect.
- [ ] Ensure CSP-safe Mermaid loading (local asset + nonce); no network calls.

## State & Persistence
- [ ] Add per-item state: `type: 'note' | 'todo'`, `viewAs: 'text' | 'markdown'`, `renderMermaid: boolean`.
- [ ] Define global defaults in settings; item state overrides global.
- [ ] On item open, resolve effective state (item → workspace → default).
- [ ] Persist per-item changes via webview/extension messaging.

## Extension Settings (package.json)
- [ ] Contribute `vscodeTodo.viewAs`: enum `text | markdown` (default `markdown`).
- [ ] Contribute `vscodeTodo.renderMermaid`: boolean (default `false`).
- [ ] Wire settings to webview on activation and on configuration change.

## Wiring & Messages
- [ ] From menu interactions, post messages: `setType`, `setViewAs`, `setRenderMermaid` with item id and value.
- [ ] Extension updates model, persists, and broadcasts updated state back to webview.

## Accessibility & Keyboard
- [ ] Ensure keyboard navigation through menu; Enter/Space toggles, Esc closes.
- [ ] Maintain focus after sticky selections (radio/checkbox) for quick multi-changes.

## Tests
- [ ] Webview: render checks correctly for radio groups and Mermaid checkbox.
- [ ] Webview: sticky behavior for radio/checkbox selections; Mermaid disabled when `Text`.
- [ ] Extension: settings contributions exist and propagate to webview; per-item overrides beat globals.

## Docs
- [ ] Update README/docs to explain “View as” and Mermaid toggle, defaults, and conflict handling.
- [ ] Add changelog entry: visual alignment, sticky grouped selections, Mermaid option.

