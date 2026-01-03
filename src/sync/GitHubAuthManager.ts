/**
 * GitHub Authentication Manager
 * Handles GitHub OAuth authentication using VS Code Authentication Provider API
 */

import * as vscode from "vscode";
import { SyncConstants, StorageKeys } from "./syncTypes";

export class GitHubAuthManager {
	private static instance: GitHubAuthManager;
	private context: vscode.ExtensionContext;

	private constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	/**
	 * Get singleton instance
	 */
	public static getInstance(context: vscode.ExtensionContext): GitHubAuthManager {
		if (!GitHubAuthManager.instance) {
			GitHubAuthManager.instance = new GitHubAuthManager(context);
		}
		return GitHubAuthManager.instance;
	}

	/**
	 * Connect to GitHub using OAuth
	 * Uses VS Code's built-in GitHub authentication provider
	 */
	public async connect(): Promise<boolean> {
		try {
			// Request GitHub OAuth session with gist scope
			const session = await vscode.authentication.getSession("github", [SyncConstants.githubScope], {
				createIfNone: true,
			});

			if (!session) {
				vscode.window.showErrorMessage("GitHub authentication cancelled.");
				return false;
			}

			// Store the access token securely
			await this.context.secrets.store(StorageKeys.githubToken, session.accessToken);

			// Verify the token by making a test API call
			const isValid = await this.verifyToken(session.accessToken);

			if (!isValid) {
				vscode.window.showErrorMessage("GitHub authentication failed. Please try again.");
				await this.disconnect();
				return false;
			}

			vscode.window.showInformationMessage("GitHub connected successfully.");
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			vscode.window.showErrorMessage(`GitHub authentication failed: ${message}`);
			return false;
		}
	}

	/**
	 * Disconnect from GitHub
	 * Removes stored token and clears authentication state
	 */
	public async disconnect(): Promise<void> {
		try {
			// Remove token from secret storage
			await this.context.secrets.delete(StorageKeys.githubToken);

			vscode.window.showInformationMessage(
				"GitHub disconnected. Your gists remain on GitHub and can be reconnected anytime."
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			vscode.window.showErrorMessage(`Failed to disconnect GitHub: ${message}`);
		}
	}

	/**
	 * Get the stored GitHub access token
	 */
	public async getToken(): Promise<string | undefined> {
		return await this.context.secrets.get(StorageKeys.githubToken);
	}

	/**
	 * Check if user is authenticated
	 */
	public async isAuthenticated(): Promise<boolean> {
		const token = await this.getToken();
		if (!token) {
			return false;
		}

		// Verify token is still valid
		return await this.verifyToken(token);
	}

	/**
	 * Verify token by making a test API call to GitHub
	 */
	private async verifyToken(token: string): Promise<boolean> {
		try {
			const response = await fetch("https://api.github.com/gists", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "VSCode-Todo-Extension",
				},
			});

			return response.ok;
		} catch (error) {
			console.error("Token verification failed:", error);
			return false;
		}
	}

	/**
	 * Ensure user is authenticated, prompt if not
	 */
	public async ensureAuthenticated(): Promise<boolean> {
		const isAuth = await this.isAuthenticated();
		if (isAuth) {
			return true;
		}

		// Prompt user to connect
		const choice = await vscode.window.showWarningMessage(
			"GitHub authentication required. Would you like to connect now?",
			"Connect",
			"Cancel"
		);

		if (choice === "Connect") {
			return await this.connect();
		}

		return false;
	}

	/**
	 * Refresh authentication session
	 * Useful when token expires or becomes invalid
	 */
	public async refreshSession(): Promise<boolean> {
		try {
			// Get existing session without creating new one
			const session = await vscode.authentication.getSession("github", [SyncConstants.githubScope], {
				createIfNone: false,
			});

			if (!session) {
				// No existing session, prompt to connect
				return await this.connect();
			}

			// Update stored token
			await this.context.secrets.store(StorageKeys.githubToken, session.accessToken);

			return true;
		} catch (error) {
			console.error("Failed to refresh GitHub session:", error);
			return false;
		}
	}
}
