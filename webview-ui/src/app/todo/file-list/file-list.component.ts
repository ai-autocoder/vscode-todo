import { ChangeDetectionStrategy, Component } from "@angular/core";
import { TodoService } from "../todo.service";
import { Observable } from "rxjs";

@Component({
	selector: "file-list",
	templateUrl: "./file-list.component.html",
	styleUrls: ["./file-list.component.scss"],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileList {
	workspaceFilesWithRecords!: Observable<{ filePath: string; todoNumber: number }[]>;
	currentFilePath!: Observable<string>;

	constructor(private todoService: TodoService) {
		this.workspaceFilesWithRecords = this.todoService.workspaceFilesWithRecords;
		this.currentFilePath = this.todoService.currentFilePath;
	}

	setCurrentFile(filePath: string) {
		this.todoService.setCurrentFile(filePath);
	}
}
