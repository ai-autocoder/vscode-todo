import { Component, Input } from "@angular/core";
import { Todo, TodoLevel } from "../../../../../src/todo/store";
import { TodoService } from "../todo.service";
import { CdkDragDrop, moveItemInArray } from "@angular/cdk/drag-drop";

@Component({
	selector: "todo-list",
	templateUrl: "./todo-list.component.html",
	styleUrls: ["./todo-list.component.scss"],
})
export class TodoList {
	@Input()
	level!: TodoLevel;
	todos: Todo[] = [];
	userTodos: Todo[] = [];
	workspaceTodos: Todo[] = [];
	isChecked: boolean = false;

	//Store temporary UI state
	componentState: {
		[id: number]: {
			isEditable?: boolean;
			previousText?: string;
			footerActive?: boolean;
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

	toggleFooter(id: number) {
		if (this.componentState[id] === undefined) {
			this.componentState[id] = {};
		}
		if (!this.componentState[id].isEditable) {
			this.componentState[id].footerActive = !this.componentState[id].footerActive;
		}
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

	onDrop(event: CdkDragDrop<Todo[]>) {
		// Move item within the array and update the order
		moveItemInArray(this.todos, event.previousIndex, event.currentIndex);

		this.todoService.reorderTodos({
			level: this.level,
			reorderedTodos: this.todos,
		});
	}
}
