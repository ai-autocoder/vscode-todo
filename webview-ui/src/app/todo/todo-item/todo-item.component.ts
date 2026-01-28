import {
	Component,
	ChangeDetectorRef,
	ElementRef,
	EventEmitter,
	Input,
	NgZone,
	OnChanges,
	OnInit,
	Output,
	Renderer2,
	SimpleChanges,
	ViewChild,
} from "@angular/core";
import { Subscription } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import {
	matchesInstructionPrefix,
	parsePlanHeader,
	parsePlanItem,
	stripInstructionPrefix,
} from "../../../../../src/todo/todoTokens";
import { TodoService } from "../todo.service";

type TokenBadge = {
	kind: "plan" | "instr";
	label: string;
};

type TokenInfo = {
	badges: TokenBadge[];
	displayText: string;
	planSlug?: string;
};

@Component({
    selector: "todo-item",
    templateUrl: "./todo-item.component.html",
    styleUrls: ["./todo-item.component.scss"],
    standalone: false
})
export class TodoItemComponent implements OnInit, OnChanges {
	@Input() todo!: Todo;
	@Input() scope!: TodoScope;
	@Input() dragging = false;
	@Input() selected = false;
	@Input() selectionMode = false;
	@Input() selectionCount = 0;
	@ViewChild("markdownContainer") markdownContainer?: ElementRef<HTMLElement>;
	isEditable = false;
	footerActive?: boolean;
	previousText!: string;
	private activeEditorSubscription?: Subscription;
	isActionMenuOpen = false;
	enableLineNumbers: boolean = false;
	enableMarkdownDiagrams: boolean = true;
	enableMarkdownKatex: boolean = true;
	collapsedPreviewLines: number = 1;
	diagramZoomOpen = false;
	zoomSvgSource?: SVGSVGElement;
	tokenInfo: TokenInfo = { badges: [], displayText: "" };
	@Output() delete: EventEmitter<Todo> = new EventEmitter();
	@Output() planDelete: EventEmitter<string> = new EventEmitter();
	private globalClickUnlistener?: () => void;
	private mermaidListeners: Array<() => void> = [];
	private mermaidObserver?: MutationObserver;

	constructor(
		private todoService: TodoService,
		private renderer: Renderer2,
		private elRef: ElementRef,
		private ngZone: NgZone,
		private cdr: ChangeDetectorRef
	) {}

	ngOnInit() {
		this.enableLineNumbers = this.todoService.config.enableLineNumbers;
		this.enableMarkdownDiagrams = this.todoService.config.enableMarkdownDiagrams;
		this.enableMarkdownKatex = this.todoService.config.enableMarkdownKatex;
		this.collapsedPreviewLines = this.todoService.config.collapsedPreviewLines ?? 1;
		this.updateTokenInfo();
		this.activeEditorSubscription = this.todoService.activeEditor(this.scope).subscribe((activeId) => {
			if (activeId !== this.todo.id && this.isEditable) {
				this.saveEdit();
			}
		});
	}

	ngOnChanges(changes: SimpleChanges) {
		const todoChange = changes["todo"];
		if (todoChange) {
			this.updateTokenInfo();
		}
		if (todoChange && !todoChange.currentValue?.isMarkdown) {
			this.clearMermaidListeners();
		}

		if (!this.isEditable) {
			return;
		}

		const selectionModeChange = changes["selectionMode"];
		if (selectionModeChange?.currentValue) {
			this.saveEdit();
		}
	}

	collapse(event?: MouseEvent) {
		if (this.isEditable) {
			this.saveEdit();
		}
		this.todoService.toggleCollapsed(this.scope, { id: this.todo.id });
	}

	expand(event?: MouseEvent) {
		this.todoService.toggleCollapsed(this.scope, { id: this.todo.id });
	}

	getPreviewText(text: string): string {
		const lines = text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		return lines.slice(0, Math.max(1, this.collapsedPreviewLines)).join("\n");
	}

	private updateTokenInfo(): void {
		this.tokenInfo = this.buildTokenInfo(this.todo);
	}

