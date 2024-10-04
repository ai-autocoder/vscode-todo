import { Component, ElementRef, EventEmitter, Input, Output, Renderer2 } from "@angular/core";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";

@Component({
	selector: "todo-item",
	templateUrl: "./todo-item.component.html",
	styleUrls: ["./todo-item.component.scss"],
})
export class TodoItemComponent {
	@Input() todo!: Todo;
	@Input() scope!: TodoScope;
	@Input() dragging = false;
	isEditable = false;
	footerActive?: boolean;
	previousText!: string;
	isActionMenuOpen = false;
	@Output() delete: EventEmitter<Todo> = new EventEmitter();
	private globalClickUnlistener?: () => void;

	constructor(
		private todoService: TodoService,
		private renderer: Renderer2,
		private elRef: ElementRef
	) {}

	onActionMenuOpened() {
		this.isActionMenuOpen = true;
	}

	onActionMenuClosed() {
		this.isActionMenuOpen = false;
	}

	saveEdit() {
		this.todoService.editTodo(this.scope, { id: this.todo.id, newText: this.todo.text.trim() });
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
