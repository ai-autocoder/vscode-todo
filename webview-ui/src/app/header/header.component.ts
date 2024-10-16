import { Component } from "@angular/core";
import { TodoService } from "../todo/todo.service";

import { ExportFormats, ImportFormats } from "../../../../src/todo/todoTypes";

@Component({
	selector: "app-header",
	templateUrl: "./header.component.html",
	styleUrl: "./header.component.css",
})
export class HeaderComponent {
	ExportFormats = ExportFormats;
	ImportFormats = ImportFormats;
	isImportMenuOpen = false;
	isExportMenuOpen = false;

	constructor(private todoService: TodoService) {}

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
}
