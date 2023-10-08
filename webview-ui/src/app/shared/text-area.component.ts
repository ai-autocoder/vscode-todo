import { Component, EventEmitter, Input, Output } from "@angular/core";

@Component({
	selector: "text-area",
	template: `
		<vscode-text-area
			(input)="onInput($event)"
			[placeholder]="placeholder"
			[value]="text"
		></vscode-text-area>
	`,
})
export class TextArea {
	text: string = "";

	@Output() valueChange = new EventEmitter<string>();
	@Input() placeholder: string = "";

	@Input()
	get value(): string {
		return this.text;
	}

	set value(value: string) {
		this.text = value;
		this.valueChange.emit(this.text);
	}

	onInput(event: Event) {
		this.value = (event.target as HTMLTextAreaElement).value;
	}
}
