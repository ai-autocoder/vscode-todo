import { Component, EventEmitter, Input, Output } from "@angular/core";
import {
	generateUniqueId,
	resolveFileConflict,
	type ConflictDecisions,
	type ConflictSet,
	type FileConflictSet,
	type Todo,
} from "@vsc-todo/core";
import {
	describeFileConflictType,
	describeTodoConflictType,
	fieldDiffs,
	formatField,
	type FieldDiff,
} from "./conflict-diff";
import type { ConflictPromptRequest, ConflictSide } from "./conflict-types";

/** What the user chose for one conflicting todo. Absent means "not decided". */
export type PromptTodoChoice = ConflictSide | "keep-both";

/**
 * The up-front conflict dialog: the PWA's counterpart to the extension's QuickPick wizard.
 *
 * Shown *during* a reconcile, before anything is written. The engine's `ConflictResolver` is
 * waiting on the answer, so until this closes nothing is pushed and the baseline is untouched.
 * That is what makes Cancel safe: the same conflicts come back on the next sync rather than
 * being settled behind the user's back.
 *
 * Decisions are deliberately sparse. A conflict nobody touches is left OUT of the result, and
 * the engine settles it with its prefer-local policy and records it for the review screen. That
 * is why no "keep this device" default is baked into the map: an explicit choice means "done,
 * stop telling me", an absent one means "kept for now, listed under Review".
 *
 * PWA-only.
 */
@Component({
	selector: "app-conflict-prompt",
	templateUrl: "./conflict-prompt.component.html",
	styleUrls: ["./conflict-prompt.component.css"],
	standalone: false,
})
export class ConflictPromptComponent {
	@Input({ required: true }) request!: ConflictPromptRequest;
	/** `null` aborts the reconcile; a value applies it. Exactly one emission per prompt. */
	@Output() decided = new EventEmitter<ConflictDecisions | null>();

	/** Key of the card whose field-by-field breakdown is open, if any. */
	expandedKey: string | null = null;
	/** Set once Cancel is tapped, so backing out of a sync takes a second, deliberate tap. */
	confirmingCancel = false;
	/**
	 * How many cards the last bulk tap refused to answer, so the UI can say why some are still
	 * open. Counts only cards it actually left undecided. Zero once anything else happens.
	 */
	bulkSkipped = 0;

	private readonly todoChoices = new Map<number, PromptTodoChoice>();
	private readonly fileChoices = new Map<string, ConflictSide>();

	// --- presentation ---

	get todoConflicts(): ConflictSet[] {
		return this.request.todos;
	}

	get fileConflicts(): FileConflictSet[] {
		return this.request.files;
	}

	get total(): number {
		return this.request.todos.length + this.request.files.length;
	}

	/**
	 * Whether this prompt is the re-merge against an edit made while the sync was running.
	 *
	 * Only the wording changes. The sync has already written by then, so the way out of this
	 * dialog cannot stop anything — it leaves this device's version standing and files the
	 * conflicts for review — and saying otherwise promises a rollback that cannot happen.
	 */
	get isAfterWrite(): boolean {
		return this.request.phase === "after-write";
	}

	get undecidedCount(): number {
		return this.total - this.todoChoices.size - this.fileChoices.size;
	}

	headline(conflict: ConflictSet): string {
		return describeTodoConflictType(conflict.conflictType);
	}

	fileHeadline(conflict: FileConflictSet): string {
		return describeFileConflictType(conflict.conflictType);
	}

	/** One-line summary of a todo for the side-by-side panes. Mirrors the review screen. */
	summary(todo: Todo): string {
		return [
			formatField("completed", todo),
			formatField("isNote", todo),
			formatField("tags", todo),
		].join(" · ");
	}

	/** The fields the two versions disagree on. Empty unless both versions exist. */
	diffs(conflict: ConflictSet): FieldDiff[] {
		if (!conflict.local || !conflict.remote) {
			return [];
		}
		return fieldDiffs(conflict.local, conflict.remote);
	}

