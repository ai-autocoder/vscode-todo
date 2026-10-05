import {
	ChangeDetectorRef,
	Component,
	Input,
	OnChanges,
	OnDestroy,
	OnInit,
	SimpleChanges,
} from "@angular/core";
import { Subscription } from "rxjs";
import { TodoScope } from "../../../../../src/todo/todoTypes";
import { environment } from "../../../environments/environment";
import { ComposerAdd, SelectionCommand, SelectionState, TodoService } from "../todo.service";

/** How the "not saved" notice names the list an add was sent to. */
function listName(add: ComposerAdd): string {
	switch (add.scope) {
		case TodoScope.user:
			return "the User list";
		case TodoScope.workspace:
			return "the Workspace list";
		case TodoScope.currentFile:
			return `the list for ${add.filePath?.split(/[\\/]/).pop() || "a file"}`;
	}
}

@Component({
    selector: "new-todo",
    templateUrl: "./new-todo.component.html",
    styleUrls: ["./new-todo.component.css"],
    standalone: false
})
export class NewTodoComponent implements OnInit, OnChanges, OnDestroy {
	newTodoText: string = "";
	@Input() scope!: TodoScope;
	@Input() currentFilePath!: string;
	isCurrentFileEmpty = false;
	selectionState: SelectionState = { hasSelection: false, selectedCount: 0, totalCount: 0 };
	private selectionStateSubscription?: Subscription;
	private readonly deliverySubscriptions = new Subscription();
	/**
	 * Adds the service handed back because the host never confirmed them, oldest first. Each stays
	 * until it is sent again, edited or deleted in the box, or turns out to have been stored.
	 */
	private handedBack: ComposerAdd[] = [];
	/** The handed-back add the box shows. While set, the box holds exactly its text. */
	private shownAdd: ComposerAdd | null = null;
	private refillTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private todoService: TodoService,
		private cdRef: ChangeDetectorRef
	) {}

	ngOnInit(): void {
		this.deliverySubscriptions.add(
			this.todoService.undeliveredAdds.subscribe((add) => this.restoreUndelivered(add))
		);
		this.deliverySubscriptions.add(
			this.todoService.lateDeliveredAdds.subscribe((add) => this.withdrawDelivered(add))
		);
	}

	ngOnChanges(changes: SimpleChanges): void {
		if (changes["currentFilePath"] || changes["scope"]) {
			this.isCurrentFileEmpty =
				this.currentFilePath === "" && this.scope === TodoScope.currentFile;
			this.retargetHandedBack();
		}

		if (changes["scope"] || !this.selectionStateSubscription) {
			this.subscribeToSelectionState();
		}
	}

	ngOnDestroy(): void {
		this.selectionStateSubscription?.unsubscribe();
		this.deliverySubscriptions.unsubscribe();
		clearTimeout(this.refillTimer);
	}

	/** The notice under the composer while an add is waiting to be sent again, or null. */
	get undeliveredNotice(): string | null {
		if (this.shownAdd) {
			return environment.pwa
				? "Not saved. Try again, or reload the page if this keeps happening."
				: "Not saved: the extension didn't respond. Try again, or run Developer: Reload Window if this keeps happening.";
		}
		if (this.handedBack.some((add) => this.isForThisList(add))) {
			return "A todo wasn't saved. It comes back here once this box is empty.";
		}
		const elsewhere = this.handedBack[0];
		return elsewhere
			? `A todo for ${listName(elsewhere)} wasn't saved. Switch to it to get the text back.`
			: null;
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

	/**
	 * The keyboard hint is both meaningless and harmful on touch: there is no Shift+Enter on a
	 * phone, and at 41 characters it wraps the composer to a second line on a narrow screen
	 * (measured 72px of text in a ~50px box at 375px wide). Coarse pointers get a short label
	 * instead; `aria-label` on the textarea carries the accessible name either way.
	 *
	 * Read once at construction rather than via a listener — switching pointer type mid-session
	 * does not happen on a real device, and the composer is rebuilt on scope changes anyway.
	 */
	private readonly isCoarsePointer =
		typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

	get placeholderText(): string {
		if (this.isWorkspaceAddBlocked) {
			return this.workspaceAddBlockedMessage;
		}
		return this.isCoarsePointer ? "New todo" : "New todo: Enter | Line break: Shift+Enter";
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
		if (this.shownAdd) {
			// Sent again, so the service is waiting on the new send rather than this one.
			this.forgetHandedBack(this.shownAdd);
		}
		this.showNextHandedBack();
	}

	/**
	 * Takes an add the host never confirmed, so its text can be sent again rather than lost.
	 *
	 * This and {@link withdrawDelivered} run from a timer or a host message rather than from an
	 * event on this view, so they mark it for checking themselves.
	 */
	private restoreUndelivered(add: ComposerAdd): void {
		this.handedBack.push(add);
		this.showNextHandedBack();
		this.cdRef.markForCheck();
	}

	/**
	 * The host stored a handed-back add after all, so its text is taken out of the box again,
	 * where sending it would make a duplicate. Once edited, the text is the user's and stays.
	 */
	private withdrawDelivered(add: ComposerAdd): void {
		const wasShown = this.shownAdd === add;
		if (!this.forgetHandedBack(add)) {
			return;
		}
		if (wasShown) {
			this.newTodoText = "";
			this.showNextHandedBack();
		}
		this.cdRef.markForCheck();
	}

	/**
	 * Puts the oldest handed-back add for the list this composer adds to in the box, if the box is
	 * empty. Never into a draft: the box is sent as one item, so the text would be saved inside
	 * the draft, and replacing the draft would lose it. An add for another list waits until that
	 * list is shown, so Enter does not file it in this one.
	 */
	private showNextHandedBack(): void {
		if (this.shownAdd || this.newTodoText.trim().length) {
			return;
		}
		const next = this.handedBack.find((add) => this.isForThisList(add));
		if (next) {
			this.shownAdd = next;
			this.newTodoText = next.text;
		}
	}

	/** After a switch of list: an untouched handed-back text for another list goes back to waiting. */
	private retargetHandedBack(): void {
		if (this.shownAdd && !this.isForThisList(this.shownAdd)) {
			this.shownAdd = null;
			this.newTodoText = "";
		}
		this.showNextHandedBack();
	}

	/** Whether a handed-back add was sent to the list this composer adds to now. */
	private isForThisList(add: ComposerAdd): boolean {
		return (
			add.scope === this.scope &&
			(add.scope !== TodoScope.currentFile || add.filePath === this.currentFilePath)
		);
	}

	private forgetHandedBack(add: ComposerAdd): boolean {
		const index = this.handedBack.indexOf(add);
		if (index === -1) {
			return false;
		}
		this.handedBack.splice(index, 1);
		if (this.shownAdd === add) {
			this.shownAdd = null;
		}
		return true;
	}

	onTextInserted(value: string): void {
		this.newTodoText = value;
		if (this.shownAdd && value !== this.shownAdd.text) {
			// Edited or deleted, so the text is the user's now.
			this.forgetHandedBack(this.shownAdd);
		}
		if (!value.trim().length) {
			this.scheduleNextHandedBack();
		}
	}

	/**
	 * Shows the next handed-back add once a box emptied in the textarea has been rendered. Not at
	 * once: the text was deleted in the textarea itself, and this view's binding still holds what
	 * it showed before. Putting the same text back, a second send of it or a draft that read the
	 * same, would then change nothing the binding can see, and the textarea would stay empty
	 * while the box held text.
	 */
	private scheduleNextHandedBack(): void {
		if (this.refillTimer !== undefined || !this.handedBack.some((add) => this.isForThisList(add))) {
			return;
		}
		this.refillTimer = setTimeout(() => {
			this.refillTimer = undefined;
			this.showNextHandedBack();
			this.cdRef.markForCheck();
		});
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
