import { CdkDrag, CdkDragDrop, moveItemInArray } from "@angular/cdk/drag-drop";
import {
	AfterViewInit,
	ChangeDetectionStrategy,
	ChangeDetectorRef,
	Component,
	Input,
	OnInit,
} from "@angular/core";
import { Subscription } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";
import { MatSnackBar } from "@angular/material/snack-bar";

@Component({
	selector: "todo-list",
	templateUrl: "./todo-list.component.html",
	styleUrls: ["./todo-list.component.scss"],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TodoList implements OnInit, AfterViewInit {
	@Input()
	scope!: TodoScope;
	todos: Todo[] = [];
	todoCount = 0;
	isAnimationEnabled = false;
	isInitialized = false;
	private lastActionTypeSubscription!: Subscription;
	autoAnimateOptions = {
		duration: 0,
	};

	autoAnimateEnabledMap: { [key: string]: boolean } = {
		addTodo: true,
		deleteTodo: true,
		toggleTodo: true,
	};

	constructor(
		private todoService: TodoService,
		private cdRef: ChangeDetectorRef,
		private snackBar: MatSnackBar
	) {}

	ngOnInit(): void {
		if (this.scope === TodoScope.user) {
			this.lastActionTypeSubscription = this.todoService.userLastAction.subscribe((actionType) =>
				this.handleSubscription(actionType)
			);
		} else if (this.scope === TodoScope.workspace) {
			this.lastActionTypeSubscription = this.todoService.workspaceLastAction.subscribe((actionType) =>
				this.handleSubscription(actionType)
			);
		}
	}

	ngAfterViewInit(): void {
		this.isInitialized = true;
	}

	handleSubscription(actionType: string) {
		this.handleAnimations(actionType);
		this.pullTodos();
	}

	handleAnimations(actionType: string): void {
		actionType = actionType.split("/")[1];
		if (this.autoAnimateEnabledMap.hasOwnProperty(actionType) && this.isInitialized) {
			this.autoAnimateOptions.duration = 300;
		} else {
			this.autoAnimateOptions.duration = 0;
		}
		this.cdRef.detectChanges();
	}

	pullTodos() {
		if (this.scope === TodoScope.user) {
			this.todos = [...this.todoService.userTodos];
		} else {
			this.todos = [...this.todoService.workspaceTodos];
		}
		this.cdRef.detectChanges();
	}

	onDrop(event: CdkDragDrop<Todo[]>) {
		// Move item within the array and update the order
		moveItemInArray(this.todos, event.previousIndex, event.currentIndex);

		this.todoService.reorderTodos(this.scope, {
			reorderedTodos: this.todos,
		});
	}

	dragStarted() {
		this.autoAnimateOptions.duration = 0;
		this.cdRef.detectChanges();
	}

	/**
	 * Determines whether the dragged item can be dropped at the specified position.
	 *
	 * Parameters:
	 * - index: number - The index at which the item is being dropped.
	 * - item: CdkDrag<Todo> - The item being dragged.
	 *
	 * Returns:
	 * - boolean - `true` if the item can be dropped at the index, `false` otherwise.
	 */
	sortPredicate = (index: number, item: CdkDrag<Todo>): boolean => {
		// Dragging a note.
		if (item.data.isNote) return true;

		const originalIndex = this.todos.findIndex((todo) => todo.id === item.data.id);
		const targetTodo = this.todos[index];
		const nextTodo = this.todos[index + 1];
		const prevTodo = this.todos[index - 1];

		// Dragging a completed todo.
		if (item.data.completed) {
			// Allow drop to the last position or onto another completed todo.
			if (index === this.todos.length - 1 || targetTodo.completed) return true;

			// Dropping onto a note has specific rules based on item original position.
			if (targetTodo.isNote) {
				if (originalIndex < index && (!nextTodo || nextTodo.completed)) return true;
				if (originalIndex > index) return true;
			} else {
				// Dropping onto an incomplete todo.
				return originalIndex < index && nextTodo?.completed;
			}
		} else {
			// Dragging an incomplete todo.
			if (index === 0 || !targetTodo.completed || targetTodo.isNote) return true;

			// Dropping onto a completed todo.
			if (targetTodo.completed && originalIndex > index) {
				return prevTodo?.isNote || !prevTodo?.completed;
			}
		}

		return false; // Default to not allowing drop for unhandled cases.
	};

	trackById(index: number, todo: Todo): number {
		return todo.id;
	}

	handleDelete(todo: Todo) {
		const deletedItem = todo;
		this.todoService.deleteTodo(this.scope, { id: todo.id });
		// Snackbar with undo
		const snackBarRef = this.snackBar.open("Todo deleted", "UNDO", {
			duration: 5000,
		});
		snackBarRef.onAction().subscribe(() => {
			this.todoService.addTodo(this.scope, {
				text: deletedItem.text,
			});
		});
	}

	ngOnDestroy(): void {
		// Clean up the subscription
		if (this.lastActionTypeSubscription) {
			this.lastActionTypeSubscription.unsubscribe();
		}
	}
}
