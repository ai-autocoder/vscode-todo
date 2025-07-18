import { Component, Input } from "@angular/core";


@Component({
    selector: "app-icon",
    templateUrl: "./icon.component.html",
    styleUrls: ["./icon.component.scss"],
    imports: []
})
export class IconComponent {
	@Input() name: string = "";
}
