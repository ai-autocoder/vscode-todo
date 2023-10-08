import { Component, Input } from "@angular/core";
import { Todo } from "../../../../src/todo/store";

@Component({
	selector: "todo-label",
	templateUrl: "./todo-label.component.html",
	styleUrls: ["./todo-label.component.css"],
})
export class TodoLabel {
	@Input() todo!: Todo;
	creationDate!: Date;

	constructor() {
		if (this.todo?.creationDate) {
			this.creationDate = this.parseDateString(this.todo.creationDate);
		}
	}

	// Function to parse date strings into Date objects
	parseDateString(dateString: string): Date {
		return new Date(dateString);
	}
}
