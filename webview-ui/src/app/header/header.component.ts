import { Component, OnInit } from "@angular/core";
import { TodoService } from "../todo/todo.service";
import { ExportFormats, ImportFormats } from "../../../../src/todo/todoTypes";
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
}
