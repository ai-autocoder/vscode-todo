import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	EventEmitter,
	HostListener,
	Input,
	OnDestroy,
	Output,
	ViewChild,
} from "@angular/core";

@Component({
    selector: "autosize-text-area",
    template: `
		<textarea
			rows="1"
			#textarea
			(input)="onInput($event)"
			[placeholder]="placeholder"
			[value]="text"
		></textarea>
	`,
    styles: [
        `
			textarea {
				box-sizing: border-box;
				overflow-y: hidden;
				color: var(--vscode-input-foreground);
				background: var(--vscode-input-background);
				border-radius: calc(var(--corner-radius-round) * 1px);
				border: calc(var(--border-width) * 1px) solid var(--vscode-dropdown-border);
				font-style: inherit;
				font-variant: inherit;
				font-weight: inherit;
				font-stretch: inherit;
				font-family: var(--app-font-family);
				font-optical-sizing: inherit;
				font-kerning: inherit;
				font-feature-settings: inherit;
				font-variation-settings: inherit;
				font-size: var(--app-font-size);
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
export class AutosizeTextArea implements AfterViewInit, OnDestroy {
	private static readonly DEFAULT_MAX_HEIGHT_VH = 60;
	private resizeFrameId: number | null = null;
	text: string = "";

	@Output() valueChange = new EventEmitter<string>();
	@Input() placeholder: string = "";
	@Input() autofocus: boolean = false;
	@Input() maxHeightVh: number = AutosizeTextArea.DEFAULT_MAX_HEIGHT_VH;
	@ViewChild("textarea") textareaElement!: ElementRef<HTMLTextAreaElement>;

	@Input()
	get value(): string {
		return this.text;
	}

	set value(value: string) {
		this.text = value ?? "";
		this.valueChange.emit(this.text);
		this.scheduleResize();
	}

	ngAfterViewInit() {
		if (this.autofocus) {
			this.textareaElement.nativeElement.focus();
		}

		this.scheduleResize();
	}

	ngOnDestroy() {
		if (this.resizeFrameId !== null) {
			cancelAnimationFrame(this.resizeFrameId);
		}
	}

	onInput(event: Event) {
		this.value = (event.target as HTMLTextAreaElement).value;
	}

	@HostListener("window:resize")
	onWindowResize() {
		this.scheduleResize();
	}

	// Use rAF so scrollHeight reflects the latest change
	private scheduleResize() {
		if (!this.textareaElement) {
			return;
		}

		if (this.resizeFrameId !== null) {
			cancelAnimationFrame(this.resizeFrameId);
		}

		this.resizeFrameId = requestAnimationFrame(() => {
			this.resizeFrameId = null;
			this.applyResize();
		});
	}

	private applyResize() {
		const textarea = this.textareaElement?.nativeElement;

		if (!textarea) {
			return;
		}

		const bottomThreshold = this.resolveBottomThreshold(textarea);
		const previousScrollTop = textarea.scrollTop;
		const previousClientHeight = textarea.clientHeight;
		const previousScrollHeight = textarea.scrollHeight;
		const distanceFromBottom = previousScrollHeight - previousClientHeight - previousScrollTop;
		const wasAtBottom = distanceFromBottom <= bottomThreshold;

		const maxHeight = this.resolveMaxHeight();
		textarea.style.maxHeight = `${maxHeight}px`;
		textarea.style.height = "auto";

		const fullHeight = textarea.scrollHeight;
		const clampedHeight = Math.min(fullHeight, maxHeight);

		textarea.style.height = `${clampedHeight}px`;
		textarea.style.overflowY = fullHeight > maxHeight ? "auto" : "hidden";

		const newMaxScrollTop = Math.max(textarea.scrollHeight - textarea.clientHeight, 0);

		if (fullHeight > maxHeight) {
			if (wasAtBottom) {
				textarea.scrollTop = newMaxScrollTop;
			} else {
				textarea.scrollTop = Math.min(previousScrollTop, newMaxScrollTop);
			}
		} else {
			textarea.scrollTop = 0;
		}
	}

	private resolveMaxHeight(): number {
		const vh = Number.isFinite(this.maxHeightVh) ? this.maxHeightVh : AutosizeTextArea.DEFAULT_MAX_HEIGHT_VH;
		const normalized = Math.min(Math.max(vh, 0), 100);
		return Math.round((window.innerHeight * normalized) / 100);
	}

	private resolveBottomThreshold(textarea: HTMLTextAreaElement): number {
		const computed = window.getComputedStyle(textarea);
		let threshold = parseFloat(computed.lineHeight);

		if (Number.isNaN(threshold)) {
			const fontSize = parseFloat(computed.fontSize);
			threshold = Number.isNaN(fontSize) ? 24 : fontSize * 1.2;
		}

		return Math.max(threshold, 1);
	}
}
