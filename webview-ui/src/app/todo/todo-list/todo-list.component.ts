import { animate, style, transition, trigger } from "@angular/animations";
import { CdkDrag, CdkDragDrop, moveItemInArray } from "@angular/cdk/drag-drop";
import {
    AfterViewInit,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    ElementRef,
    Input,
    OnInit,
    QueryList,
    ViewChildren,
} from "@angular/core";
import { MatSnackBar } from "@angular/material/snack-bar";
import { firstValueFrom, Subscription } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { TodoService } from "../todo.service";

@Component({
    selector: "todo-list",
    templateUrl: "./todo-list.component.html",
    styleUrls: ["./todo-list.component.scss"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    animations: [
        trigger("leaveAnimation", [
            transition(":leave", [
                animate(300, style({
                    transform: "scale(.5)",
                    opacity: 0,
                    easing: "ease-out",
                })),
            ]),
        ]),
        trigger("enterAnimation", [
            transition(":enter", [
                style({ opacity: 0, transform: "translateY(8px)" }),
                animate(
                    "200ms ease-out",
                    style({ opacity: 1, transform: "translateY(0)" })
                ),
            ]),
        ]),
    ],
    standalone: false
})
export class TodoList implements OnInit, AfterViewInit {
	@Input()
	scope!: TodoScope;
	todos: Todo[] = [];
	todoCount = 0;
    isEnterAnimationEnabled = false;
	isLeaveAnimationEnabled = false;
	isInitialized = false;
    private lastActionTypeSubscription!: Subscription;
    private lastActionName: string | null = null;
    @ViewChildren("dragItem", { read: ElementRef }) private dragItemEls!: QueryList<ElementRef<HTMLElement>>;
    isDragging = false;

    enterAnimationEnabledActions: string[] = ["addTodo", "toggleTodo", "undoDelete"];

	constructor(
		private todoService: TodoService,
		private cdRef: ChangeDetectorRef,
		private snackBar: MatSnackBar
	) {}

	ngOnInit(): void {
		let lastAction;

		switch (this.scope) {
			case TodoScope.user:
				lastAction = this.todoService.userLastAction;
				break;
			case TodoScope.workspace:
				lastAction = this.todoService.workspaceLastAction;
				break;
			case TodoScope.currentFile:
				lastAction = this.todoService.currentFileLastAction;
				break;
		}
		this.lastActionTypeSubscription = lastAction.subscribe(this.handleSubscription.bind(this));
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
        this.lastActionName = actionType;
        // enter animation
        const isAllowedEnter = this.enterAnimationEnabledActions.includes(actionType);
        this.isEnterAnimationEnabled = this.isInitialized && !this.isDragging && isAllowedEnter;

        // leave animation
        const loadData = actionType === "loadData";
        this.isLeaveAnimationEnabled = !loadData && !this.isDragging;

        this.cdRef.detectChanges();
    }

    pullTodos() {
        const prevRects = this.isInitialized ? this.snapshotRects() : new Map<number, DOMRect>();

        switch (this.scope) {
            case TodoScope.user:
                this.todos = [...this.todoService.userTodos];
                break;
            case TodoScope.workspace:
                this.todos = [...this.todoService.workspaceTodos];
                break;
            case TodoScope.currentFile:
                this.todos = [...this.todoService.currentFileTodos];
                break;
        }
        this.cdRef.detectChanges();

        if (this.isInitialized && this.lastActionName !== "loadData" && !this.isDragging) {
            this.animateReorder(prevRects);
        }
    }

	onDrop(event: CdkDragDrop<Todo[]>) {
		// Move item within the array and update the order
		moveItemInArray(this.todos, event.previousIndex, event.currentIndex);

		this.todoService.reorderTodos(this.scope, {
			reorderedTodos: this.todos,
		});
	}

    dragStarted() {
        this.isDragging = true;
        this.isEnterAnimationEnabled = false; // prevent enter animations mid-drag
    }

    dragEnded() {
        this.isDragging = false;
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
		const { taskSortingOptions } = this.todoService.config;

		switch (taskSortingOptions) {
			case "disabled":
				return true;
			case "sortType1":
				return this.sortType1Predicate(index, item);
			case "sortType2":
				return this.sortType2Predicate(index, item);
		}
    };

	sortType1Predicate = (index: number, item: CdkDrag<Todo>): boolean => {
		const originalIndex = this.todos.findIndex((todo) => todo.id === item.data.id);
		const targetTodo = this.todos[index];
		const nextTodo = this.todos[index + 1];
		const prevTodo = this.todos[index - 1];

		// Dragging a note.
		if (item.data.isNote) {
			if (targetTodo.isNote || !targetTodo.completed) return true;
		}
		// Dragging a completed todo.
		else if (item.data.completed) {
			// Allow drop to the last position or onto another completed todo.
			if (index === this.todos.length - 1 || (targetTodo.completed && !targetTodo.isNote)) return true;

			// Dropping onto a note has specific rules based on item original position.
			if (targetTodo.isNote) {
				if (originalIndex < index && (!nextTodo || nextTodo.completed)) return true;
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

	sortType2Predicate = (index: number, item: CdkDrag<Todo>): boolean => {
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

	async handleDelete(todo: Todo) {
		let currentFilePath = null;
		if (this.scope === TodoScope.currentFile) {
			currentFilePath = await firstValueFrom(this.todoService.currentFilePath);
		}
		const deletedItem = todo;
		const itemPosition = this.todos.indexOf(todo);
		this.todoService.deleteTodo(this.scope, { id: todo.id });
		// Snackbar with 'UNDO' button
		const snackBarRef = this.snackBar.open("Todo deleted", "UNDO", {
			duration: 5000,
		});
		snackBarRef.onAction().subscribe(() => {
			this.todoService.undoDelete(this.scope, {
				...deletedItem,
				itemPosition,
				currentFilePath,
			});
		});
	}

    ngOnDestroy(): void {
        // Clean up the subscription
        if (this.lastActionTypeSubscription) {
            this.lastActionTypeSubscription.unsubscribe();
        }
    }

    // --- FLIP helpers ---
    private snapshotRects(): Map<number, DOMRect> {
        const map = new Map<number, DOMRect>();
        if (!this.dragItemEls) return map;
        this.dragItemEls.forEach((ref) => {
            const el = ref.nativeElement;
            const idAttr = el.getAttribute("data-id");
            if (!idAttr) return;
            const id = Number(idAttr);
            if (Number.isFinite(id)) {
                map.set(id, el.getBoundingClientRect());
            }
        });
        return map;
    }

    private animateReorder(prevRects: Map<number, DOMRect>): void {
        if (!this.dragItemEls || prevRects.size === 0) return;
        // Run on next frame to ensure layout is up-to-date
        requestAnimationFrame(() => {
            this.dragItemEls.forEach((ref) => {
                const el = ref.nativeElement;
                const idAttr = el.getAttribute("data-id");
                if (!idAttr) return;
                const id = Number(idAttr);
                const prev = prevRects.get(id);
                if (!prev) return; // new element, let enter animation handle it
                const next = el.getBoundingClientRect();
                const dx = prev.left - next.left;
                const dy = prev.top - next.top;
                if (dx === 0 && dy === 0) return;
                try {
                    // Use WAAPI for smooth transform without layout thrash
                    el.animate(
                        [
                            { transform: `translate(${dx}px, ${dy}px)` },
                            { transform: "translate(0, 0)" },
                        ],
                        { duration: 300, easing: "ease-out" }
                    );
                } catch {
                    // Fallback using CSS transition
                    el.style.transform = `translate(${dx}px, ${dy}px)`;
                    // force reflow
                    void el.getBoundingClientRect();
                    el.style.transition = "transform 300ms ease-out";
                    el.style.transform = "translate(0, 0)";
                    const clear = () => {
                        el.style.transition = "";
                        el.style.transform = "";
                        el.removeEventListener("transitionend", clear);
                    };
                    el.addEventListener("transitionend", clear);
                }
            });
        });
    }
}
