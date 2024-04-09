import { Pipe, PipeTransform } from "@angular/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

@Pipe({
	name: "fileName",
	pure: false, // Set pure to false to handle observables
})
export class FileNamePipe implements PipeTransform {
	transform(value: Observable<string> | string | null): Observable<string> | string {
		if (!value) {
			return "";
		} else if (typeof value === "string") {
			return this.getFileName(value);
		} else {
			return value.pipe(map((filePath) => this.getFileName(filePath)));
		}
	}

	private getFileName(filePath: string): string {
		const parts = filePath.split(/[\\\/]/);
		return parts.pop() || "";
	}
}
