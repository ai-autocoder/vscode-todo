import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { TodoService } from "../todo.service";
import { TodoFilesDataPaths } from "../../../../../src/todo/todoTypes";
import { buildFileLabels } from "@vsc-todo/core";

type FileListEntry = {
	filePath: string;
	label: string;
	todoNumber: number;
	tooltip: string;
	isActive: boolean;
};

const emptyPaths: TodoFilesDataPaths = {};

@Component({
    selector: "file-list",
    templateUrl: "./file-list.component.html",
    styleUrls: ["./file-list.component.scss"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class FileList {
	private readonly todoService = inject(TodoService);
	private readonly workspaceFilesWithRecords = toSignal(
		this.todoService.workspaceFilesWithRecords,
		{ initialValue: [] }
	);
	private readonly currentFilePath = toSignal(this.todoService.currentFilePath, { initialValue: "" });
	private readonly filesDataPaths = toSignal(this.todoService.filesDataPaths, {
		initialValue: emptyPaths,
	});

	readonly fileEntries = computed<FileListEntry[]>(() => {
		const files = this.workspaceFilesWithRecords();
		const currentFilePath = this.currentFilePath();
		const pathsMap = this.filesDataPaths();

		// The gist's per-file keys are raw absolute paths from whichever machine wrote them, so
		// on a phone the full path is unreadable. Show a basename (widened only where two keys
		// would otherwise collide) and keep every known path in the tooltip.
		const labels = buildFileLabels(files.map((file) => file.filePath));

		return files
			.map((file) => ({
				...file,
				label: labels[file.filePath] ?? file.filePath,
				isActive: file.filePath === currentFilePath,
				tooltip: buildFileTooltip(file.filePath, pathsMap),
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	});

	setCurrentFile(filePath: string) {
		this.todoService.setCurrentFile(filePath);
	}
}

function buildFileTooltip(filePath: string, pathsMap: TodoFilesDataPaths): string {
	const entry = pathsMap?.[filePath];
	const ordered: string[] = [];
	const seen = new Set<string>();

	const addPath = (value?: string) => {
		if (!value || seen.has(value)) {
			return;
		}
		seen.add(value);
		ordered.push(value);
	};

	addPath(filePath);
	if (entry) {
		entry.absPaths?.forEach((absPath) => addPath(absPath));
		entry.relPaths?.forEach((relPath) => addPath(relPath));
	}

	return ordered.join("\n");
}
