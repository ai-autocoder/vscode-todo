import { animate, style, transition, trigger } from "@angular/animations";
import { CdkDrag, CdkDragDrop, moveItemInArray } from "@angular/cdk/drag-drop";
import {
	AfterViewInit,
	ChangeDetectionStrategy,
	ChangeDetectorRef,
	Component,
	ElementRef,
	effect,
	Input,
	inject,
	OnInit,
	QueryList,
	ViewChildren,
	HostListener,
} from "@angular/core";
import { MatSnackBar, MatSnackBarRef } from "@angular/material/snack-bar";
import { firstValueFrom, Subscription } from "rxjs";
import { Todo, TodoScope } from "../../../../../src/todo/todoTypes";
import { parsePlanHeader, parsePlanItem } from "../../../../../src/todo/todoTokens";
import { SelectionCommand, TodoService } from "../todo.service";

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
	private readonly todoService = inject(TodoService);
	private readonly cdRef = inject(ChangeDetectorRef);
	private readonly snackBar = inject(MatSnackBar);
	private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

	@Input()
	scope!: TodoScope;
	todos: Todo[] = [];
	private allTodos: Todo[] = [];
	todoCount = 0;
    isEnterAnimationEnabled = false;
	isLeaveAnimationEnabled = false;
	isInitialized = false;
	isFilterActive = false;
    private lastActionTypeSubscription!: Subscription;
    private selectionCommandSubscription?: Subscription;
    private lastActionName: string | null = null;
    @ViewChildren("dragItem", { read: ElementRef }) private dragItemEls!: QueryList<ElementRef<HTMLElement>>;
    isDragging = false;
    private readonly reorderAnimationExcludedActions = new Set<string>(["editTodo"]);

    selectedTodoIds = new Set<number>();
    private selectionAnchorId: number | null = null;

    enterAnimationEnabledActions: string[] = ["addTodo", "toggleTodo", "undoDelete"];

	private searchQuery = "";
	private readonly searchEffect = effect(() => {
		const query = this.todoService.normalizedSearchQuery();
		if (query === this.searchQuery) {
			return;
		}
		this.searchQuery = query;
		this.applyFilter(false, true);
	});

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
		this.selectionCommandSubscription = this.todoService.selectionCommand(this.scope).subscribe((command) => this.handleSelectionCommand(command));
		this.publishSelectionState();
	}

	ngAfterViewInit(): void {
		this.isInitialized = true;
	}

    handleSubscription(actionType: string) {
        this.handleAnimations(actionType);
        this.pullTodos();
    }

    private handleSelectionCommand(command: SelectionCommand): void {
        switch (command) {
            case "selectAll":
                this.selectAll();
                break;
            case "deleteSelected":
                void this.deleteSelected();
                break;
            case "deleteCompleted":
                void this.deleteCompleted();
                break;
            case "clearSelection":
                this.clearSelection();
                break;
        }
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

    private shouldRunReorderAnimation(): boolean {
        if (!this.isInitialized || this.isDragging) {
            return false;
        }
		if (this.isFilterActive) {
			return false;
		}

        if (!this.lastActionName || this.lastActionName === "loadData") {
            return false;
        }

        return !this.reorderAnimationExcludedActions.has(this.lastActionName);
    }

    pullTodos() {
        const prevRects = this.isInitialized ? this.snapshotRects() : new Map<number, DOMRect>();
		const query = this.todoService.normalizedSearchQuery();
		this.searchQuery = query;
		const suppressAnimations = query.length > 0 && !this.isInitialized;

        switch (this.scope) {
            case TodoScope.user:
                this.allTodos = [...this.todoService.userTodos];
                break;
            case TodoScope.workspace:
                this.allTodos = [...this.todoService.workspaceTodos];
                break;
            case TodoScope.currentFile:
                this.allTodos = [...this.todoService.currentFileTodos];
                break;
        }
        this.applyFilter(true, suppressAnimations, query);

        if (this.shouldRunReorderAnimation()) {
            this.animateReorder(prevRects);
        }
    }

	private applyFilter(
		shouldDetectChanges: boolean,
		suppressAnimations: boolean,
		queryOverride?: string
	): void {
		if (!this.scope) {
			return;
		}

		const query = queryOverride ?? this.searchQuery;
		this.isFilterActive = query.length > 0;

		if (suppressAnimations) {
			this.isEnterAnimationEnabled = false;
			this.isLeaveAnimationEnabled = false;
		}

		if (this.isFilterActive) {
			this.todos = this.allTodos.filter((todo) =>
				todo.text.toLowerCase().includes(query)
			);
		} else {
			this.todos = [...this.allTodos];
		}

		this.syncSelectionWithTodos();
		if (shouldDetectChanges) {
			this.cdRef.detectChanges();
		} else {
			this.cdRef.markForCheck();
		}
	}

	onDrop(event: CdkDragDrop<Todo[]>) {
		if (this.isFilterActive) {
			return;
		}
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

    get hasSelection(): boolean {
        return this.selectedTodoIds.size > 0;
    }

    get selectedCount(): number {
        return this.selectedTodoIds.size;
    }

    isSelected(todoId: number): boolean {
        return this.selectedTodoIds.has(todoId);
    }

    onItemPointerDown(event: PointerEvent, todo: Todo, index: number): void {
        if (event.button !== 0) return;
        if (this.isDragging || this.shouldIgnoreSelection(event)) return;

        const isRangeSelection = event.shiftKey;
        const isToggleSelection = event.ctrlKey || event.metaKey;

        if (!isRangeSelection && !isToggleSelection) {
            this.selectionAnchorId = todo.id;
            return;
        }

        let nextSelection = new Set(this.selectedTodoIds);
        let selectionChanged = false;

        if (isRangeSelection) {
            if (this.selectionAnchorId !== null) {
                const anchorIndex = this.findIndexById(this.selectionAnchorId);
                if (anchorIndex !== -1) {
                    const startIndex = Math.min(anchorIndex, index);
                    const endIndex = Math.max(anchorIndex, index);
                    for (let i = startIndex; i <= endIndex; i += 1) {
                        nextSelection.add(this.todos[i].id);
                    }
                    selectionChanged = true;
                } else {
                    nextSelection = new Set<number>([todo.id]);
                    selectionChanged = true;
                }
            } else {
                nextSelection = new Set<number>([todo.id]);
                selectionChanged = true;
            }
        } else if (isToggleSelection) {
            if (nextSelection.has(todo.id)) {
                nextSelection.delete(todo.id);
            } else {
                nextSelection.add(todo.id);
            }
            selectionChanged = true;
        }

        if (!selectionChanged) {
            return;
        }

        this.selectedTodoIds = nextSelection;

        if (this.selectedTodoIds.size === 0) {
            this.selectionAnchorId = null;
        } else if (this.selectedTodoIds.has(todo.id)) {
            this.selectionAnchorId = todo.id;
        } else if (!this.selectionAnchorId || !this.selectedTodoIds.has(this.selectionAnchorId)) {
            const fallback = this.todos.find((item) => this.selectedTodoIds.has(item.id));
            this.selectionAnchorId = fallback ? fallback.id : todo.id;
        }

        if (isRangeSelection || isToggleSelection || this.selectedTodoIds.size > 1) {
            event.preventDefault();
            event.stopPropagation();
        }

        this.cdRef.markForCheck();
		this.publishSelectionState();
    }

    selectAll(): void {
        if (!this.todos.length) {
            this.clearSelection();
            return;
        }

        if (this.selectedTodoIds.size === this.todos.length) {
            return;
        }

        this.selectedTodoIds = new Set(this.todos.map((todo) => todo.id));
        const lastTodo = this.todos[this.todos.length - 1] ?? null;
        this.selectionAnchorId = lastTodo ? lastTodo.id : null;
        this.cdRef.markForCheck();
		this.publishSelectionState();
    }

    async deleteSelected(): Promise<void> {
        if (!this.selectedTodoIds.size) return;

        const snapshot = this.todos
            .map((todo, position) => ({ todo: { ...todo }, position }))
            .filter(({ todo }) => this.selectedTodoIds.has(todo.id));

        if (!snapshot.length) {
            this.clearSelection();
            return;
        }

        let currentFilePath: string | null = null;
        if (this.scope === TodoScope.currentFile) {
            currentFilePath = await firstValueFrom(this.todoService.currentFilePath);
        }

        snapshot.forEach(({ todo }) => {
            this.todoService.deleteTodo(this.scope, { id: todo.id });
        });

        const message =
            snapshot.length === 1 ? "Item deleted" : `${snapshot.length} items deleted`;

		const snackBarRef = this.snackBar.open(message, "UNDO", {
			duration: 7000
		});
		this.decorateSnackBarOverlay(snackBarRef);
		snackBarRef.onAction().subscribe(() => {
            const queue = [...snapshot].sort((a, b) => a.position - b.position);
            const restoreNext = () => {
                const entry = queue.shift();
                if (!entry) {
                    return;
                }

                const payload = {
                    id: entry.todo.id,
                    text: entry.todo.text,
                    completed: entry.todo.completed,
                    creationDate: entry.todo.creationDate,
                    isMarkdown: entry.todo.isMarkdown,
                    isNote: entry.todo.isNote,
                    collapsed: entry.todo.collapsed,
                    itemPosition: entry.position,
                };

                if (this.scope === TodoScope.currentFile) {
                    this.todoService.undoDelete(this.scope, { ...payload, currentFilePath });
                } else {
                    this.todoService.undoDelete(this.scope, payload);
                }

                if (queue.length) {
                    requestAnimationFrame(restoreNext);
                }
            };

            restoreNext();
        });

        this.clearSelection();
    }

    async deleteCompleted(): Promise<void> {
        const snapshot = this.todos
            .map((todo, position) => ({ todo: { ...todo }, position }))
            .filter(({ todo }) => todo.completed && !todo.isNote);

        if (!snapshot.length) {
            return;
        }

        let currentFilePath: string | null = null;
        if (this.scope === TodoScope.currentFile) {
            currentFilePath = await firstValueFrom(this.todoService.currentFilePath);
        }

        snapshot.forEach(({ todo }) => {
            this.todoService.deleteTodo(this.scope, { id: todo.id });
        });

        const message =
            snapshot.length === 1 ? "Item deleted" : `${snapshot.length} items deleted`;

        const snackBarRef = this.snackBar.open(message, "UNDO", {
            duration: 7000
        });
        this.decorateSnackBarOverlay(snackBarRef);
        snackBarRef.onAction().subscribe(() => {
            const queue = [...snapshot].sort((a, b) => a.position - b.position);
            const restoreNext = () => {
                const entry = queue.shift();
                if (!entry) {
                    return;
                }

                const payload = {
                    id: entry.todo.id,
                    text: entry.todo.text,
                    completed: entry.todo.completed,
                    creationDate: entry.todo.creationDate,
                    isMarkdown: entry.todo.isMarkdown,
                    isNote: entry.todo.isNote,
                    collapsed: entry.todo.collapsed,
                    itemPosition: entry.position,
                };

                if (this.scope === TodoScope.currentFile) {
                    this.todoService.undoDelete(this.scope, { ...payload, currentFilePath });
                } else {
                    this.todoService.undoDelete(this.scope, payload);
                }

                if (queue.length) {
                    requestAnimationFrame(restoreNext);
                }
            };

            restoreNext();
        });
    }

    clearSelection(): void {
        if (!this.selectedTodoIds.size) return;
        this.selectedTodoIds = new Set<number>();
        this.selectionAnchorId = null;
        this.cdRef.markForCheck();
		this.publishSelectionState();
    }
    private publishSelectionState(): void {
        this.todoService.setSelectionState(this.scope, {
            hasSelection: this.hasSelection,
            selectedCount: this.selectedTodoIds.size,
            totalCount: this.todos.length,
        });
    }


    @HostListener("document:pointerdown", ["$event"])
    handleDocumentPointerDown(event: PointerEvent): void {
        if (event.defaultPrevented) {
            return;
        }

        const root = this.hostElement.nativeElement;
        if (!root.contains(event.target as Node)) {
            return;
        }

        const target = event.target as HTMLElement | null;
        if (!target) return;

        const itemEl = target.closest('[data-id]') as HTMLElement | null;
        if (!itemEl) return;

        const idAttr = itemEl.getAttribute('data-id');
        if (!idAttr) return;

        const todoId = Number(idAttr);
        if (!Number.isFinite(todoId)) return;

        const index = this.todos.findIndex((todo) => todo.id === todoId);
        if (index === -1) return;

        const todo = this.todos[index];
        this.onItemPointerDown(event, todo, index);
    }

    @HostListener("document:keydown", ["$event"])
    handleKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape" && this.hasSelection) {
            this.clearSelection();
            event.stopPropagation();
        }
    }

    private syncSelectionWithTodos(): void {
        if (!this.selectedTodoIds.size) {
            this.publishSelectionState();
            return;
        }

        const nextSelection = new Set<number>();
        for (const todo of this.todos) {
            if (this.selectedTodoIds.has(todo.id)) {
                nextSelection.add(todo.id);
            }
        }

        this.selectedTodoIds = nextSelection;
        if (this.selectionAnchorId !== null && !this.selectedTodoIds.has(this.selectionAnchorId)) {
            const firstSelected = this.todos.find((item) => this.selectedTodoIds.has(item.id));
            this.selectionAnchorId = firstSelected ? firstSelected.id : null;
        }

        if (!this.selectedTodoIds.size) {
            this.selectionAnchorId = null;
        }

        this.publishSelectionState();
    }

    private shouldIgnoreSelection(event: PointerEvent): boolean {
        const target = event.target as HTMLElement | null;
        if (!target) return false;

        if (target.closest("vscode-button, button, a, input, textarea, autosize-text-area, app-icon, .selection-toolbar")) {
            return true;
        }

        if (target.closest("mat-menu, [role='menuitem'], mat-menu-item, vscode-checkbox")) {
            return true;
        }

        return false;
    }

    private findIndexById(id: number): number {
        return this.todos.findIndex((todo) => todo.id === id);
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
		if (this.selectedTodoIds.has(todo.id)) {
			const nextSelection = new Set(this.selectedTodoIds);
			nextSelection.delete(todo.id);
			this.selectedTodoIds = nextSelection;
			if (!nextSelection.size) {
				this.selectionAnchorId = null;
			}
			this.cdRef.markForCheck();
			this.publishSelectionState();
		}
		this.todoService.deleteTodo(this.scope, { id: todo.id });
		// Snackbar with 'UNDO' button
		const snackBarRef = this.snackBar.open("Item deleted", "UNDO", {
			duration: 6000,
		});
		this.decorateSnackBarOverlay(snackBarRef);
		snackBarRef.onAction().subscribe(() => {
			this.todoService.undoDelete(this.scope, {
				...deletedItem,
				itemPosition,
				currentFilePath,
			});
		});
	}

	async handlePlanDelete(slug: string): Promise<void> {
		if (!slug) {
			return;
		}
		const snapshot = this.allTodos
			.map((todo, position) => ({ todo: { ...todo }, position }))
			.filter(({ todo }) => this.todoBelongsToPlan(todo, slug));

		if (!snapshot.length) {
			return;
		}

		let currentFilePath: string | null = null;
		if (this.scope === TodoScope.currentFile) {
			currentFilePath = await firstValueFrom(this.todoService.currentFilePath);
		}

		snapshot.forEach(({ todo }) => {
			this.todoService.deleteTodo(this.scope, { id: todo.id });
		});

		const snackBarRef = this.snackBar.open("Plan deleted", "UNDO", {
			duration: 7000,
		});
		this.decorateSnackBarOverlay(snackBarRef);
		snackBarRef.onAction().subscribe(() => {
			const queue = [...snapshot].sort((a, b) => a.position - b.position);
			const restoreNext = () => {
				const entry = queue.shift();
				if (!entry) {
					return;
				}

				const payload = {
					id: entry.todo.id,
					text: entry.todo.text,
					completed: entry.todo.completed,
					creationDate: entry.todo.creationDate,
					isMarkdown: entry.todo.isMarkdown,
					isNote: entry.todo.isNote,
					collapsed: entry.todo.collapsed,
					itemPosition: entry.position,
				};

				if (this.scope === TodoScope.currentFile) {
					this.todoService.undoDelete(this.scope, { ...payload, currentFilePath });
				} else {
					this.todoService.undoDelete(this.scope, payload);
				}

				if (queue.length) {
					requestAnimationFrame(restoreNext);
				}
			};

			restoreNext();
		});
	}

	private todoBelongsToPlan(todo: Todo, slug: string): boolean {
		const planItem = parsePlanItem(todo.text);
		if (planItem && planItem.slug === slug) {
			return true;
		}
		if (todo.isNote) {
			const header = parsePlanHeader(todo.text);
			if (header && header.slug === slug) {
				return true;
			}
		}
		return false;
	}

	private decorateSnackBarOverlay(snackBarRef: MatSnackBarRef<unknown>): void {
		const overlayRef = (snackBarRef as unknown as { _overlayRef?: { overlayElement?: HTMLElement } })._overlayRef;
		const overlayElement = overlayRef?.overlayElement;
		if (overlayElement) {
			overlayElement.classList.add("todo-snack-bar-overlay");
		}
	}

	ngOnDestroy(): void {
		if (this.lastActionTypeSubscription) {
			this.lastActionTypeSubscription.unsubscribe();
		}
		if (this.selectionCommandSubscription) {
			this.selectionCommandSubscription.unsubscribe();
		}
		this.todoService.setSelectionState(this.scope, {
			hasSelection: false,
			selectedCount: 0,
			totalCount: 0,
		});
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
