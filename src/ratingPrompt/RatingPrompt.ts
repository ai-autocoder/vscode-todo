import * as vscode from "vscode";
import type { Todo } from "../todo/todoTypes";
import LogChannel from "../utilities/LogChannel";
import {
	GITHUB_REPO_URL,
	collectItemDays,
	daysBetween,
	rateUrlFor,
	toDayKey,
} from "./activityDays";

/** Set once the prompt has been shown, on any machine: Settings Sync carries it. */
export const RATING_PROMPT_SHOWN_KEY = "ratingPrompt.shown";
const STATE_KEY = "ratingPrompt.state";

export const REQUIRED_ACTIVE_DAYS = 7;
export const REQUIRED_DAYS_SINCE_FIRST_USE = 14;

export const RATING_PROMPT_MESSAGE =
	"Enjoying VS Code Todo? A rating or a GitHub star helps other developers find it.";
const RATE = "Rate it";
const STAR = "Star on GitHub";
const NO_THANKS = "No thanks";

/**
 * Kept in `globalState`, so every project the extension opens adds to the same count. Once enough
 * days are found the list is no longer needed and collapses to `daysReached`.
 */
interface RatingPromptState {
	days?: string[];
	daysReached?: true;
	firstUse?: string;
}

export interface RatingPromptDeps {
	now(): Date;
	isWindowFocused(): boolean;
	uriScheme(): string;
	showMessage(message: string, ...items: string[]): Thenable<string | undefined>;
	openExternal(url: string): Thenable<boolean>;
	/** How long after the view opens, or the last activity, the prompt waits before showing. */
	delayMs: number;
}

const defaultDeps: RatingPromptDeps = {
	now: () => new Date(),
	isWindowFocused: () => vscode.window.state.focused,
	uriScheme: () => vscode.env.uriScheme,
	showMessage: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
	openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
	delayMs: 5000,
};

/**
 * Asks once for a rating or a GitHub star, and only someone who uses the extension: active on
 * {@link REQUIRED_ACTIVE_DAYS} distinct days, the first of them at least
 * {@link REQUIRED_DAYS_SINCE_FIRST_USE} days ago. Even then it waits for an add, edit or
 * completion in this session, so it follows something the user did rather than greeting them
 * when they open the view, and a release that makes many users eligible at once does not ask
 * them all on the day it arrives.
 */
export class RatingPrompt implements vscode.Disposable {
	private readonly deps: RatingPromptDeps;
	private recordedDay: string | undefined;
	private actedThisSession = false;
	private isViewVisible: (() => boolean) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly globalState: vscode.Memento,
		deps: Partial<RatingPromptDeps> = {}
	) {
		this.deps = { ...defaultDeps, ...deps };
	}

	/**
	 * Adds the days the lists already show, so someone who has used the extension for months is
	 * eligible from the first run, not two weeks after this code arrived.
	 */
	public async seed(lists: readonly (readonly Todo[] | undefined)[]): Promise<void> {
		if (this.wasShown() || this.isEligible()) {
			return;
		}
		const { days, earliest } = collectItemDays(lists);
		await this.addDays(days, earliest);
	}

	/**
	 * An add, edit or completion just happened. Writes at most once a day per window, and while
	 * the Todo view is open, restarts the wait, so the prompt comes once the activity settles.
	 */
	public recordActivity(): void {
		if (this.wasShown()) {
			return;
		}
		this.actedThisSession = true;
		const today = toDayKey(this.deps.now());
		if (this.recordedDay !== today) {
			this.recordedDay = today;
			void this.addDays([today], today);
		}
		if (this.isViewVisible && this.isEligible()) {
			this.scheduleCheck(this.isViewVisible);
		}
	}

	public isEligible(): boolean {
		const state = this.readState();
		return (
			state.daysReached === true &&
			state.firstUse !== undefined &&
			daysBetween(state.firstUse, toDayKey(this.deps.now())) >= REQUIRED_DAYS_SINCE_FIRST_USE
		);
	}

	/**
	 * The Todo view just became visible. Waits a few seconds so the prompt never joins the burst
	 * of startup notifications, and lets it go if the view was closed again in the meantime.
	 */
	public scheduleCheck(isVisible: () => boolean): void {
		if (this.wasShown()) {
			return;
		}
		this.isViewVisible = isVisible;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.maybeShow(isVisible);
		}, this.deps.delayMs);
	}

	/** Shows the prompt if every condition holds; resolves to whether it was shown. */
	public async maybeShow(isVisible: () => boolean): Promise<boolean> {
		if (
			!this.actedThisSession ||
			!isVisible() ||
			!this.deps.isWindowFocused() ||
			this.wasShown() ||
			!this.isEligible()
		) {
			return false;
		}

		// Before showing: a toast nobody answers never settles, and another window may be
		// about to make the same check.
		await this.globalState.update(RATING_PROMPT_SHOWN_KEY, true);
		LogChannel.log("Showing the rating prompt.");

		const choice = await this.deps.showMessage(RATING_PROMPT_MESSAGE, RATE, STAR, NO_THANKS);
		if (choice === RATE) {
			await this.deps.openExternal(rateUrlFor(this.deps.uriScheme()));
		} else if (choice === STAR) {
			await this.deps.openExternal(GITHUB_REPO_URL);
		}
		return true;
	}

	public dispose(): void {
		clearTimeout(this.timer);
	}

	private wasShown(): boolean {
		return this.globalState.get<boolean>(RATING_PROMPT_SHOWN_KEY, false);
	}

	private readState(): RatingPromptState {
		return this.globalState.get<RatingPromptState>(STATE_KEY) ?? {};
	}

	/**
	 * Reads, merges and writes with no await in between, so calls in this window never drop each
	 * other's days. Another window works on its own copy of `globalState` and can still overwrite
	 * a day written here, which only delays the prompt.
	 */
	private async addDays(days: Iterable<string>, earliest: string | undefined): Promise<void> {
		const state = this.readState();
		const firstUse =
			state.firstUse === undefined || (earliest !== undefined && earliest < state.firstUse)
				? earliest
				: state.firstUse;

		let next: RatingPromptState;
		if (state.daysReached) {
			next = { daysReached: true, firstUse };
		} else {
			const merged = new Set([...(state.days ?? []), ...days]);
			next =
				merged.size >= REQUIRED_ACTIVE_DAYS
					? { daysReached: true, firstUse }
					: { days: [...merged].sort(), firstUse };
		}

		if (JSON.stringify(next) !== JSON.stringify(state)) {
			await this.globalState.update(STATE_KEY, next);
		}
	}
}
