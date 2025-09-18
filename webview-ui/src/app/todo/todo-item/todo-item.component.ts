import {
	Component,
	ElementRef,
	EventEmitter,
	Input,
	OnChanges,
	OnInit,
	Output,
	Renderer2,
	SimpleChanges,
} from "@angular/core";
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
	isEditable = false;
	footerActive?: boolean;
	previousText!: string;
	isActionMenuOpen = false;
	enableLineNumbers: boolean = false;
	enableMarkdownDiagrams: boolean = true;
	enableMarkdownKatex: boolean = true;
	collapsedPreviewLines: number = 1;
	@Output() delete: EventEmitter<Todo> = new EventEmitter();
	private globalClickUnlistener?: () => void;

	constructor(
		private todoService: TodoService,
		private renderer: Renderer2,
		private elRef: ElementRef
	) {}

	ngOnInit() {
		this.enableLineNumbers = this.todoService.config.enableLineNumbers;
		this.enableMarkdownDiagrams = this.todoService.config.enableMarkdownDiagrams;
		this.enableMarkdownKatex = this.todoService.config.enableMarkdownKatex;
		this.collapsedPreviewLines = this.todoService.config.collapsedPreviewLines ?? 1;
	}

	ngOnChanges(changes: SimpleChanges) {
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

		saveEdit() {
		const newText = this.todo.text.trim();
		// If edited text is empty, delete the item instead of saving an empty value.
		// Restore previous text on the object so UNDO can bring it back correctly.
		if (!newText.length) {
			this.todo.text = this.previousText;
			this.removeGlobalClickListener();
			this.isEditable = false;
			this.delete.emit(this.todo);
			return;
		}
		this.todoService.editTodo(this.scope, { id: this.todo.id, newText });
		this.isEditable = false;
		this.removeGlobalClickListener();
	}

	cancelEdit() {
		this.todo.text = this.previousText;
		this.isEditable = false;
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
		this.isEditable = true;
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

	private removeGlobalClickListener(): void {
		if (this.globalClickUnlistener) {
			this.globalClickUnlistener();
		}
	}

	ngOnDestroy(): void {
		this.removeGlobalClickListener();
	}
}
