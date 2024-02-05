import { CdkDrag, CdkDragDrop, moveItemInArray } from "@angular/cdk/drag-drop";
import { ChangeDetectorRef, Component, Input, OnInit } from "@angular/core";
import { Subscription } from "rxjs";
import { Todo, TodoLevel } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";

@Component({
	selector: "todo-list",
	templateUrl: "./todo-list.component.html",
	styleUrls: ["./todo-list.component.scss"],
})
export class TodoList implements OnInit {
	@Input()
	level!: TodoLevel;

	todos: Todo[] = [];
	userTodos: Todo[] = [];
	workspaceTodos: Todo[] = [];
	isChecked = false;
	todoCount = 0;
	isAnimationEnabled = false;
	private lastActionTypeSubscription!: Subscription;

	autoAnimateEnabledMap: { [key: string]: boolean } = {
		"todos/addTodo": true,
		"todos/deleteTodo": true,
		"todos/toggleTodo": true,
	};

	//Store temporary UI state
	componentState: {
		[id: number]: {
			isEditable?: boolean;
			previousText?: string;
			footerActive?: boolean;
		};
	} = {};

	constructor(private todoService: TodoService, private cdRef: ChangeDetectorRef) {}

	ngOnInit(): void {
		// Get data
		if (this.level === TodoLevel.user) {
			this.todos = this.todoService.userTodos;
		} else {
			this.todos = this.todoService.workspaceTodos;
		}

		// Control animation based on last action
		this.lastActionTypeSubscription = this.todoService.lastActionType.subscribe((actionType) => {
			this.isAnimationEnabled = this.autoAnimateEnabledMap.hasOwnProperty(actionType)
				? this.autoAnimateEnabledMap[actionType]
				: false;
			this.cdRef.detectChanges();
		});
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

	dragStarted() {
		this.isAnimationEnabled = false;
		this.cdRef.detectChanges();
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

	ngOnDestroy(): void {
		// Clean up the subscription
		if (this.lastActionTypeSubscription) {
			this.lastActionTypeSubscription.unsubscribe();
		}
	}
}
