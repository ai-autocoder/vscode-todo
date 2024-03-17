import {
	AfterViewInit,
	Component,
	ElementRef,
	EventEmitter,
	Input,
	OnChanges,
	Output,
	QueryList,
	SimpleChanges,
	ViewChildren,
} from "@angular/core";

@Component({
	selector: "text-area",
	template: `
		<vscode-text-area
			#autoResizeTextArea
			(input)="onInput($event)"
			[placeholder]="placeholder"
			[value]="text"
			[resize]="autoResize ? 'none' : 'vertical'"
		></vscode-text-area>
	`,
	styles: [
		`
			vscode-text-area {
				width: inherit;
				display: flex;
			}
		`,
		`
			vscode-text-area::part(control) {
				font-size: var(--vscode-editor-font-size);
			}
		`,
	],
})
export class TextArea implements AfterViewInit, OnChanges {
	text: string = "";
	currentHeight: number = 0;

	@Output() valueChange = new EventEmitter<string>();
	@Input() placeholder: string = "";
	@Input() autoResize: boolean = false;
	@ViewChildren("autoResizeTextArea", { read: ElementRef }) textareaParts!: QueryList<ElementRef>;
	@Input()
	get value(): string {
		return this.text;
	}

	set value(value: string) {
		this.text = value;
		this.valueChange.emit(this.text);
	}

	ngAfterViewInit(): void {
		this.adjustHeight();
		this.setFocus();
	}

	private setFocus() {
		if (this.textareaParts.first) {
			const textarea: HTMLTextAreaElement =
				this.textareaParts.first.nativeElement.shadowRoot?.querySelector('[part="control"]');
			if (textarea) {
				setTimeout(() => textarea.focus(), 0);
			}
		}
	}

	ngOnChanges(changes: SimpleChanges): void {
		if (changes["autoResize"] || changes["value"]) {
			this.adjustHeight();
		}
	}

	onInput(event: Event) {
		this.value = (event.target as HTMLTextAreaElement).value;
	}

	adjustHeight(): void {
		setTimeout(() => {
			const extraSpace = 3;
			this.textareaParts.forEach((part) => {
				const textarea: HTMLTextAreaElement =
					part.nativeElement.shadowRoot?.querySelector('[part="control"]');

				// If autoResize is true, set overflow to hidden to avoid scrollbars to appear before the height is calculated.
				textarea.style.overflow = this.autoResize ? "hidden" : "auto";
				// Reset the height to get accurate scrollHeight
				textarea.style.height = "auto";
				if (!this.autoResize) return;

				requestAnimationFrame(() => {
					let newHeight = textarea.scrollHeight + extraSpace;
					const scrollHeightDiff = Math.abs(newHeight - this.currentHeight);

					if (this.currentHeight != 0 && scrollHeightDiff <= extraSpace) {
						newHeight = this.currentHeight;
					}

					textarea.style.height = `${newHeight}px`;
					this.currentHeight = newHeight;

					// If maxHeight is exceeded, set overflow to auto
					const maxHeight = parseInt(window.getComputedStyle(textarea).maxHeight, 10);
					if (newHeight > maxHeight) {
						textarea.style.overflow = "auto";
					}
				});
			});
		}, 0);
	}
}
