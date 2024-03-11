import { Component, EventEmitter, Input, Output } from "@angular/core";
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
	@Output() delete: EventEmitter<Todo> = new EventEmitter();

	constructor(private todoService: TodoService) {}

	saveEdit() {
		this.todoService.editTodo(this.scope, { id: this.todo.id, newText: this.todo.text.trim() });
		this.isEditable = false;
	}

	cancelEdit() {
		this.todo.text = this.previousText;
		this.isEditable = false;
	}

	toggleCompleted() {
		this.todoService.toggleTodo(this.scope, { id: this.todo.id });
	}

	edit() {
		this.previousText = this.todo.text;
		this.isEditable = true;
	}

	onDelete(todo: Todo): void {
		this.delete.emit(todo);
	}
}
