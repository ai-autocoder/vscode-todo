/**
 * The PWA's stand-in for the file dialogs and `fs` calls the extension gets from VS Code.
 *
 * `src/todo/exporter.ts` writes with `fs.writeFileSync` after a `showSaveDialog`, and
 * `src/todo/importer.ts` reads with `fs.readFile` after a `showOpenDialog`. A browser has
 * neither, so this module supplies the equivalents: a download for saving and an
 * `<input type="file">` for opening.
 *
 * Deliberately plain functions with no Angular dependency — `GistGateway` is built by a bare
 * factory (`data.providers.pwa.ts`), so it has no injector to pull a service from.
 *
 * PWA-only: nothing here is referenced by the extension webview build.
 */

/** Why a file could not be read. `cancelled` is the ordinary case of dismissing the picker. */
export type FilePickFailure = "cancelled" | "read-failed";

export type FilePickResult =
	| { ok: true; name: string; text: string }
	| { ok: false; reason: FilePickFailure; message: string };

/**
 * Opens the platform file picker and reads the chosen file as text.
 *
 * Must be called from a user gesture (a menu click), or the browser will ignore the `.click()`.
 * There is no "cancelled" event for a file input, so a dismissed picker settles only when the
 * window regains focus — without that fallback this promise would never resolve and the
 * caller's spinner would hang forever.
 */
export function pickTextFile(accept: string): Promise<FilePickResult> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = accept;
		// Keep it out of the layout and out of the a11y tree; it is only ever clicked in code.
		input.style.display = "none";
		input.setAttribute("aria-hidden", "true");

		let settled = false;
		const finish = (result: FilePickResult) => {
			if (settled) {
				return;
			}
			settled = true;
			window.removeEventListener("focus", onWindowFocus);
			input.remove();
			resolve(result);
		};

		const onWindowFocus = () => {
			// Focus returns before `change` fires, so give the change event a chance first.
			window.setTimeout(() => {
				if (!input.files || input.files.length === 0) {
					finish({ ok: false, reason: "cancelled", message: "Import cancelled." });
				}
			}, 300);
		};

		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				finish({ ok: false, reason: "cancelled", message: "Import cancelled." });
				return;
			}
			file
				.text()
				.then((text) => finish({ ok: true, name: file.name, text }))
				.catch(() =>
					finish({
						ok: false,
						reason: "read-failed",
						message: `Could not read ${file.name}.`,
					})
				);
		});

		document.body.appendChild(input);
		window.addEventListener("focus", onWindowFocus);
		input.click();
	});
}

/**
 * Hands the user a text file to save.
 *
 * Uses the File System Access API where it exists (a real save dialog, so the user picks the
 * destination) and falls back to an object-URL download everywhere else. The fallback is what
 * runs on iOS, where a standalone-display PWA's downloads are historically unreliable — hence
 * the boolean: callers report failure rather than claiming a save that may not have happened.
 *
 * Returns false only when the save was abandoned or rejected.
 */
export async function downloadTextFile(
	fileName: string,
	text: string,
	mimeType: string
): Promise<boolean> {
	const picker = (
		window as Window & {
			showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandleLike>;
		}
	).showSaveFilePicker;

	if (typeof picker === "function") {
		try {
			const handle = await picker.call(window, {
				suggestedName: fileName,
				types: [{ description: "Plans export", accept: { [mimeType]: [extensionOf(fileName)] } }],
			});
			const writable = await handle.createWritable();
			await writable.write(text);
			await writable.close();
			return true;
		} catch (error) {
			// A dismissed save dialog throws AbortError; treat it as "not saved", not as a bug.
			if (isAbortError(error)) {
				return false;
			}
			// Anything else (a permission or quota failure) falls through to the download path,
			// which may still work.
		}
	}

	return downloadViaObjectUrl(fileName, text, mimeType);
}

function downloadViaObjectUrl(fileName: string, text: string, mimeType: string): boolean {
	try {
		const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = fileName;
		anchor.style.display = "none";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		// Revoking synchronously can cancel the download that was just started, so give the
		// browser a turn to pick the URL up first.
		window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
		return true;
	} catch {
		return false;
	}
}

/** True when the platform can offer the export as a share sheet — the iOS fallback. */
export function canShareFile(): boolean {
	const nav = navigator as Navigator & { canShare?: (data: unknown) => boolean };
	return typeof nav.share === "function" && typeof nav.canShare === "function";
}

/**
 * Offers the export through the platform share sheet. On iOS this is the reliable route to
 * Files/iCloud when a standalone PWA's download does nothing.
 */
export async function shareTextFile(
	fileName: string,
	text: string,
	mimeType: string
): Promise<boolean> {
	const nav = navigator as Navigator & {
		canShare?: (data: unknown) => boolean;
		share?: (data: unknown) => Promise<void>;
	};
	if (typeof nav.share !== "function" || typeof nav.canShare !== "function") {
		return false;
	}
	try {
		const file = new File([text], fileName, { type: mimeType });
		if (!nav.canShare({ files: [file] })) {
			return false;
		}
		await nav.share({ files: [file], title: fileName });
		return true;
	} catch {
		// Covers both a dismissed share sheet and a platform refusal. Neither is worth
		// distinguishing here: the caller only needs to know the file did not go anywhere.
		return false;
	}
}

function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot === -1 ? "" : fileName.slice(dot);
}

function isAbortError(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as { name?: string }).name === "AbortError";
}

interface FileSystemFileHandleLike {
	createWritable(): Promise<{
		write(data: string): Promise<void>;
		close(): Promise<void>;
	}>;
}
