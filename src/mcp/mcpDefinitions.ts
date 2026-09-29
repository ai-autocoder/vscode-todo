import * as z from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * What the MCP server advertises: its instructions, the tool schemas and the resource list.
 *
 * Both threads load this module. The worker registers the tools and resources with the SDK, so
 * `initialize`, `tools/list` and argument validation never touch the extension host's thread;
 * the extension host re-parses the forwarded arguments against the same input shapes before it
 * runs a call. So this file must never import `vscode` — the worker cannot load it.
 */

export const SERVER_NAME = "vscode-todo-mcp";

export const SERVER_INSTRUCTIONS =
	"The todo_* tools are this project's task tracker for the user's plans, todos, and " +
	"notes. Reach for them when the task at hand actually involves tracked work — not on " +
	"every turn:\n" +
	"- When the user refers to tasks, todos, plans, or what's next (or you need to find " +
	"existing tracked work), read with todo_list_items / todo_count_items ('workspace' " +
	"scope) before searching the repo.\n" +
	"- When you produce a multi-step plan worth keeping, save it with todo_add_items " +
	"('workspace') and tag every step with one shared plan tag via todo_set_tags; re-read " +
	"it with the 'tag' filter.\n" +
	"- When you finish a tracked step, mark it with todo_set_completed (don't delete).\n" +
	"Skip these for quick questions or one-off edits that aren't about tracked work. Each " +
	"tool's own description covers scopes, notes, filtering, and read-only behavior. The " +
	"todo:// resources expose read-only snapshots of the same data.";

const scopeSchema = z
	.enum(["user", "workspace", "currentFile"])
	.describe(
		"Which todo list to target: 'user' (global, shared across all projects), " +
			"'workspace' (the current project/folder), or 'currentFile' (a specific file — " +
			"requires filePath)."
	);

const limitSchema = z
	.number()
	.int()
	.positive()
	.optional()
	.describe("Maximum number of items to return. Defaults to 50, capped at 500.");
const offsetSchema = z
	.number()
	.int()
	.nonnegative()
	.optional()
	.describe(
		"Number of items to skip from the start, for paging. Defaults to 0. Use the " +
			"next_offset from a previous response to fetch the next page."
	);
const maxCharsSchema = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		"Optional cap on the serialized size of a page, in characters. The page is " +
			"trimmed to whole items to stay under this budget, so it may return fewer than " +
			"the requested limit with has_more true. Defaults to a sane limit; item text is " +
			"never truncated."
	);

const todoShape = {
	id: z.number().describe("Stable numeric identifier of the item within its scope."),
	text: z.string().describe("The todo or note text."),
	completed: z.boolean().describe("Whether the item is marked done. Always false for notes."),
	creationDate: z.string().describe("ISO 8601 timestamp of when the item was created."),
	completionDate: z
		.string()
		.optional()
		.describe("ISO 8601 timestamp of when the item was completed, if completed."),
	isMarkdown: z.boolean().describe("Whether the text is rendered as Markdown in the UI."),
	isNote: z.boolean().describe("True for a free-text note, false for a checkable task."),
	collapsed: z.boolean().optional().describe("Whether the item is collapsed in the UI."),
	tags: z
		.array(z.string())
		.optional()
		.describe(
			"Tags applied to the item, used to group related items (e.g. all steps of a " +
				"plan). Absent on untagged items. Filter by one with the 'tag' parameter of " +
				"todo_list_items."
		),
};
const todoSchema = z.object(todoShape);

const listItemsOutputSchema = {
	scope: scopeSchema,
	filePath: z.string().optional().describe("Resolved file path when scope is 'currentFile'."),
	todos: z.array(todoSchema).describe("The page of todos/notes for this scope."),
	total: z.number().describe("Total number of items matching the query across all pages."),
	count: z.number().describe("Number of items returned in this page."),
	has_more: z.boolean().describe("True when more items remain beyond this page."),
	next_offset: z
		.number()
		.optional()
		.describe(
			"Offset to pass on the next call to fetch the following page, when has_more is true."
		),
};

const fileEntrySchema = z.object({
	filePath: z.string().describe("Path of a file that has todos."),
	todoNumber: z.number().describe("Number of todos recorded against that file."),
});
const listFilesOutputSchema = {
	files: z.array(fileEntrySchema).describe("The page of files that have todos."),
	total: z.number().describe("Total number of files with todos across all pages."),
	count: z.number().describe("Number of files returned in this page."),
	has_more: z.boolean().describe("True when more files remain beyond this page."),
	next_offset: z
		.number()
		.optional()
		.describe(
			"Offset to pass on the next call to fetch the following page, when has_more is true."
		),
};

