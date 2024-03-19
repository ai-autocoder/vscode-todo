import * as vscode from "vscode";

/**
 * Retrieves the current theme kind and returns a string representing the theme (light/dark).
 *
 * @return {string} String representing the current theme (light/dark)
 */
export function getCurrentThemeKind() {
	const themeKind = vscode.window.activeColorTheme.kind;
	switch (themeKind) {
		case vscode.ColorThemeKind.Light:
		case vscode.ColorThemeKind.HighContrastLight:
			return "light";
		case vscode.ColorThemeKind.Dark:
		case vscode.ColorThemeKind.HighContrast:
			return "dark";
		default:
			return "";
	}
}
