import { Component, Input } from "@angular/core";
import { CommonModule } from "@angular/common";

@Component({
	selector: "app-icon",
	templateUrl: "./icon.component.html",
	styleUrls: ["./icon.component.scss"],
	standalone: true,
	imports: [CommonModule],
})
export class IconComponent {
	@Input() name: string = "";
}