	private buildTokenInfo(todo: Todo | undefined): TokenInfo {
		if (!todo) {
			return { badges: [], displayText: "" };
		}

		let displayText = todo.text ?? "";
		let shouldTrimStart = false;
		const badges: TokenBadge[] = [];
		let planSlug: string | undefined;

		const planItem = parsePlanItem(displayText);
		if (planItem) {
			planSlug = planItem.slug;
			badges.push({ kind: "plan", label: `@plan:${planItem.slug}` });
			displayText = planItem.text;
			shouldTrimStart = true;
		} else if (todo.isNote) {
			const header = parsePlanHeader(displayText);
			if (header) {
				planSlug = header.slug;
				badges.push({ kind: "plan", label: `@plan:${header.slug}` });
				const trimmed = displayText.trimStart();
				const lines = trimmed.split(/\r?\n/);
				const restLines = lines.slice(1).join("\n");
				const headerText = header.title || header.slug;
				displayText = [headerText, restLines].filter(Boolean).join("\n");
				shouldTrimStart = true;
			}
		}

		if (todo.isNote && matchesInstructionPrefix(displayText)) {
			badges.push({ kind: "instr", label: "@instr" });
			displayText = stripInstructionPrefix(displayText);
			shouldTrimStart = true;
		}

		return {
			badges,
			displayText: shouldTrimStart ? displayText.trimStart() : displayText,
			planSlug,
		};
	}

	onActionMenuOpened() {
		this.isActionMenuOpen = true;
	}

	onActionMenuClosed() {
		this.isActionMenuOpen = false;
	}

	onMarkdownReady(): void {
		this.refreshMermaidZoomTargets();
	}

	saveEdit() {
		const newText = this.todo.text.trim();
		// If edited text is empty, delete the item instead of saving an empty value.
		// Restore previous text on the object so UNDO can bring it back correctly.
		if (!newText.length) {
			this.todo.text = this.previousText;
			this.removeGlobalClickListener();
			this.isEditable = false;
			this.todoService.clearActiveEditor(this.scope, this.todo.id);
			this.delete.emit(this.todo);
			return;
		}
		this.todoService.editTodo(this.scope, { id: this.todo.id, newText });
		this.updateTokenInfo();
		this.isEditable = false;
		this.todoService.clearActiveEditor(this.scope, this.todo.id);
		this.removeGlobalClickListener();
	}

	cancelEdit() {
		this.todo.text = this.previousText;
		this.updateTokenInfo();
		this.isEditable = false;
		this.todoService.clearActiveEditor(this.scope, this.todo.id);
		this.removeGlobalClickListener();
	}

	toggleCompleted() {
		this.todoService.toggleTodo(this.scope, { id: this.todo.id });
	}

