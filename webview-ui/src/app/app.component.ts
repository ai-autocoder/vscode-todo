import { Component, OnInit } from "@angular/core";
import {
	provideVSCodeDesignSystem,
	vsCodeBadge,
	vsCodeButton,
	vsCodeCheckbox,
	vsCodeDivider,
	vsCodePanelTab,
	vsCodePanelView,
	vsCodePanels,
	vsCodeTextArea,
} from "@vscode/webview-ui-toolkit";
import { Observable, Subscription } from "rxjs";
import { TodoCount, TodoScope } from "../../../src/todo/todoTypes";
import { TodoService } from "./todo/todo.service";

// In order to use the Webview UI Toolkit web components they
// must be registered with the browser (i.e. webview) using the
// syntax below.

// https://github.com/microsoft/vscode-webview-ui-toolkit/blob/main/src/text-area/README.md

provideVSCodeDesignSystem().register(
	vsCodeButton(),
	vsCodeCheckbox(),
	vsCodeDivider(),
	vsCodeTextArea(),
	vsCodePanelTab(),
	vsCodePanelView(),
	vsCodePanels(),
	vsCodeBadge()
);

// To register more toolkit components, simply import the component
// registration function and call it from within the register
// function, like so:
//
// provideVSCodeDesignSystem().register(
//   vsCodeButton(),
//   vsCodeCheckbox()
// );
//
// Finally, if you would like to register all of the toolkit
// components at once, there's a handy convenience function:
//
// provideVSCodeDesignSystem().register(allComponents);

@Component({
	selector: "app-root",
	templateUrl: "./app.component.html",
	styleUrls: ["./app.component.scss"],
})
export class AppComponent implements OnInit {
	scope: TodoScope = TodoScope.workspace;
	TodoScope: typeof TodoScope = TodoScope;
	todoCount!: TodoCount;
	currentFilePath!: Observable<string>;
	private lastActionTypeSubscription!: Subscription;
	isPinned = false;

	constructor(private todoService: TodoService) {}

	ngOnInit(): void {
		// Get data
		this.todoCount = this.todoService.todoCount;
		this.currentFilePath = this.todoService.currentFilePath;
		this.lastActionTypeSubscription = this.todoService.currentFileLastAction.subscribe(() => {
			this.isPinned = this.todoService.isPinned;
		});
	}

	selectTab(tab: TodoScope) {
		this.scope = tab;
	}

	pinFile(event: MouseEvent) {
		event.stopPropagation();
		this.todoService.pinFile();
	}

	ngOnDestroy(): void {
		if (this.lastActionTypeSubscription) {
			this.lastActionTypeSubscription.unsubscribe();
		}
	}
}
