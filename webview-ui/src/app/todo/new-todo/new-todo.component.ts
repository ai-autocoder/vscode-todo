import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from "@angular/core";
import { Subscription } from "rxjs";
import { TodoScope } from "../../../../../src/todo/todoTypes";
import { SelectionCommand, SelectionState, TodoService } from "../todo.service";

@Component({
    selector: "new-todo",
    templateUrl: "./new-todo.component.html",
    styleUrls: ["./new-todo.component.css"],
    standalone: false
})
export class NewTodoComponent implements OnChanges, OnDestroy {
	newTodoText: string = "";
	@Input() scope!: TodoScope;
	@Input() currentFilePath!: string;
	isCurrentFileEmpty = false;
	selectionState: SelectionState = { hasSelection: false, selectedCount: 0, totalCount: 0 };
	private selectionStateSubscription?: Subscription;

	constructor(private todoService: TodoService) {}

	ngOnChanges(changes: SimpleChanges): void {
		if (changes["currentFilePath"] || changes["scope"]) {
			this.isCurrentFileEmpty =
				this.currentFilePath === "" && this.scope === TodoScope.currentFile;
		}

		if (changes["scope"] || !this.selectionStateSubscription) {
			this.subscribeToSelectionState();
		}
	}

	ngOnDestroy(): void {
		this.selectionStateSubscription?.unsubscribe();
	}

	get hasSelection(): boolean {
		return this.selectionState.hasSelection;
	}

	get selectedCount(): number {
		return this.selectionState.selectedCount;
	}

	get totalCount(): number {
		return this.selectionState.totalCount;
	}

	get workspaceAddBlockedMessage(): string {
		return this.scope === TodoScope.currentFile
			? "Open a workspace to add file todos."
			: "Open a workspace to add workspace todos.";
	}

	get isWorkspaceAddBlocked(): boolean {
		const isWorkspaceScope =
			this.scope === TodoScope.workspace || this.scope === TodoScope.currentFile;
		return isWorkspaceScope && !this.todoService.isWorkspaceOpen;
	}

	get addButtonDisabled(): boolean {
		return (
			!this.newTodoText.trim().length ||
			this.isCurrentFileEmpty ||
			this.isWorkspaceAddBlocked
		);
	}

	get addButtonTitle(): string {
		if (this.isWorkspaceAddBlocked) {
			return this.workspaceAddBlockedMessage;
		}
		if (this.isCurrentFileEmpty) {
			return "Please select a file first";
		}
		return "";
	}

	get placeholderText(): string {
		if (this.isWorkspaceAddBlocked) {
			return this.workspaceAddBlockedMessage;
		}
		return "New todo: Enter | Line break: Shift+Enter";
	}

	addTodo($event: Event): void {
		$event.preventDefault();
		if (
			!this.newTodoText.trim().length ||
			this.isCurrentFileEmpty ||
			this.isWorkspaceAddBlocked
		) {
			return;
		}
		this.todoService.addTodo(this.scope, { text: this.newTodoText.trim() });
		this.newTodoText = "";
	}

	onTextInserted(value: string): void {
		this.newTodoText = value;
	}

	onSelectAll(): void {
		this.emitSelectionCommand("selectAll");
	}

	onDeleteSelected(): void {
		this.emitSelectionCommand("deleteSelected");
	}

	onClearSelection(): void {
		this.emitSelectionCommand("clearSelection");
	}

	private subscribeToSelectionState(): void {
		this.selectionStateSubscription?.unsubscribe();

		if (this.scope === undefined || this.scope === null) {
			this.selectionState = { hasSelection: false, selectedCount: 0, totalCount: 0 };
			return;
		}

		this.selectionStateSubscription = this.todoService
			.getSelectionState(this.scope)
			.subscribe((state) => {
				this.selectionState = { ...state };
			});
	}

	private emitSelectionCommand(command: SelectionCommand): void {
		if (this.scope === undefined || this.scope === null) {
			return;
		}

		this.todoService.emitSelectionCommand(this.scope, command);
	}
}
