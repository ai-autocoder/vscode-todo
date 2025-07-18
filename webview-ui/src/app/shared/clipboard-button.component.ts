import { AsyncPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { merge, of, Subject, timer } from "rxjs";
import { distinctUntilChanged, map, shareReplay, startWith, switchMap } from "rxjs/operators";
import { IconComponent } from "./icon/icon.component";

@Component({
    selector: "app-clipboard-button",
    template: `
		<vscode-button
		  appearance="icon"
		  class="icon-button markdown-clipboard-button"
		  [class.copied]="copied$ | async"
		  aria-label="Copy to clipboard"
		  title="Copy"
		  (click)="onCopyToClipboardClick()"
		  >
		  @if (copied$ | async) {
		    {{ copiedText$ | async }}
		  } @else {
		    <app-icon [name]="'copy'"></app-icon>
		  }
		</vscode-button>
		`,
    styles: [
        `
			vscode-button[appearance="icon"]:not(:hover) {
				background: rgba(39, 40, 34, 0.5);
			}
		`,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AsyncPipe, IconComponent],
    schemas: [CUSTOM_ELEMENTS_SCHEMA]
})
export class ClipboardButtonComponent {
	private _buttonClick$ = new Subject<void>();

	copied$ = this._buttonClick$.pipe(
		switchMap(() => merge(of(true), timer(3000).pipe(map(() => false)))),
		distinctUntilChanged(),
		shareReplay(1)
	);

	copiedText$ = this.copied$.pipe(
		startWith(false),
		map((copied) => (copied ? "Copied" : ""))
	);

	onCopyToClipboardClick(): void {
		this._buttonClick$.next();
	}
}
