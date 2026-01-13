import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { TodoService } from "../todo.service";
import { TodoFilesDataPaths } from "../../../../../src/todo/todoTypes";

type FileListEntry = {
	filePath: string;
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

		return files.map((file) => ({
			...file,
			isActive: file.filePath === currentFilePath,
			tooltip: buildFileTooltip(file.filePath, pathsMap),
		}));
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
