import { Component } from "@angular/core";
import {
	provideVSCodeDesignSystem,
	vsCodeButton,
	vsCodeCheckbox,
	vsCodeDivider,
	vsCodeTextArea,
	vsCodePanelTab,
	vsCodePanelView,
	vsCodePanels,
	vsCodeBadge,
} from "@vscode/webview-ui-toolkit";
import { TodoLevel } from "../../../src/todo/store";

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
	styleUrls: ["./app.component.css"],
})
export class AppComponent {
	level: TodoLevel = TodoLevel.workspace;
	TodoLevel: typeof TodoLevel = TodoLevel;

	selectTab(tab: TodoLevel) {
		this.level = tab;
	}
}
