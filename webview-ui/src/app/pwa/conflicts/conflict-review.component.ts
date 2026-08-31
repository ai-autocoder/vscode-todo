import { Component, EventEmitter, Input, Output } from "@angular/core";
import type { Todo } from "@vsc-todo/core";
import { GistGateway } from "../../data/gist-gateway";
import {
	canMergeFields,
	describeConflict,
	fieldDiffs,
	formatField,
	mergeTodoFields,
	type FieldDiff,
} from "./conflict-diff";
import {
	type ConflictSide,
	type KeptBothConflict,
	type MergeableField,
	type PendingConflict,
	type PendingConflictView,
	type PendingFileConflict,
	type PendingTodoConflict,
} from "./conflict-types";

/**
 * Full-screen review of conflicts the sync already resolved on its own.
 *
 * Every card describes a decision that has *already been applied and pushed*, so the wording is
 * past tense throughout and "keep this device" is simply dismissal. Choosing the other device
 * writes an ordinary local edit and schedules a push, which is why nothing here waits on the
 * network or can leave the sync half-finished.
 *
 * PWA-only — the extension resolves conflicts up front through its own QuickPick.
 */
@Component({
	selector: "app-conflict-review",
	templateUrl: "./conflict-review.component.html",
	styleUrls: ["./conflict-review.component.css"],
	standalone: false,
})
export class ConflictReviewComponent {
	@Input({ required: true }) gateway!: GistGateway;
	@Input() views: PendingConflictView[] = [];
	@Output() closed = new EventEmitter<void>();

	/** Key of the card whose per-field merge is open, if any. */
	expandedMergeKey: string | null = null;
	/** Key of the file card whose item preview is open, if any. */
	expandedPreviewKey: string | null = null;
	/** Key of the card asking permission to overwrite a since-edited item. */
	staleConfirmKey: string | null = null;
	/** Outcome of the last bulk action, shown until another one runs. */
	bulkMessage = "";

	/** Per-card field assignments, defaulting to this device for anything untouched. */
	private readonly picks = new Map<string, Partial<Record<MergeableField, ConflictSide>>>();
	/** The choice a stale warning is holding, replayed if the user confirms. */
	private forceTarget: { key: string; merged?: Todo } | null = null;

	// --- narrowing helpers ---
	//
	// The template asks for each variant by name rather than testing `kind` inline: `@if (x; as
	// y)` gives the block a properly typed handle either way, which keeps the markup working
	// regardless of how much discriminated-union narrowing the template checker does.

	todoConflict(view: PendingConflictView): PendingTodoConflict | null {
		return view.conflict.kind === "todo" ? view.conflict : null;
	}

	fileConflict(view: PendingConflictView): PendingFileConflict | null {
		return view.conflict.kind === "file" ? view.conflict : null;
	}

	keptBoth(view: PendingConflictView): KeptBothConflict | null {
		return view.conflict.kind === "kept-both" ? view.conflict : null;
	}

	// --- presentation ---

	headline(view: PendingConflictView): string {
		return describeConflict(view.conflict);
	}

	/** Which list the item belongs to. Matches the tab labels in the app. */
	scopeLabel(conflict: PendingConflict): string {
		if (conflict.kind === "file") {
			return conflict.filePath;
		}
		return conflict.scope === "user" ? "User" : "Workspace";
	}

	/** One-line summary of a todo for the side-by-side panes. */
	summary(todo: Todo): string {
		return [
			formatField("completed", todo),
			formatField("isNote", todo),
			formatField("tags", todo),
		].join(" · ");
	}

	canMerge(view: PendingConflictView): boolean {
		return canMergeFields(view.conflict);
	}

	/** The fields the two versions disagree on. Empty unless both versions exist. */
	diffs(view: PendingConflictView): FieldDiff[] {
		const conflict = view.conflict;
		if (conflict.kind !== "todo" || !conflict.local || !conflict.remote) {
			return [];
		}
		return fieldDiffs(conflict.local, conflict.remote);
	}

	pickOf(key: string, field: MergeableField): ConflictSide {
		return this.picks.get(key)?.[field] ?? "local";
	}

	pick(key: string, field: MergeableField, side: ConflictSide): void {
		this.picks.set(key, { ...(this.picks.get(key) ?? {}), [field]: side });
	}

	toggleMerge(key: string): void {
		this.expandedMergeKey = this.expandedMergeKey === key ? null : key;
	}

	togglePreview(key: string): void {
		this.expandedPreviewKey = this.expandedPreviewKey === key ? null : key;
	}

	// --- actions ---

	/** "Keep this device" — the sync already did, so only the record goes away. */
	keepThisDevice(view: PendingConflictView): void {
		this.gateway.dismissConflict(view.conflict.key);
		this.forget(view.conflict.key);
	}

	keepOtherDevice(view: PendingConflictView): void {
		void this.apply(view.conflict.key);
	}

	/** Applies the per-field assignment built in the expander. */
	applyMerge(view: PendingConflictView): void {
		const conflict = view.conflict;
		if (conflict.kind !== "todo" || !conflict.local || !conflict.remote) {
			return;
		}
		const picks = this.picks.get(conflict.key) ?? {};
		void this.apply(conflict.key, mergeTodoFields(conflict.local, conflict.remote, picks));
	}

	/** Undoes an automatic keep-both by removing the copy it added. */
	removeAddedCopy(view: PendingConflictView): void {
		const key = view.conflict.key;
		void this.gateway.undoKeptBoth(key).then(() => this.forget(key));
	}

	/** Second tap on a card that warned about overwriting a since-edited item. */
	confirmOverwrite(): void {
		const target = this.forceTarget;
		if (!target) {
			return;
		}
		void this.gateway
			.applyConflictChoice(target.key, target.merged, true)
			.then(() => this.forget(target.key));
	}

	cancelOverwrite(): void {
		this.staleConfirmKey = null;
		this.forceTarget = null;
	}

	async keepAllFromOtherDevice(): Promise<void> {
		const { applied, skipped } = await this.gateway.keepAllFromOtherDevice();
		this.bulkMessage = skipped
			? `Switched ${applied}. ${skipped} changed on this device since the sync — review those below.`
			: `Switched ${applied} to the other device's version.`;
	}

	dismissAll(): void {
		this.gateway.dismissAllConflicts();
		this.bulkMessage = "";
		this.closed.emit();
	}

	close(): void {
		this.closed.emit();
	}

	/**
	 * Sends a choice to the gateway, holding it for confirmation when the item has been edited
	 * since the sync resolved it. Overwriting a later edit is the silent loss this whole screen
	 * exists to stop, so it takes a second, explicit tap.
	 */
	private async apply(key: string, merged?: Todo): Promise<void> {
		const result = await this.gateway.applyConflictChoice(key, merged);
		if (result === "stale") {
			this.staleConfirmKey = key;
			this.forceTarget = { key, merged };
			return;
		}
		this.forget(key);
	}

	/** Drops the per-card state of a card that has just gone away. */
	private forget(key: string): void {
		this.picks.delete(key);
		if (this.expandedMergeKey === key) {
			this.expandedMergeKey = null;
		}
		if (this.expandedPreviewKey === key) {
			this.expandedPreviewKey = null;
		}
		if (this.staleConfirmKey === key) {
			this.staleConfirmKey = null;
			this.forceTarget = null;
		}
	}
}
