import TodoService from "./TodoService";
import { TodoScope, Todo } from "./todoTypes";

export type PlanArchiveAction = "complete" | "delete";

export type PlanArchiveOptions = {
	action?: PlanArchiveAction;
	includeItems?: boolean;
	filePath?: string;
};

export type PlanArchiveResult = {
	scope: TodoScope;
	filePath?: string;
	action: PlanArchiveAction;
	includeItems: boolean;
	headerIds: number[];
	itemIds: number[];
	headers?: Todo[];
	items?: Todo[];
	remainingCount?: number;
};

export default class PlanArchiveService {
	constructor(private readonly todoService: TodoService) {}

	public async archivePlan(
		scope: TodoScope,
		slug: string,
		options: PlanArchiveOptions = {}
	): Promise<PlanArchiveResult> {
		const normalizedSlug = slug.trim().toLowerCase();
		if (!normalizedSlug) {
			throw new Error("Plan slug is required.");
		}

		const action = options.action ?? "complete";
		const includeItems = options.includeItems ?? false;

		const headers = this.todoService
			.getPlanHeadersForScope(scope, options.filePath)
			.filter((header) => header.slug === normalizedSlug);
		const headerIds = headers.map((header) => header.id);

		const items = includeItems
			? this.todoService.getPlanItemsForScope(scope, normalizedSlug, options.filePath)
			: [];
		const itemIds = items.map((item) => item.id);

		let resolvedPath = options.filePath ?? headers[0]?.filePath ?? items[0]?.filePath;
		let remainingCount: number | undefined;

		const updatedHeaders: Todo[] = [];
		const updatedItems: Todo[] = [];

		if (headerIds.length > 0) {
			if (action === "delete") {
				const deleteResult = await this.todoService.deleteTodos(
					scope,
					headerIds,
					resolvedPath
				);
				remainingCount = deleteResult.remainingCount;
				resolvedPath = deleteResult.filePath ?? resolvedPath;
			} else {
				for (const header of headers) {
					const result = await this.todoService.updateTodo(
						scope,
						header.id,
						{ completed: true, isNote: false },
						options.filePath ?? header.filePath
					);
					if (result.todo) {
						updatedHeaders.push(result.todo);
					}
					resolvedPath = result.filePath ?? resolvedPath;
				}
			}
		}

		if (includeItems && itemIds.length > 0) {
			if (action === "delete") {
				const deleteResult = await this.todoService.deleteTodos(
					scope,
					itemIds,
					resolvedPath
				);
				remainingCount = deleteResult.remainingCount;
				resolvedPath = deleteResult.filePath ?? resolvedPath;
			} else {
				for (const item of items) {
					const result = await this.todoService.updateTodo(
						scope,
						item.id,
						{ completed: true, isNote: false },
						options.filePath ?? item.filePath
					);
					if (result.todo) {
						updatedItems.push(result.todo);
					}
					resolvedPath = result.filePath ?? resolvedPath;
				}
			}
		}

		return {
			scope,
			filePath: resolvedPath,
			action,
			includeItems,
			headerIds,
			itemIds,
			headers: updatedHeaders.length > 0 ? updatedHeaders : undefined,
			items: updatedItems.length > 0 ? updatedItems : undefined,
			remainingCount,
		};
	}
}