const positionSchema = z
	.enum(["top", "bottom"])
	.optional()
	.describe(
		"Where to insert: 'top' (newest first) or 'bottom' (append). Omit to use the " +
			"user's createPosition setting."
	);

// The batch tool defaults to 'bottom' (append in order) regardless of the user's
// single-add createPosition preference — appending a block in the given order is the
// natural "lay down an ordered list" behavior. The block keeps its order either way.
const batchPositionSchema = z
	.enum(["top", "bottom"])
	.optional()
	.describe(
		"Where to insert the whole block: 'top' or 'bottom' (default). The block keeps " +
			"the given order either way."
	);

const addItemOutputSchema = {
	scope: scopeSchema,
	filePath: z
		.string()
		.optional()
		.describe("Resolved file path when the item was added to a 'currentFile' scope."),
	todo: todoSchema.describe("The newly created todo or note."),
};

const addItemsOutputSchema = {
	scope: scopeSchema,
	filePath: z
		.string()
		.optional()
		.describe("Resolved file path when the items were added to a 'currentFile' scope."),
	todos: z.array(todoSchema).describe("The newly created items, in the order they were given."),
	count: z.number().describe("Number of items created."),
};

// Per-scope count objects are "loose" (extra keys allowed) so future, more
// granular counts (e.g. a per-tag breakdown) can be added without a breaking
// schema change. z.looseObject is the Zod 4 idiom for the old .passthrough().
// completedCountSchema is populated only when the counts are tag-scoped (the
// "tag" parameter was supplied), giving a progress readout for a plan/group.
const completedCountSchema = z
	.number()
	.optional()
	.describe(
		"Number of completed (done) tasks among the counted items. Present only when " +
			"'tag' was supplied; with 'todos' (open tasks) it gives tag-scoped progress."
	);
const scopeCountsSchema = z.looseObject({
	todos: z.number().describe("Number of open (incomplete) checkable tasks in the scope."),
	notes: z.number().describe("Number of free-text notes in the scope."),
	completed: completedCountSchema,
});
const fileCountsSchema = z.looseObject({
	todos: z.number().describe("Number of open (incomplete) checkable tasks for the current file."),
	notes: z.number().describe("Number of free-text notes for the current file."),
	completed: completedCountSchema,
	filePath: z.string().describe("Path of the current file these counts apply to."),
});
const countItemsOutputSchema = {
	user: scopeCountsSchema.optional().describe("Counts for the user scope, if allowed."),
	workspace: scopeCountsSchema.optional().describe("Counts for the workspace scope, if allowed."),
	currentFile: fileCountsSchema.optional().describe("Counts for the current file scope, if allowed."),
};

const idSchema = z
	.number()
	.int()
	.describe("Numeric id of the target item (from a previous todo_list_items result).");
const mutateFilePathSchema = z
	.string()
	.optional()
	.describe(
		"Absolute or workspace-relative path; required when scope is 'currentFile', otherwise ignored."
	);
const readFilePathSchema = z
	.string()
	.optional()
	.describe(
		"Absolute or workspace-relative path; required when scope is 'currentFile', " +
			"otherwise ignored."
	);

// Shared by the single-item mutators (update text, set completed/note/markdown/tags).
const itemOutputSchema = {
	scope: scopeSchema,
	filePath: z.string().optional().describe("Resolved file path when scope is 'currentFile'."),
	todo: todoSchema.describe("The item after the change."),
};

const deleteOutputSchema = {
	scope: scopeSchema,
	filePath: z.string().optional().describe("Resolved file path when scope is 'currentFile'."),
	deleted: z.array(todoSchema).describe("The items that were deleted."),
	count: z.number().describe("Number of items deleted (0 if no id matched)."),
};

const mutateAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