	/**
	 * Offered only for `id-collision`, and without a recommendation.
	 *
	 * The type means no more than "this merge had no common ancestor for this id". The two sides
	 * may be independent items that drew the same random id, where picking a side destroys a real
	 * one, or simply two versions of one item seen without a baseline, where keeping both leaves a
	 * duplicate. Nothing in the data tells them apart, so the choice is the user's.
	 */
	canKeepBoth(conflict: ConflictSet): boolean {
		return conflict.conflictType === "id-collision" && !!conflict.local && !!conflict.remote;
	}

	/** What each side of a per-file list resolves to, so the panes show the real outcome. */
	fileSide(conflict: FileConflictSet, side: ConflictSide): Todo[] | null {
		return resolveFileConflict(conflict, side);
	}

	/** Whether this device is the side that removed the list, which changes what "kept" means. */
	fileRemovedHere(conflict: FileConflictSet): boolean {
		return this.fileSide(conflict, "local") === null;
	}

	/**
	 * Whether any item *inside* this file has no shared history, which changes what a choice
	 * costs: those two todos may be independent items that drew the same id, so the side not
	 * chosen is destroyed rather than superseded.
	 *
	 * Common, not exotic. A `file-added-both` is one by construction, because its item merge
	 * runs against an empty base and an empty base can only produce collisions; a
	 * `file-edit-edit` can carry one mixed in with ordinary edits. And unlike a top-level
	 * conflict there is no keep-both available here: a file decision is a whole array, so the
	 * only way to preserve both sides is to leave the card undecided and let
	 * `captureFileConflicts` record the two resolutions for review.
	 */
	fileHasCollision(conflict: FileConflictSet): boolean {
		return (conflict.itemMerge?.conflicts ?? []).some((item) => item.conflictType === "id-collision");
	}

	/**
	 * Whether a bulk tap may answer this file conflict.
	 *
	 * False when either side removed the list altogether, because then one of the two bulk
	 * directions deletes it: the engine drops the path, and a decided conflict files no review
	 * record. The PWA never renders per-file lists, so the user would have no way to see what
	 * went or to put it back. Same rule as an id collision, for the same reason.
	 *
	 * Losing the whole list is not the only unrecoverable direction, so an item-level collision
	 * inside the file is refused too: see {@link fileHasCollision}.
	 *
	 * `null` is the only whole-list deletion signal: `resolveFileConflict` returns it exactly
	 * when the preferred side has no version of the file, and the engine's `resolveFiles`
	 * deletes the path only for a falsy value. An empty array is truthy, so a list that is
	 * merely empty stays answerable.
	 */
	private canBulkAnswerFile(conflict: FileConflictSet): boolean {
		return (
			this.fileSide(conflict, "local") !== null &&
			this.fileSide(conflict, "remote") !== null &&
			!this.fileHasCollision(conflict)
		);
	}

	/** Count for a file pane's summary line. `null` is the list being removed altogether. */
	fileCount(conflict: FileConflictSet, side: ConflictSide): string {
		const todos = this.fileSide(conflict, side);
		if (todos === null) {
			return "Removed";
		}
		return `${todos.length} ${todos.length === 1 ? "item" : "items"}`;
	}

	// --- choices ---

	todoChoice(id: number): PromptTodoChoice | undefined {
		return this.todoChoices.get(id);
	}

	fileChoice(path: string): ConflictSide | undefined {
		return this.fileChoices.get(path);
	}

	/** Tapping the active choice again clears it, which is how an item goes back to undecided. */
	chooseTodo(id: number, choice: PromptTodoChoice): void {
		this.bulkSkipped = 0;
		if (this.todoChoices.get(id) === choice) {
			this.todoChoices.delete(id);
			return;
		}
		this.todoChoices.set(id, choice);
	}

	chooseFile(path: string, choice: ConflictSide): void {
		this.bulkSkipped = 0;
		if (this.fileChoices.get(path) === choice) {
			this.fileChoices.delete(path);
			return;
		}
		this.fileChoices.set(path, choice);
	}

