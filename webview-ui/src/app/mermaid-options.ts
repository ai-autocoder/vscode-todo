import type { MermaidAPI } from "ngx-markdown";

/**
 * How Mermaid renders the diagrams in todo text.
 *
 * `securityLevel` must stay `"strict"`. Diagram text is not only the user's own: an agent
 * can write it over MCP, an import brings it in, and the other device syncs it. Under `"loose"`
 * a diagram's `click` line could put a `javascript:` link in the page or call any global
 * function, and in the PWA that page's origin holds the gist token. `"strict"` sanitizes link
 * URLs and the rendered SVG and binds no click callbacks; HTML labels still render.
 */
export const mermaidOptions: MermaidAPI.MermaidConfig = {
	darkMode: false,
	theme: "neutral",
	startOnLoad: true,
	fontFamily: "monospace",
	securityLevel: "strict",
};
