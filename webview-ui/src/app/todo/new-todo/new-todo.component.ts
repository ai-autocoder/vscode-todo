import { Component, Input } from "@angular/core";
import { TodoScope } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";

@Component({
	selector: "new-todo",
	templateUrl: "./new-todo.component.html",
	styleUrls: ["./new-todo.component.css"],
})
export class NewTodoComponent {
	newTodoText: string = "";
	@Input() scope!: TodoScope;
	constructor(private todoService: TodoService) {}

	addTodo() {
		if (this.newTodoText === "") return;
		this.todoService.addTodo(this.scope, { text: this.newTodoText });
		this.newTodoText = "";
	}

	onTextInserted(value: string) {
		this.newTodoText = value;
	}
}
