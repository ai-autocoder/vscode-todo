import { Injectable } from "@angular/core";
import { Observable, Subject } from "rxjs";

/**
 * Lets the shared header open the PWA's About panel without knowing it exists.
 *
 * The menu entry lives in the header, which both builds share, while the panel lives in the PWA
 * shell, which only the `pwa` build has. The header asks through this service; the shell is the
 * only subscriber. In the extension webview the entry is hidden and nothing subscribes, so a
 * request there would simply go nowhere.
 */
@Injectable({ providedIn: "root" })
export class AboutPanelService {
	private readonly requests = new Subject<void>();

	/** Emits once per request to show the panel. */
	readonly openRequests: Observable<void> = this.requests.asObservable();

	open(): void {
		this.requests.next();
	}
}
