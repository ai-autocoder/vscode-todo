import { AsyncPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, CUSTOM_ELEMENTS_SCHEMA, Input } from "@angular/core";
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

	@Input() text: string | undefined;

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
		if (typeof this.text === "string") {
			this.copyToClipboard(this.text);
		}
		this._buttonClick$.next();
	}

	private async copyToClipboard(text: string): Promise<void> {
		try {
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return;
			}
		} catch {
			// fall through to legacy approach
		}

		// Legacy fallback for environments where navigator.clipboard is not available
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		try {
			(document as any).execCommand("copy");
		} finally {
			document.body.removeChild(textarea);
		}
	}
}
