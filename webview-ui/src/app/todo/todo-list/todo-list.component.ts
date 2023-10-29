import { Component, Input } from "@angular/core";
import { Todo, TodoLevel } from "../../../../../src/todo/store";
import { TodoService } from "../todo.service";

@Component({
	selector: "todo-list",
	templateUrl: "./todo-list.component.html",
	styleUrls: ["./todo-list.component.css"],
})
export class TodoList {
	@Input()
	level!: TodoLevel;
	todos: Todo[] = [];
	userTodos: Todo[] = [];
	workspaceTodos: Todo[] = [];
	//Store temporary UI state
	componentState: {
		[id: number]: {
			isEditable?: boolean;
			previousText?: string;
		};
	} = {};

	constructor(private todoService: TodoService) {}

	ngOnInit(): void {
		// Get data
		if (this.level === TodoLevel.user) {
			this.todos = this.todoService.userTodos;
		} else {
			this.todos = this.todoService.workspaceTodos;
		}
	}

	toggleEdit(id: number) {
		if (this.componentState[id] === undefined) {
			this.componentState[id] = {};
		}
		this.componentState[id].previousText = this.todos.find((todo) => todo.id === id)?.text;
		this.componentState[id].isEditable = !this.componentState[id].isEditable;
	}

	saveEdit(id: number) {
		const thisTodo = this.todos.find((todo) => todo.id === id);
		if (!thisTodo) return;
		this.todoService.editTodo({ id, level: this.level, newText: thisTodo.text });
		this.toggleEdit(id);
	}

	cancelEdit(id: number) {
		const thisTodo = this.todos.find((todo) => todo.id === id);
		if (thisTodo) thisTodo.text = this.componentState[id]?.previousText || "";
		this.toggleEdit(id);
	}

	toggleCompleted(id: number) {
		this.todoService.toggleTodo({ id, level: this.level });
	}

	delete(id: number) {
		this.todoService.removeTodo({ id, level: this.level });
	}
}
