import type { Todo } from "../todo/todoTypes";

/**
 * The store actions that count as someone using the extension, from the webview or the MCP
 * server alike. Everything else stays out: `loadData` is how every sync merge, import, storage
 * reload and editor switch lands, and deletes can come from the auto-delete cleanup.
 */
const USER_ACTIVITY_ACTIONS: ReadonlySet<string> = new Set([
	"addTodo",
	"addTodos",
	"toggleTodo",
	"editTodo",
	"toggleMarkdown",
	"toggleTodoNote",
	"setTags",
]);

export function isUserActivityAction(type: string): boolean {
	return USER_ACTIVITY_ACTIONS.has(type.split("/").pop() ?? "");
}

/** A local calendar day, `YYYY-MM-DD`; sorts and compares as a string. */
export function toDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Whole calendar days from `from` to `to`, both day keys. */
export function daysBetween(from: string, to: string): number {
	const start = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
	const end = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
	return Math.round((end - start) / 86_400_000);
}

/**
 * The days the given lists show activity on, from each item's creation and completion dates, and
 * the earliest of them. A lower bound: deleted items and days with only edits leave no date.
 */
export function collectItemDays(lists: readonly (readonly Todo[] | undefined)[]): {
	days: Set<string>;
	earliest?: string;
} {
	const days = new Set<string>();
	for (const list of lists) {
		for (const todo of list ?? []) {
			for (const iso of [todo.creationDate, todo.completionDate]) {
				if (!iso) {
					continue;
				}
				const date = new Date(iso);
				if (!Number.isNaN(date.getTime())) {
					days.add(toDayKey(date));
				}
			}
		}
	}
	const earliest = [...days].sort()[0];
	return { days, earliest };
}

export const MARKETPLACE_REVIEW_URL =
	"https://marketplace.visualstudio.com/items?itemName=FrancescoAnzalone.vsc-todo&ssr=false#review-details";
export const OPEN_VSX_REVIEW_URL =
	"https://open-vsx.org/extension/FrancescoAnzalone/vsc-todo/reviews";
export const GITHUB_REPO_URL = "https://github.com/ai-autocoder/vscode-todo";

/**
 * Only VS Code itself installs from the Marketplace. Cursor, VSCodium, Windsurf and the other
 * forks install from Open VSX, so that is where their users can leave a review.
 */
export function rateUrlFor(uriScheme: string): string {
	return uriScheme === "vscode" || uriScheme === "vscode-insiders"
		? MARKETPLACE_REVIEW_URL
		: OPEN_VSX_REVIEW_URL;
}
