import { mermaidOptions } from "./mermaid-options";

interface MermaidGlobal {
	initialize(config: object): void;
	render(
		id: string,
		text: string
	): Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
}
/** The copy the `scripts` entry in angular.json loads, which ngx-markdown renders with. */
declare const mermaid: MermaidGlobal;

/**
 * Diagram text can come from an agent, an import or the other device, so a diagram's `click`
 * lines must not be able to run script on the page.
 */
describe("Mermaid options", () => {
	let host: HTMLElement;

	beforeEach(() => {
		// Rendered by hand below, so nothing should start on load.
		mermaid.initialize({ ...mermaidOptions, startOnLoad: false });
		host = document.createElement("div");
		document.body.appendChild(host);
	});

	afterEach(() => {
		host.remove();
	});

	it("renders no javascript: link from a diagram", async () => {
		const { svg } = await mermaid.render(
			"mermaid-options-script-link",
			'flowchart TD\n  A --> B\n  click A href "javascript:alert(1)"'
		);

		expect(svg).toContain("<svg");
		expect(svg).not.toContain("javascript:");
	});

	it("does not let a diagram lower the security level", async () => {
		const { svg } = await mermaid.render(
			"mermaid-options-init-directive",
			'%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\n  A --> B\n  click A href "javascript:alert(1)"'
		);

		expect(svg).toContain("<svg");
		expect(svg).not.toContain("javascript:");
	});

	it("still renders an https link", async () => {
		const { svg } = await mermaid.render(
			"mermaid-options-https-link",
			'flowchart TD\n  A --> B\n  click A href "https://example.com/docs"'
		);

		expect(svg).toContain("https://example.com/docs");
	});

	it("binds no function a diagram names", async () => {
		const globals = window as unknown as { diagramCallback?: () => void };
		const diagramCallback = jasmine.createSpy("diagramCallback");
		globals.diagramCallback = diagramCallback;
		try {
			const { svg, bindFunctions } = await mermaid.render(
				"mermaid-options-callback",
				"flowchart TD\n  A --> B\n  click A call diagramCallback()"
			);
			host.innerHTML = svg;
			bindFunctions?.(host);
			const nodes = host.querySelectorAll(".node");
			nodes.forEach((node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));

			expect(nodes.length).toBeGreaterThan(0);
			expect(diagramCallback).not.toHaveBeenCalled();
		} finally {
			delete globals.diagramCallback;
		}
	});
});
