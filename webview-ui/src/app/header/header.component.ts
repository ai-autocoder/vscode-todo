import { Component, Input, OnInit } from "@angular/core";
import { TodoService } from "../todo/todo.service";
import { ExportFormats, ImportFormats, TodoScope } from "../../../../src/todo/todoTypes";
import { Observable } from "rxjs";

@Component({
	selector: "app-header",
	templateUrl: "./header.component.html",
	styleUrl: "./header.component.css",
})
export class HeaderComponent implements OnInit {
	ExportFormats = ExportFormats;
	ImportFormats = ImportFormats;
	isImportMenuOpen = false;
	isExportMenuOpen = false;
	enableWideView!: Observable<boolean>;
	@Input() currentScope!: TodoScope;

	constructor(readonly todoService: TodoService) {}

	ngOnInit(): void {
		this.enableWideView = this.todoService.enableWideView;
	}

	import(format: ImportFormats) {
		this.todoService.import(format);
	}

	export(format: ExportFormats) {
		this.todoService.export(format);
	}

	onImportMenuOpened() {
		this.isImportMenuOpen = true;
	}

	onImportMenuClosed() {
		this.isImportMenuOpen = false;
	}

	onExportMenuOpened() {
		this.isExportMenuOpen = true;
	}

	onExportMenuClosed() {
		this.isExportMenuOpen = false;
	}

	setWideViewEnabled(isEnabled: boolean) {
		this.todoService.setWideViewEnabled(isEnabled);
	}

	deleteAll() {
		this.todoService.deleteAll(this.currentScope);
	}

	get isListEmpty(): boolean {
		switch (this.currentScope) {
			case TodoScope.user:
				return this.todoService.todoCount.user === 0;
			case TodoScope.workspace:
				return this.todoService.todoCount.workspace === 0;
			case TodoScope.currentFile:
				return this.todoService.todoCount.currentFile === 0;
			default:
				return true;
		}
	}
}
