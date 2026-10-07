import * as assert from "assert";
import * as vscode from "vscode";
import createStore, { userActions } from "../../todo/store";
import { Todo } from "../../todo/todoTypes";
import {
	GITHUB_REPO_URL,
	MARKETPLACE_REVIEW_URL,
	OPEN_VSX_REVIEW_URL,
	rateUrlFor,
	toDayKey,
} from "../../ratingPrompt/activityDays";
import {
	RATING_PROMPT_MESSAGE,
	RATING_PROMPT_SHOWN_KEY,
	RatingPrompt,
	RatingPromptDeps,
} from "../../ratingPrompt/RatingPrompt";

const NOW = new Date(2026, 9, 20, 12);

/** Local noon `n` days before {@link NOW}, as an item date. */
const daysAgo = (n: number): string => new Date(2026, 9, 20 - n, 12).toISOString();
const dayKeyAgo = (n: number): string => toDayKey(new Date(2026, 9, 20 - n, 12));

const item = (id: number, creationDate: string, completionDate?: string): Todo => ({
	id,
	text: `item ${id}`,
	completed: completionDate !== undefined,
	creationDate,
	completionDate,
	isMarkdown: false,
	isNote: false,
});

const itemsOn = (...ago: number[]): Todo[] => ago.map((n, i) => item(i + 1, daysAgo(n)));

function fakeGlobalState(): { memento: vscode.Memento; map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	const memento = {
		get: (key: string, defaultValue?: unknown) => (map.has(key) ? map.get(key) : defaultValue),
		update: (key: string, value: unknown) => {
			map.set(key, value);
			return Promise.resolve();
		},
		keys: () => [...map.keys()],
	} as unknown as vscode.Memento;
	return { memento, map };
}

interface Harness {
	prompt: RatingPrompt;
	map: Map<string, unknown>;
	shownWith: { message: string; items: string[]; flagWasSet: unknown }[];
	opened: string[];
}

function harness(deps: Partial<RatingPromptDeps> = {}, memento = fakeGlobalState()): Harness {
	const shownWith: Harness["shownWith"] = [];
	const opened: string[] = [];
	const stubs: Partial<RatingPromptDeps> = {
		now: () => NOW,
		isWindowFocused: () => true,
		uriScheme: () => "vscode",
		showMessage: (message, ...items) => {
			shownWith.push({ message, items, flagWasSet: memento.map.get(RATING_PROMPT_SHOWN_KEY) });
			return Promise.resolve("No thanks");
		},
		openExternal: (url) => {
			opened.push(url);
			return Promise.resolve(true);
		},
		delayMs: 10,
		...deps,
	};
	const prompt = new RatingPrompt(memento.memento, stubs);
	return { prompt, map: memento.map, shownWith, opened };
}

const visible = () => true;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Eligible from the item dates, and something done in this session. */
async function ready(h: Harness): Promise<void> {
	await h.prompt.seed([itemsOn(30, 25, 20, 15, 10, 5, 1)]);
	h.prompt.recordActivity();
}

