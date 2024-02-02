import { Component, Input } from "@angular/core";
import { TodoLevel } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";

@Component({
	selector: "new-todo",
	templateUrl: "./new-todo.component.html",
	styleUrls: ["./new-todo.component.css"],
})
export class NewTodoComponent {
	newTodoText: string = "";
	@Input() level!: TodoLevel;
	constructor(private todoService: TodoService) {}

	addTodo() {
		if (this.newTodoText === "") return;
		this.todoService.addTodo({ text: this.newTodoText, level: this.level });
		this.newTodoText = "";
	}

	onTextInserted(value: string) {
		this.newTodoText = value;
	}
}
