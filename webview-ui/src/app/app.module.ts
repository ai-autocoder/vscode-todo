import { DragDropModule } from "@angular/cdk/drag-drop";
import { CUSTOM_ELEMENTS_SCHEMA, NgModule } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { BrowserModule } from "@angular/platform-browser";
import { AppComponent } from "./app.component";
import { TextArea } from "./shared/text-area.component";
import { TodoLabel } from "./shared/todo-label.component";
import { NewTodoComponent } from "./todo/new-todo/new-todo.component";
import { TodoList } from "./todo/todo-list/todo-list.component";
import { AutoAnimateDirective } from "./utilities/animate";

@NgModule({
	declarations: [
		AppComponent,
		TodoLabel,
		TodoList,
		TextArea,
		NewTodoComponent,
		AutoAnimateDirective,
	],
	imports: [BrowserModule, FormsModule, DragDropModule],
	providers: [],
	bootstrap: [AppComponent],
	schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
