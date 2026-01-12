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
import { TodoService } from "../todo.service";

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
	@Output() delete: EventEmitter<Todo> = new EventEmitter();
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
		this.activeEditorSubscription = this.todoService.activeEditor(this.scope).subscribe((activeId) => {
			if (activeId !== this.todo.id && this.isEditable) {
				this.saveEdit();
			}
		});
	}

	ngOnChanges(changes: SimpleChanges) {
		const todoChange = changes["todo"];
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
		this.isEditable = false;
		this.todoService.clearActiveEditor(this.scope, this.todo.id);
		this.removeGlobalClickListener();
	}

	cancelEdit() {
		this.todo.text = this.previousText;
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

	ngOnDestroy(): void {
		this.removeGlobalClickListener();
		this.clearMermaidListeners();
		if (this.activeEditorSubscription) {
			this.activeEditorSubscription.unsubscribe();
		}
		this.todoService.clearActiveEditor(this.scope, this.todo.id);
	}
}
