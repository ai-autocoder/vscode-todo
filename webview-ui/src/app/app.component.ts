import { AfterViewInit, ChangeDetectorRef, Component, OnInit, ViewChild } from "@angular/core";
import {
	provideVSCodeDesignSystem,
	vsCodeBadge,
	vsCodeButton,
	vsCodeCheckbox,
	vsCodeDivider,
	vsCodePanelTab,
	vsCodePanelView,
	vsCodePanels,
} from "@vscode/webview-ui-toolkit";
import { SplitComponent } from "angular-split";
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
export class AppComponent implements OnInit, AfterViewInit {
	scope: TodoScope = TodoScope.workspace;
	TodoScope: typeof TodoScope = TodoScope;
	todoCount!: TodoCount;
	currentFilePath!: Observable<string>;
	enableWideView!: Observable<boolean>;
	enableWideViewAnimation!: Observable<boolean>;
	private lastActionTypeSubscription!: Subscription;
	isPinned = false;
	@ViewChild("mySplit") mySplitEl!: SplitComponent;
	angularSplitSubscription!: Subscription;
	isFileListExpanded = false;
	fileListViewWidth = 175;
	fileListViewMinWidth = 30;

	constructor(
		private todoService: TodoService,
		private cdRef: ChangeDetectorRef
	) {}

	ngOnInit(): void {
		// Get data
		this.todoCount = this.todoService.todoCount;
		this.currentFilePath = this.todoService.currentFilePath;
		this.enableWideView = this.todoService.enableWideView;
		this.enableWideViewAnimation = this.todoService.enableWideViewAnimation;
		this.lastActionTypeSubscription = this.todoService.currentFileLastAction.subscribe(() => {
			this.isPinned = this.todoService.isPinned;
		});
	}

	ngAfterViewInit() {
		this.angularSplitSubscription = this.mySplitEl.dragProgress$.subscribe((a) => {
			if (a.sizes[0] == this.fileListViewMinWidth) {
				this.isFileListExpanded = false;
			} else {
				this.isFileListExpanded = true;
			}
			this.cdRef.detectChanges();
		});
	}

	selectTab(tab: TodoScope) {
		this.scope = tab;
	}

	pinFile(event: MouseEvent) {
		event.stopPropagation();
		this.todoService.pinFile();
	}

	toggleFileList(event: MouseEvent) {
		if (this.isFileListExpanded) {
			this.fileListViewWidth = this.mySplitEl.getVisibleAreaSizes()[0] as number;
		}
		event.stopPropagation();
		this.isFileListExpanded = !this.isFileListExpanded;
		if (this.isFileListExpanded) {
			const width =
				this.fileListViewWidth === this.fileListViewMinWidth
					? this.fileListViewWidth + 1
					: this.fileListViewWidth;
			this.mySplitEl.setVisibleAreaSizes([width, "*"]);
		} else {
			this.mySplitEl.setVisibleAreaSizes([this.fileListViewMinWidth, "*"]);
		}
	}

	onGutterDoubleClick(event: any) {
		this.fileListViewWidth = 175;
		this.isFileListExpanded = true;
		this.mySplitEl.setVisibleAreaSizes([175, "*"]);
	}

	ngOnDestroy(): void {
		if (this.lastActionTypeSubscription) {
			this.lastActionTypeSubscription.unsubscribe();
		}
		if (this.angularSplitSubscription) {
			this.angularSplitSubscription.unsubscribe();
		}
	}
}
