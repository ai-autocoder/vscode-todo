import { CommonModule } from "@angular/common";
import { NgModule } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { AppModule } from "../app.module";
import { PwaShellComponent } from "./pwa-shell.component";

/**
 * Root module of the standalone PWA. Wraps the regular {@link AppModule} with
 * {@link PwaShellComponent}, which owns the GitHub connection flow and the gateway bridge.
 * Loaded only by the PWA branch of `main.ts` (a dynamic import, so none of this reaches the
 * extension webview at runtime).
 */
@NgModule({
	declarations: [PwaShellComponent],
	imports: [CommonModule, FormsModule, AppModule],
	bootstrap: [PwaShellComponent],
})
export class PwaAppModule {}