/** Input shape per tool. The worker validates against it, and so does the extension host. */
export const TOOL_INPUTS = {
	todo_list_items: {
		scope: scopeSchema,
		filePath: readFilePathSchema,
		kind: z
			.enum(["task", "note", "all"])
			.optional()
			.describe(
				"Restrict to 'task' (checkable items), 'note' (free-text notes), or 'all'. " +
					"Defaults to 'all'."
			),
		completed: z
			.boolean()
			.optional()
			.describe(
				"Filter by completion: true for done items, false for open items. Omit to " +
					"return both. Notes are never completed."
			),
		textPrefix: z
			.string()
			.optional()
			.describe(
				"When set, return only items whose text begins with this prefix " +
					"(case-insensitive). Use 'search' to match anywhere in the text instead."
			),
		search: z
			.string()
			.optional()
			.describe(
				"When set, return only items whose text contains this substring " +
					"(case-insensitive). Unlike textPrefix, it matches anywhere in the item " +
					"text; whitespace is matched literally."
			),
		tag: z
			.string()
			.optional()
			.describe(
				"When set, return only items tagged with this tag (matched case-insensitively). " +
					"Use it to fetch every item in a plan or group that shares the tag."
			),
		sortBy: z
			.enum(["creationDate", "completionDate", "completed"])
			.optional()
			.describe(
				"Sort the results by this field before paging. Omit to keep insertion order. " +
					"'completionDate' groups still-open items (which have none) together — " +
					"first in 'asc' order, last in 'desc'."
			),
		order: z
			.enum(["asc", "desc"])
			.optional()
			.describe("Sort direction when sortBy is set. Defaults to 'asc'."),
		limit: limitSchema,
		offset: offsetSchema,
		maxChars: maxCharsSchema,
	},
	todo_count_items: {
		tag: z
			.string()
			.optional()
			.describe(
				"When set, count only items tagged with this tag (matched case-insensitively), " +
					"and include a 'completed' count per scope for tag-scoped progress."
			),
	},
	todo_add_item: {
		scope: scopeSchema,
		text: z.string().describe("The text of the todo or note to create."),
		isNote: z
			.boolean()
			.optional()
			.describe("When true, create a free-text note instead of a checkable task. Defaults to false."),
		isMarkdown: z
			.boolean()
			.optional()
			.describe(
				"When true, the text is rendered as Markdown in the UI. Defaults to the " +
					"extension's createMarkdownByDefault setting."
			),
		filePath: readFilePathSchema,
		position: positionSchema,
	},
	todo_add_items: {
		scope: scopeSchema,
		items: z
			.array(
				z.object({
					text: z.string().describe("The text of the todo or note to create."),
					isNote: z
						.boolean()
						.optional()
						.describe(
							"When true, create a free-text note instead of a checkable task. Defaults to false."
						),
					isMarkdown: z
						.boolean()
						.optional()
						.describe(
							"When true, the text is rendered as Markdown in the UI. Defaults to the " +
								"extension's createMarkdownByDefault setting."
						),
				})
			)
			.min(1)
			.describe(
				"Ordered list of items to create. The resulting list preserves this order. " +
					"Must contain at least one item."
			),
		position: batchPositionSchema,
		filePath: mutateFilePathSchema,
	},
	todo_list_files: {
		limit: limitSchema,
		offset: offsetSchema,
	},
	todo_update_text: {
		scope: scopeSchema,
		id: idSchema,
		newText: z.string().describe("The new text for the item."),
		filePath: mutateFilePathSchema,
	},
	todo_set_completed: {
		scope: scopeSchema,
		id: idSchema,
		completed: z.boolean().describe("Target completion state: true to complete, false to reopen."),
		filePath: mutateFilePathSchema,
	},
	todo_set_note: {
		scope: scopeSchema,
		id: idSchema,
		isNote: z.boolean().describe("True to make the item a note, false to make it a task."),
		filePath: mutateFilePathSchema,
	},
	todo_set_markdown: {
		scope: scopeSchema,
		id: idSchema,
		isMarkdown: z.boolean().describe("True to render as Markdown, false for plain text."),
		filePath: mutateFilePathSchema,
	},
	todo_set_tags: {
		scope: scopeSchema,
		id: idSchema,
		tags: z
			.array(z.string())
			.describe(
				"The new full list of tags for the item. Pass an empty array to clear all tags. " +
					"Tags are normalized (trimmed, de-duplicated case-insensitively, invalid ones dropped)."
			),
		filePath: mutateFilePathSchema,
	},
	todo_delete_items: {
		scope: scopeSchema,
		ids: z
			.array(z.number().int())
			.min(1)
			.describe("Numeric ids of the items to delete. Must contain at least one id."),
		filePath: mutateFilePathSchema,
	},
};

export type ToolName = keyof typeof TOOL_INPUTS;

export type ToolArgs<N extends ToolName> = z.infer<z.ZodObject<(typeof TOOL_INPUTS)[N]>>;

