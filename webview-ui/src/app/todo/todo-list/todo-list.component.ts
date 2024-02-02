import { AfterViewInit, Component, Input, OnInit } from "@angular/core";
import { Todo, TodoLevel } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";
import { CdkDrag, CdkDragDrop, moveItemInArray } from "@angular/cdk/drag-drop";
import { trigger, style, transition, animate } from "@angular/animations";

@Component({
	selector: "todo-list",
	templateUrl: "./todo-list.component.html",
	styleUrls: ["./todo-list.component.scss"],
	animations: [
		trigger("fadeAnimation", [
			transition(":enter", [
				style({
					transform: "translateY(calc(100vh - 200px))",
				}),
				animate(150),
			]),
			transition(":leave", [
				animate(
					200,
					style({
						opacity: "0",
						transform: "translateX(300px)",
					})
				),
			]),
		]),
	],
})
export class TodoList implements OnInit, AfterViewInit {
	@Input()
	level!: TodoLevel;

	todos: Todo[] = [];
	userTodos: Todo[] = [];
	workspaceTodos: Todo[] = [];
	isChecked = false;
	todoCount = 0;
	animationDisabled = true;

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

	ngAfterViewInit(): void {
		// Enable animations after first render
		setTimeout(() => {
			this.animationDisabled = false;
		}, 200);
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

	/**
	 * Predicate function that only allows sorting items
	 * within their respective completed or incomplete
	 * categories, without intermixing.
	 */
	sortPredicate = (index: number, item: CdkDrag<Todo>): boolean => {
		if (this.level === TodoLevel.user) {
			this.todoCount = this.todoService.todoCount.user;
		} else {
			this.todoCount = this.todoService.todoCount.workspace;
		}
		return item.data.completed ? index > this.todoCount - 1 : index < this.todoCount;
	};

	trackById(index: number, todo: Todo): number {
		return todo.id;
	}
}
