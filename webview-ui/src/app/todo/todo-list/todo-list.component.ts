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
		if (!thisTodo ) return;
		this.todoService.editTodo(this.scope, { id, newText: thisTodo.text.trim() });
		this.toggleEdit(id);
	}

	cancelEdit(id: number) {
		const thisTodo = this.todos.find((todo) => todo.id === id);
		if (thisTodo) thisTodo.text = this.componentState[id]?.previousText || "";
		this.toggleEdit(id);
	}

	toggleCompleted(id: number) {
		this.todoService.toggleTodo(this.scope, { id });
	}

	delete(id: number) {
		this.todoService.deleteTodo(this.scope, { id });
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
	 * Predicate function that only allows sorting items
	 * within their respective completed or incomplete
	 * categories, without intermixing.
	 */
	sortPredicate = (index: number, item: CdkDrag<Todo>): boolean => {
		if (this.scope === TodoScope.user) {
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