	/**
	 * Answers everything a side can safely be picked for, and leaves the rest open.
	 *
	 * Three kinds are left: a top-level id collision, where the two sides may never have been
	 * versions of each other so picking one destroys a real item; a per-file list one device
	 * removed, where one of the two directions deletes a list the PWA cannot even display; and a
	 * file whose own item merge holds a collision, which is the first case one level down and
	 * has no keep-both to fall back on. All three are answerable per card, with the card
	 * explaining the trade; a bulk tap is not that considered choice, so it does not make it. Left undecided, prefer-local applies and the card is filed
	 * for review: a collision is kept both ways, and a file keeps whatever this device has,
	 * including its removal. That duplicates or defers at worst, where answering in bulk would
	 * delete with no record to undo it from.
	 *
	 * Cards the user already answered are not counted as skipped: the note exists to explain
	 * cards that are still open, and one showing a choice is not one of them.
	 */
	chooseAll(side: ConflictSide): void {
		this.bulkSkipped = 0;
		for (const conflict of this.request.todos) {
			if (this.canKeepBoth(conflict)) {
				if (!this.todoChoices.has(conflict.todoId)) {
					this.bulkSkipped++;
				}
				continue;
			}
			this.todoChoices.set(conflict.todoId, side);
		}
		for (const conflict of this.request.files) {
			if (!this.canBulkAnswerFile(conflict)) {
				if (!this.fileChoices.has(conflict.filePath)) {
					this.bulkSkipped++;
				}
				continue;
			}
			this.fileChoices.set(conflict.filePath, side);
		}
	}

	toggleDetail(key: string): void {
		this.expandedKey = this.expandedKey === key ? null : key;
	}

	// --- outcome ---

	apply(): void {
		this.decided.emit(this.buildDecisions());
	}

	requestCancel(): void {
		this.confirmingCancel = true;
	}

	keepDeciding(): void {
		this.confirmingCancel = false;
	}

	confirmCancel(): void {
		this.decided.emit(null);
	}

	/**
	 * Turns the taps into a {@link ConflictDecisions}.
	 *
	 * Undecided conflicts are simply missing from both maps; see the class comment. A keep-both
	 * leaves the contested id with this device's item and re-adds the other device's under a
	 * fresh one, drawn against a pool that grows as it goes so two collisions cannot pick the
	 * same id.
	 */
	private buildDecisions(): ConflictDecisions {
		const todos = new Map<number, Todo | null>();
		const extraTodos = new Map<number, Todo[]>();
		const pool = this.request.knownIds.map((id) => ({ id }));

		for (const conflict of this.request.todos) {
			const choice = this.todoChoices.get(conflict.todoId);
			if (!choice) {
				continue;
			}
			if (choice === "keep-both" && conflict.local && conflict.remote) {
				todos.set(conflict.todoId, conflict.local);
				const newId = generateUniqueId(pool);
				pool.push({ id: newId });
				extraTodos.set(conflict.todoId, [{ ...conflict.remote, id: newId }]);
				continue;
			}
			todos.set(conflict.todoId, choice === "remote" ? conflict.remote : conflict.local);
		}

		const files = new Map<string, Todo[] | null>();
		for (const conflict of this.request.files) {
			const choice = this.fileChoices.get(conflict.filePath);
			if (!choice) {
				continue;
			}
			// Resolved rather than stored raw: within one file only the genuinely conflicting ids
			// are the choice's to decide, and taking the raw array would also discard every todo
			// the other device added to that file.
			files.set(conflict.filePath, resolveFileConflict(conflict, choice));
		}

		const decisions: ConflictDecisions = {};
		if (todos.size > 0) {
			decisions.todos = todos;
		}
		if (files.size > 0) {
			decisions.files = files;
		}
		if (extraTodos.size > 0) {
			decisions.extraTodos = extraTodos;
		}
		return decisions;
	}
}
