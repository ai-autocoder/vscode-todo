import { Component, Input } from "@angular/core";
import { Todo } from "../../../../src/todo/store";

@Component({
	selector: "todo-label",
	templateUrl: "./todo-label.component.html",
	styleUrls: ["./todo-label.component.css"],
})
export class TodoLabel {
	@Input() todo!: Todo;
}
