import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	EventEmitter,
	ElementRef,
	Input,
	Output,
	ViewChild,
} from "@angular/core";

@Component({
    selector: "autosize-text-area",
    template: `
		<textarea
			#textarea
			cdkTextareaAutosize
			(input)="onInput($event)"
			[placeholder]="placeholder"
			[value]="text"
		></textarea>
	`,
    styles: [
        `
			textarea {
				box-sizing: content-box;
				overflow: hidden;
				color: var(--vscode-input-foreground);
				background: var(--vscode-input-background);
				border-radius: calc(var(--corner-radius-round) * 1px);
				border: calc(var(--border-width) * 1px) solid var(--vscode-dropdown-border);
				font-style: inherit;
				font-variant: inherit;
				font-weight: inherit;
				font-stretch: inherit;
				font-family: inherit;
				font-optical-sizing: inherit;
				font-kerning: inherit;
				font-feature-settings: inherit;
				font-variation-settings: inherit;
				font-size: var(--vscode-editor-font-size);
				line-height: var(--type-ramp-base-line-height);
				padding: calc(var(--design-unit) * 2px);
				width: 100%;
				min-width: var(--input-min-width);
				resize: none;
				outline: none;
			}
		`,
        `
			textarea::placeholder {
				color: var(--vscode-input-placeholderForeground);
			}
		`,
        `
			textarea:hover:enabled {
				background: var(--vscode-input-background);
				border-color: var(--vscode-dropdown-border);
			}
		`,
        `
			textarea:active:enabled,
			textarea:focus:enabled {
				border-color: var(--vscode-focusBorder);
			}
		`,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class AutosizeTextArea implements AfterViewInit {
	text: string = "";

	@Output() valueChange = new EventEmitter<string>();
	@Input() placeholder: string = "";
	@Input() autofocus: boolean = false;
	@ViewChild("textarea") textareaElement!: ElementRef<HTMLTextAreaElement>;
	@Input()
	get value(): string {
		return this.text;
	}

	set value(value: string) {
		this.text = value;
		this.valueChange.emit(this.text);
	}

	ngAfterViewInit() {
		if (this.autofocus) {
			this.textareaElement.nativeElement.focus();
		}
	}

	onInput(event: Event) {
		this.value = (event.target as HTMLTextAreaElement).value;
	}
}