export type ToolDefinition = {
	name: ToolName;
	title: string;
	description: string;
	inputSchema: z.ZodRawShape;
	outputSchema: z.ZodRawShape;
	annotations: ToolAnnotations;
	/** Whether a call changes data; a call that times out may still land when true. */
	mutates: boolean;
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "todo_list_items",
		title: "List Todos",
		description:
			"List todos and notes for a scope. 'scope' is one of 'user' (global), " +
			"'workspace' (current project), or 'currentFile' (a specific file — requires " +
			"'filePath'). Optionally filter by 'kind' ('task', 'note', or 'all'), by " +
			"'completed' (true=done, false=open), by text prefix ('textPrefix'), by a " +
			"substring anywhere in the text ('search'), or by 'tag' (only items carrying that " +
			"tag — use it to pull up every item in a plan/group). Optionally order results with " +
			"'sortBy' (creationDate / " +
			"completionDate / completed) and 'order' (asc / desc). Results are paginated: " +
			"pass 'limit' (default 50, " +
			"max 500) and 'offset', and read 'total' / 'has_more' / 'next_offset' from the result. " +
			"To stay within an agent's context budget, a page is also trimmed to a character " +
			"limit, so it may return fewer than 'limit' items with 'has_more' true — follow " +
			"'next_offset' to fetch the rest. Item text is always returned in full, never truncated.",
		inputSchema: TOOL_INPUTS.todo_list_items,
		outputSchema: listItemsOutputSchema,
		annotations: { title: "List Todos", readOnlyHint: true, openWorldHint: false },
		mutates: false,
	},
	{
		name: "todo_count_items",
		title: "Count Todos",
		description:
			"Return todo and note counts per scope (user, workspace, currentFile) without " +
			"fetching the items themselves. Use this for a cheap overview — 'is there " +
			"outstanding work, and where?' — before paging through a scope with " +
			"todo_list_items. A scope is omitted when it is not allowed or unavailable " +
			"(e.g. currentFile with no file, or a scope excluded by allowedScopes). " +
			"Pass 'tag' to count only items carrying that tag; each scope then also " +
			"reports 'completed' (done tasks), so 'completed' of 'todos'+'completed' is " +
			"the progress of that plan/group.",
		inputSchema: TOOL_INPUTS.todo_count_items,
		outputSchema: countItemsOutputSchema,
		annotations: { title: "Count Todos", readOnlyHint: true, openWorldHint: false },
		mutates: false,
	},
	{
		name: "todo_add_item",
		title: "Add Todo",
		description:
			"Create a new todo or note in the given scope. 'scope' is one of 'user' (global), " +
			"'workspace' (current project), or 'currentFile' (a specific file — requires " +
			"'filePath'). Set 'isNote: true' for a free-text note instead of a checkable task. " +
			"Set 'isMarkdown: true' to render the text as Markdown. Set 'position' to 'top' or " +
			"'bottom' to control placement, overriding the user's createPosition setting. " +
			"Returns the created item. Rejected when the server is in read-only mode. To create " +
			"several items in a fixed order, prefer todo_add_items.",
		inputSchema: TOOL_INPUTS.todo_add_item,
		outputSchema: addItemOutputSchema,
		annotations: {
			title: "Add Todo",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		mutates: true,
	},
	{
		name: "todo_add_items",
		title: "Add Todos (ordered batch)",
		description:
			"Create multiple todos or notes in one call, preserving the given order — the " +
			"resulting list reflects the order of 'items'. Use this to lay down an ordered " +
			"list (e.g. a multi-step plan) in a single call instead of repeated todo_add_item " +
			"calls, which would reverse the order under a 'top' createPosition setting. 'scope' " +
			"is 'user', 'workspace', or 'currentFile' (requires 'filePath'). Each item may set " +
			"its own 'isNote'/'isMarkdown'. 'position' places the whole block at 'top' or " +
			"'bottom' (default); the block keeps the given order either way. Returns the created " +
			"items in order. Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_add_items,
		outputSchema: addItemsOutputSchema,
		annotations: {
			title: "Add Todos (ordered batch)",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		mutates: true,
	},
	{
		name: "todo_list_files",
		title: "List Files with Todos",
		description:
			"List files in the current workspace that have file-scoped todos, with the count " +
			"of todos per file. Results are paginated: pass 'limit' (default 50, max 500) and " +
			"'offset', and read 'total' / 'has_more' / 'next_offset' from the result. Requires " +
			"an open workspace folder.",
		inputSchema: TOOL_INPUTS.todo_list_files,
		outputSchema: listFilesOutputSchema,
		annotations: { title: "List Files with Todos", readOnlyHint: true, openWorldHint: false },
		mutates: false,
	},
	{
		name: "todo_update_text",
		title: "Update Todo Text",
		description:
			"Change the text of an existing todo or note. Identify the item by 'scope' and " +
			"numeric 'id' (use todo_list_items to find ids); for 'currentFile' scope also pass " +
			"'filePath'. Returns the updated item. Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_update_text,
		outputSchema: itemOutputSchema,
		annotations: { title: "Update Todo Text", ...mutateAnnotations },
		mutates: true,
	},
	{
		name: "todo_set_completed",
		title: "Set Todo Completed",
		description:
			"Mark a todo as completed or not completed. Identify the item by 'scope' and numeric " +
			"'id'; for 'currentFile' scope also pass 'filePath'. Set 'completed: true' to complete " +
			"(records a completion date) or 'false' to reopen it. Idempotent — setting the value it " +
			"already has is a no-op. Notes have no completion state. Returns the updated item. " +
			"Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_set_completed,
		outputSchema: itemOutputSchema,
		annotations: { title: "Set Todo Completed", ...mutateAnnotations },
		mutates: true,
	},
	{
		name: "todo_set_note",
		title: "Set Todo Note Flag",
		description:
			"Convert an item between a checkable task and a free-text note. Identify the item by " +
			"'scope' and numeric 'id'; for 'currentFile' scope also pass 'filePath'. Set " +
			"'isNote: true' to make it a note, 'false' to make it a task. Idempotent. Returns the " +
			"updated item. Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_set_note,
		outputSchema: itemOutputSchema,
		annotations: { title: "Set Todo Note Flag", ...mutateAnnotations },
		mutates: true,
	},
	{
		name: "todo_set_markdown",
		title: "Set Todo Markdown Flag",
		description:
			"Toggle whether an item's text is rendered as Markdown in the UI. Identify the item by " +
			"'scope' and numeric 'id'; for 'currentFile' scope also pass 'filePath'. Set " +
			"'isMarkdown: true' to enable Markdown rendering, 'false' to show plain text. Idempotent. " +
			"Returns the updated item. Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_set_markdown,
		outputSchema: itemOutputSchema,
		annotations: { title: "Set Todo Markdown Flag", ...mutateAnnotations },
		mutates: true,
	},
	{
		name: "todo_set_tags",
		title: "Set Todo Tags",
		description:
			"Replace the tags on an existing todo or note with the given list (replace " +
			"semantics — the array you pass becomes the item's full set of tags). Identify the " +
			"item by 'scope' and numeric 'id'; for 'currentFile' scope also pass 'filePath'. " +
			"Tags are normalized: surrounding whitespace is trimmed, duplicates are removed " +
			"case-insensitively, invalid tags are dropped, and an empty list clears all tags. " +
			"Use tags to group related items — e.g. tag every step of a plan with the same tag, " +
			"then read them back with the 'tag' filter of todo_list_items. Idempotent. Returns " +
			"the updated item. Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_set_tags,
		outputSchema: itemOutputSchema,
		annotations: { title: "Set Todo Tags", ...mutateAnnotations },
		mutates: true,
	},
	{
		name: "todo_delete_items",
		title: "Delete Todos",
		description:
			"Delete one or more todos or notes from a scope. Identify items by 'scope' and an array " +
			"of numeric 'ids' (use todo_list_items to find them); for 'currentFile' scope also pass " +
			"'filePath'. Ids that do not match any item are ignored. Returns the deleted items and a " +
			"'count'. This permanently removes the items. Rejected when the server is in read-only mode.",
		inputSchema: TOOL_INPUTS.todo_delete_items,
		outputSchema: deleteOutputSchema,
		annotations: {
			title: "Delete Todos",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		mutates: true,
	},
];

export type ResourceName = "user-todos" | "workspace-todos" | "todo-counts" | "todo-files";

export const STATIC_RESOURCES: Array<{
	name: ResourceName;
	uri: string;
	title: string;
	description: string;
}> = [
	{
		name: "user-todos",
		uri: "todo://user",
		title: "User Todos",
		description: "User-scope todos and notes",
	},
	{
		name: "workspace-todos",
		uri: "todo://workspace",
		title: "Workspace Todos",
		description: "Workspace-scope todos and notes",
	},
	{
		name: "todo-counts",
		uri: "todo://counts",
		title: "Todo Counts",
		description: "Todo and note counts by scope",
	},
	{
		name: "todo-files",
		uri: "todo://files",
		title: "Files with Todos",
		description: "List of files that have todos",
	},
];

export const FILE_RESOURCE = {
	name: "file-todos",
	uriTemplate: "todo://file?path={path}",
	uriPrefix: "todo://file",
	title: "File Todos",
	description: "File-scoped todos and notes",
};