suite("Rating prompt", () => {
	test("is not eligible on six active days", async () => {
		const h = harness();
		await h.prompt.seed([itemsOn(30, 25, 20, 15, 10, 5)]);
		assert.strictEqual(h.prompt.isEligible(), false);
	});

	test("is not eligible on seven active days when the first was thirteen days ago", async () => {
		const h = harness();
		await h.prompt.seed([itemsOn(13, 12, 11, 10, 9, 8, 7)]);
		assert.strictEqual(h.prompt.isEligible(), false);
	});

	test("is eligible on seven active days when the first was fourteen days ago", async () => {
		const h = harness();
		await h.prompt.seed([itemsOn(14, 13, 12, 11, 10, 9, 8)]);
		assert.strictEqual(h.prompt.isEligible(), true);
	});

	test("seeds days from the user, workspace and file lists, completion dates included", async () => {
		const h = harness();
		await h.prompt.seed([
			[item(1, daysAgo(20), daysAgo(10))],
			itemsOn(18, 16),
			itemsOn(6),
			[item(1, daysAgo(4), daysAgo(2))],
		]);

		assert.strictEqual(h.prompt.isEligible(), true);
		assert.deepStrictEqual(
			h.map.get("ratingPrompt.state"),
			{ daysReached: true, firstUse: dayKeyAgo(20) },
			"Once enough days are found only the flag and the first day are kept"
		);
	});

	test("counts a day once however much happens on it", async () => {
		let now = NOW;
		const h = harness({ now: () => now });
		await h.prompt.seed([itemsOn(20, 15, 10, 5, 0, 0)]);
		h.prompt.recordActivity();
		h.prompt.recordActivity();
		await h.prompt.seed([itemsOn(0)]);

		const state = h.map.get("ratingPrompt.state") as { days: string[] };
		assert.strictEqual(state.days.length, 5);

		now = new Date(2026, 9, 21, 9);
		h.prompt.recordActivity();
		assert.strictEqual((h.map.get("ratingPrompt.state") as { days: string[] }).days.length, 6);
	});

	test("adds up days found in different projects", async () => {
		const shared = fakeGlobalState();
		await harness({}, shared).prompt.seed([itemsOn(30, 25, 20, 15)]);
		const second = harness({}, shared);
		assert.strictEqual(second.prompt.isEligible(), false);

		await second.prompt.seed([itemsOn(10, 5, 1)]);

		assert.strictEqual(second.prompt.isEligible(), true);
		assert.deepStrictEqual(shared.map.get("ratingPrompt.state"), {
			daysReached: true,
			firstUse: dayKeyAgo(30),
		});
	});

	test("live activity reports adds, edits and completions, never a sync load or a delete", () => {
		const reported: string[] = [];
		const store = createStore({ onUserActivity: (type) => reported.push(type) });

		store.dispatch(userActions.loadData({ data: [item(1, daysAgo(3))] }));
		store.dispatch(userActions.addTodo({ text: "new" }));
		store.dispatch(userActions.toggleTodo({ id: 1 }));
		store.dispatch(userActions.editTodo({ id: 1, newText: "edited" }));
		store.dispatch(userActions.deleteTodo({ id: 1 }));

		assert.deepStrictEqual(reported, ["user/addTodo", "user/toggleTodo", "user/editTodo"]);
	});

	test("records the first use on first activity when no item dates exist", () => {
		const h = harness();
		h.prompt.recordActivity();
		assert.deepStrictEqual(h.map.get("ratingPrompt.state"), {
			days: [dayKeyAgo(0)],
			firstUse: dayKeyAgo(0),
		});
	});

	test("shows once, setting the flag before the message appears", async () => {
		const h = harness();
		await ready(h);

		assert.strictEqual(await h.prompt.maybeShow(visible), true);
		assert.strictEqual(await h.prompt.maybeShow(visible), false);

		assert.strictEqual(h.shownWith.length, 1);
		assert.strictEqual(h.shownWith[0].flagWasSet, true);
		assert.strictEqual(h.shownWith[0].message, RATING_PROMPT_MESSAGE);
		assert.deepStrictEqual(h.shownWith[0].items, ["Rate it", "Star on GitHub", "No thanks"]);
		assert.deepStrictEqual(h.opened, [], "No thanks opens nothing");
	});

	test("does not show, or use up the prompt, while not eligible, hidden or unfocused", async () => {
		const notEligible = harness();
		await notEligible.prompt.seed([itemsOn(3, 2, 1)]);
		notEligible.prompt.recordActivity();
		assert.strictEqual(await notEligible.prompt.maybeShow(visible), false);

		const unfocused = harness({ isWindowFocused: () => false });
		await ready(unfocused);
		assert.strictEqual(await unfocused.prompt.maybeShow(visible), false);
		assert.strictEqual(await unfocused.prompt.maybeShow(() => false), false);

		for (const h of [notEligible, unfocused]) {
			assert.strictEqual(h.shownWith.length, 0);
			assert.strictEqual(h.map.get(RATING_PROMPT_SHOWN_KEY), undefined);
		}
	});

	test("waits for the view to stay visible before showing", async () => {
		const h = harness();
		await ready(h);

		let isVisible = true;
		h.prompt.scheduleCheck(() => isVisible);
		isVisible = false;
		await wait(40);
		assert.strictEqual(h.shownWith.length, 0, "Closed again before the delay ran out");

		isVisible = true;
		h.prompt.scheduleCheck(() => isVisible);
		await wait(40);
		assert.strictEqual(h.shownWith.length, 1);
	});

	test("waits for an add, edit or completion in this session, then asks once it settles", async () => {
		const h = harness();
		await h.prompt.seed([itemsOn(30, 25, 20, 15, 10, 5, 1)]);

		h.prompt.scheduleCheck(visible);
		await wait(40);
		assert.strictEqual(h.shownWith.length, 0, "Eligible from the item dates, but nothing done yet");

		h.prompt.recordActivity();
		await wait(40);
		assert.strictEqual(h.shownWith.length, 1, "Asks after the activity, with the view still open");
	});

	suite("routing", () => {
		test("VS Code and Insiders rate on the Marketplace", () => {
			assert.strictEqual(rateUrlFor("vscode"), MARKETPLACE_REVIEW_URL);
			assert.strictEqual(rateUrlFor("vscode-insiders"), MARKETPLACE_REVIEW_URL);
		});

		test("every other editor rates on Open VSX", () => {
			for (const scheme of ["cursor", "vscodium", "windsurf", "vscode-oss", ""]) {
				assert.strictEqual(rateUrlFor(scheme), OPEN_VSX_REVIEW_URL, scheme);
			}
		});

		test("Rate it opens the review page for the running editor; Star on GitHub the repo", async () => {
			const rate = harness({ uriScheme: () => "cursor", showMessage: async () => "Rate it" });
			await ready(rate);
			await rate.prompt.maybeShow(visible);
			assert.deepStrictEqual(rate.opened, [OPEN_VSX_REVIEW_URL]);

			const star = harness({ showMessage: async () => "Star on GitHub" });
			await ready(star);
			await star.prompt.maybeShow(visible);
			assert.deepStrictEqual(star.opened, [GITHUB_REPO_URL]);
		});
	});
});
