import { Component, Input, OnChanges, SimpleChanges } from "@angular/core";
import { TodoScope } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";

@Component({
	selector: "new-todo",
	templateUrl: "./new-todo.component.html",
	styleUrls: ["./new-todo.component.css"],
})
export class NewTodoComponent implements OnChanges {
	newTodoText: string = "";
	@Input() scope!: TodoScope;
	@Input() currentFilePath!: string;
	isCurrentFileEmpty = false;

	constructor(private todoService: TodoService) {}

	ngOnChanges(changes: SimpleChanges) {
		if (changes["currentFilePath"] || changes["scope"]) {
			this.isCurrentFileEmpty = this.currentFilePath === "" && this.scope === TodoScope.currentFile;
		}
	}

	addTodo($event: Event) {
		$event.preventDefault();
		if (!this.newTodoText.trim().length || this.isCurrentFileEmpty) return;
		this.todoService.addTodo(this.scope, { text: this.newTodoText.trim() });
		this.newTodoText = "";
	}

	onTextInserted(value: string) {
		this.newTodoText = value;
	}
}
