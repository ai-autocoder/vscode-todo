import { CUSTOM_ELEMENTS_SCHEMA, NgModule } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { BrowserModule } from "@angular/platform-browser";
import { AppComponent } from "./app.component";
import { TodoLabel } from "./shared/todo-label.component";
import { TodoList } from "./todo/todo-list/todo-list.component";
import { TextArea } from "./shared/text-area.component";
import { NewTodoComponent } from "./todo/new-todo/new-todo.component";

@NgModule({
	declarations: [AppComponent, TodoLabel, TodoList, TextArea, NewTodoComponent],
	imports: [BrowserModule, FormsModule],
	providers: [],
	bootstrap: [AppComponent],
	schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