	edit(event?: MouseEvent) {
		if (this.selectionMode) {
			if (event) {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}

		if (event) {
			if (event.defaultPrevented) {
				return;
			}
			if (event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
		}
		// If clicked on a link don't edit
		if (event && (event.target as HTMLElement).tagName.toLowerCase() === "a") {
			return;
		}
		// If clicked on a vscode-button (or any descendant) don't edit
		if (event) {
			const path = event.composedPath();
			for (const element of path) {
				if (
					(element as HTMLElement).tagName &&
					(element as HTMLElement).tagName.toLowerCase() === "vscode-button"
				) {
					return;
				}
			}
		}
		this.previousText = this.todo.text;
		this.todoService.setActiveEditor(this.scope, this.todo.id);
		this.isEditable = true;
		this.clearMermaidListeners();
		setTimeout(() => {
			this.globalClickUnlistener = this.renderer.listen("document", "click", (event) => {
				if (!this.elRef.nativeElement.contains(event.target) && event.target.id !== "cancel-button") {
					this.saveEdit();
				}
			});
		}, 0);
	}

	setIsMarkdown(event: MouseEvent, isMarkdown: boolean) {
		event.stopPropagation();
		if (this.todo.isMarkdown === isMarkdown) return;
		this.todoService.toggleMarkdown(this.scope, { id: this.todo.id });
	}

	setIsNote(event: MouseEvent, isNote: boolean) {
		event.stopPropagation();
		if (this.todo.isNote === isNote) return;
		this.todoService.toggleTodoNote(this.scope, { id: this.todo.id });
	}

	onDelete(todo: Todo): void {
		this.delete.emit(todo);
	}

	archivePlan(action: "complete" | "delete"): void {
		const slug = this.tokenInfo.planSlug;
		if (!slug) {
			return;
		}
		this.todoService.archivePlan(this.scope, {
			slug,
			action,
			includeItems: true,
		});
	}

	requestPlanDelete(): void {
		const slug = this.tokenInfo.planSlug;
		if (!slug) {
			return;
		}
		this.planDelete.emit(slug);
	}

	copyPlanReference(): void {
		const query = this.getPlanQuery();
		if (!query) {
			return;
		}
		void this.copyToClipboard(query);
	}

	copyPlanContent(): void {
		const slug = this.tokenInfo.planSlug;
		if (!slug) {
			return;
		}
		const todos = this.getTodosForScope(this.scope);
		const lines = todos
			.filter((todo) => this.todoBelongsToPlan(todo, slug))
			.map((todo) => this.formatPlanTodoForCopy(todo, slug))
			.filter((text): text is string => Boolean(text))
			.filter((text) => text.length > 0);
		if (lines.length === 0) {
			return;
		}
		void this.copyToClipboard(lines.join("\n"));
	}

	filterByPlan(): void {
		const query = this.getPlanQuery();
		if (!query) {
			return;
		}
		this.todoService.setSearchQuery(query);
	}

	closeDiagramZoom(): void {
		this.diagramZoomOpen = false;
		this.zoomSvgSource = undefined;
	}

	private refreshMermaidZoomTargets(): void {
		this.clearMermaidListeners();
		const container = this.markdownContainer?.nativeElement;
		if (!container) {
			return;
		}

		this.injectMermaidZoomButtons(container);
		this.mermaidObserver = new MutationObserver(() => {
			this.injectMermaidZoomButtons(container);
		});
		this.mermaidObserver.observe(container, { childList: true, subtree: true });
	}

	private openDiagramZoom(svg: SVGSVGElement, event?: Event): void {
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}
		this.ngZone.run(() => {
			this.zoomSvgSource = svg;
			this.diagramZoomOpen = true;
			this.cdr.detectChanges();
		});
	}

	private clearMermaidListeners(): void {
		for (const unlisten of this.mermaidListeners) {
			unlisten();
		}
		this.mermaidListeners = [];
		if (this.mermaidObserver) {
			this.mermaidObserver.disconnect();
			this.mermaidObserver = undefined;
		}
	}

	private injectMermaidZoomButtons(container: HTMLElement): void {
		const mermaidBlocks = Array.from(container.querySelectorAll<Element>(".mermaid"));
		for (const block of mermaidBlocks) {
			const svg = this.getMermaidSvg(block);
			if (!svg) {
				continue;
			}
			const host = this.ensureMermaidZoomHost(block);
			const existingButton = host.querySelector(".mermaid-zoom-button");
			if (existingButton) {
				continue;
			}

			const zoomButton = this.renderer.createElement("vscode-button");
			zoomButton.classList.add("mermaid-zoom-button");
			zoomButton.setAttribute("appearance", "icon");
			zoomButton.setAttribute("aria-label", "Zoom");
			zoomButton.setAttribute("title", "Zoom");

			const zoomIcon = this.renderer.createElement("span");
			this.renderer.setProperty(
				zoomIcon,
				"innerHTML",
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path fill="#C5C5C5" d="M11.742 10.344a6.5 6.5 0 1 0-1.398 1.398l2.48 2.48a1 1 0 0 0 1.414-1.414l-2.496-2.464zM6.5 11A4.5 4.5 0 1 1 6.5 2a4.5 4.5 0 0 1 0 9z"/><path fill="#C5C5C5" d="M6.5 4a.5.5 0 0 1 .5.5V6h1.5a.5.5 0 0 1 0 1H7v1.5a.5.5 0 0 1-1 0V7H4.5a.5.5 0 0 1 0-1H6V4.5a.5.5 0 0 1 .5-.5z"/></svg>'
			);
			zoomButton.appendChild(zoomIcon);
			host.appendChild(zoomButton);

			this.mermaidListeners.push(
				this.renderer.listen(zoomButton, "click", (event: MouseEvent) => {
					this.openDiagramZoom(svg, event);
				})
			);
			this.mermaidListeners.push(
				this.renderer.listen(zoomButton, "keydown", (event: KeyboardEvent) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						this.openDiagramZoom(svg, event);
					}
				})
			);
		}
	}

	private getMermaidSvg(block: Element): SVGSVGElement | null {
		if (block instanceof SVGSVGElement) {
			return block as SVGSVGElement;
		}
		const svg = block.querySelector("svg") as SVGSVGElement | null;
		return svg ?? null;
	}

	private ensureMermaidZoomHost(block: Element): HTMLElement {
		if (block instanceof SVGSVGElement) {
			const svg = block as SVGSVGElement;
			const parent = svg.parentElement;
			if (parent && parent.classList.contains("mermaid-zoom-target")) {
				return parent;
			}
			const wrapper = this.renderer.createElement("div");
			wrapper.classList.add("mermaid-zoom-target");
			if (parent) {
				parent.insertBefore(wrapper, svg);
			}
			wrapper.appendChild(svg);
			return wrapper;
		}
		const host = block as HTMLElement;
		host.classList.add("mermaid-zoom-target");
		return host;
	}

	private removeGlobalClickListener(): void {
		if (this.globalClickUnlistener) {
			this.globalClickUnlistener();
		}
	}

	private getPlanQuery(): string | null {
		const slug = this.tokenInfo.planSlug;
		if (!slug) {
			return null;
		}
		return `@plan:${slug}`;
	}

	private getTodosForScope(scope: TodoScope): Todo[] {
		switch (scope) {
			case TodoScope.user:
				return this.todoService.userTodos;
			case TodoScope.workspace:
				return this.todoService.workspaceTodos;
			case TodoScope.currentFile:
				return this.todoService.currentFileTodos;
			default:
				return [];
		}
	}

	private todoBelongsToPlan(todo: Todo, slug: string): boolean {
		const planItem = parsePlanItem(todo.text);
		if (planItem && planItem.slug === slug) {
			return true;
		}
		if (todo.isNote) {
			const header = parsePlanHeader(todo.text);
			if (header && header.slug === slug) {
				return true;
			}
		}
		return false;
	}

	private formatPlanTodoForCopy(todo: Todo, slug: string): string | null {
		const content = this.getPlanCopyText(todo, slug);
		if (!content) {
			return null;
		}
		if (todo.isNote) {
			return content.trimEnd();
		}
		const lines = content.split(/\r?\n/);
		const first = lines[0] ?? "";
		const rest = lines.slice(1);
		const prefix = `- [${todo.completed ? "x" : " "}] `;
		let result = `${prefix}${first}`;
		if (rest.length > 0) {
			result += "\n" + rest.map((line) => `  ${line}`).join("\n");
		}
		return result.trimEnd();
	}

	private getPlanCopyText(todo: Todo, slug: string): string | null {
		const planItem = parsePlanItem(todo.text);
		if (planItem && planItem.slug === slug) {
			return planItem.text.trimEnd();
		}
		if (todo.isNote) {
			const header = parsePlanHeader(todo.text);
			if (header && header.slug === slug) {
				const trimmed = todo.text.trimStart();
				const lines = trimmed.split(/\r?\n/);
				const restLines = lines.slice(1).join("\n");
				const headerText = header.title || header.slug;
				return [headerText, restLines].filter(Boolean).join("\n").trimEnd();
			}
		}
		return null;
	}

	private async copyToClipboard(text: string): Promise<void> {
		try {
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return;
			}
		} catch {
			// fall through to legacy approach
		}

		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		try {
			(document as any).execCommand("copy");
		} finally {
			document.body.removeChild(textarea);
		}
	}

	ngOnDestroy(): void {
		this.removeGlobalClickListener();
		this.clearMermaidListeners();
		if (this.activeEditorSubscription) {
			this.activeEditorSubscription.unsubscribe();
		}
		this.todoService.clearActiveEditor(this.scope, this.todo.id);
	}
}
