import { AsyncPipe, NgIf } from "@angular/common";
import { ChangeDetectionStrategy, Component, CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { merge, of, Subject, timer } from "rxjs";
import { distinctUntilChanged, map, shareReplay, startWith, switchMap } from "rxjs/operators";
import { SafeHtmlPipe } from "../pipes/safe-html.pipe";

const ICON_COPY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
	<g fill="#C5C5C5" fill-rule="evenodd" clip-rule="evenodd">
		<path d="m4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1zm9 3l-3-3H5v10h8z" />
		<path d="M3 1L2 2v10l1 1V2h6.414l-1-1z" />
	</g>
</svg>`;
const ICON_COPIED = "Copied";

@Component({
	selector: "app-clipboard-button",
	standalone: true,
	template: `
		<vscode-button
			appearance="icon"
			class="icon-button markdown-clipboard-button"
			[class.copied]="copied$ | async"
			aria-label="Copy to clipboard"
			title="Copy"
			(click)="onCopyToClipboardClick($event)"
		>
			<ng-container *ngIf="copied$ | async; else icon">{{ copiedText$ | async }}</ng-container>
			<ng-template #icon><span [innerHTML]="ICON_COPY | safeHtml"></span></ng-template>
		</vscode-button>
	`,
	changeDetection: ChangeDetectionStrategy.OnPush,
	imports: [AsyncPipe, NgIf, SafeHtmlPipe],
	schemas: [CUSTOM_ELEMENTS_SCHEMA],
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
		map((copied) => (copied ? ICON_COPIED : ""))
	);

	onCopyToClipboardClick(event: MouseEvent): void {
		this._buttonClick$.next();
	}

	ICON_COPY = ICON_COPY;
}
