import { DragDropModule } from "@angular/cdk/drag-drop";
import { CUSTOM_ELEMENTS_SCHEMA, NgModule } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { BrowserModule } from "@angular/platform-browser";
import { AppComponent } from "./app.component";
import { AutosizeTextArea } from "./shared/autosize-textarea.component";
import { TodoLabel } from "./shared/todo-label.component";
import { NewTodoComponent } from "./todo/new-todo/new-todo.component";
import { TodoList } from "./todo/todo-list/todo-list.component";
import { AutoAnimateDirective } from "./utilities/animate";
import { MatSnackBarModule } from "@angular/material/snack-bar";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { MatMenuModule } from "@angular/material/menu";
import { MatDividerModule } from "@angular/material/divider";
import { TodoItemComponent } from "./todo/todo-item/todo-item.component";
import { CLIPBOARD_OPTIONS, MarkdownModule } from "ngx-markdown";
import { FileNamePipe } from "./pipes/file-name.pipe";
import { FileList } from "./todo/file-list/file-list.component";
import { CdkTextareaAutosize, TextFieldModule } from "@angular/cdk/text-field";
import { AngularSplitModule } from "angular-split";
import { ClipboardButtonComponent } from "./shared/clipboard-button.component";
import { IconComponent } from "./shared/icon/icon.component";
import { HeaderComponent } from "./header/header.component";
import "prismjs";
import "../app/prism/prism-languages-index.js";
import "prismjs/plugins/line-numbers/prism-line-numbers.js";

@NgModule({
	declarations: [
		AppComponent,
		TodoLabel,
		TodoList,
		TodoItemComponent,
		NewTodoComponent,
		AutoAnimateDirective,
		FileNamePipe,
		FileList,
		AutosizeTextArea,
		HeaderComponent,
	],
	imports: [
		BrowserModule,
		FormsModule,
		DragDropModule,
		MatSnackBarModule,
		BrowserAnimationsModule,
		MatMenuModule,
		MatDividerModule,
		TextFieldModule,
		CdkTextareaAutosize,
		MarkdownModule.forRoot({
			clipboardOptions: {
				provide: CLIPBOARD_OPTIONS,
				useValue: {
					buttonComponent: ClipboardButtonComponent,
				},
			},
		}),
		AngularSplitModule,
		IconComponent,
	],
	providers: [],
	bootstrap: [AppComponent],
	schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
