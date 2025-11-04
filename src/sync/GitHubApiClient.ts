/**
 * GitHub API Client
 * Handles all GitHub Gist API operations
 */

import * as vscode from "vscode";
import {
	GistResponse,
	GistFileInfo,
	GitHubAPI,
	SyncResult,
	SyncErrorType,
	GistDirectories,
	GIST_ID_REGEX,
} from "./syncTypes";
import LogChannel from "../utilities/LogChannel";
import { GitHubAuthManager } from "./GitHubAuthManager";

export class GitHubApiClient {
	private authManager: GitHubAuthManager;

	constructor(context: vscode.ExtensionContext) {
		this.authManager = GitHubAuthManager.getInstance(context);
	}

	/**
	 * Fetch gist metadata and all files
	 */
	public async fetchGist(gistId: string): Promise<SyncResult<GistResponse>> {
		// Validate gist ID format
		if (!this.isValidGistId(gistId)) {
			return {
				success: false,
				error: {
					type: SyncErrorType.InvalidGistIdError,
					message: "Invalid gist ID format. Must be 32-character hex string.",
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		const token = await this.authManager.getToken();
		if (!token) {
			return {
				success: false,
				error: {
					type: SyncErrorType.AuthError,
					message: "Not authenticated. Please connect GitHub first.",
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		}

		try {
			const response = await fetch(GitHubAPI.gist(gistId), {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "VSCode-Todo-Extension",
				},
			});

			if (!response.ok) {
				return this.handleErrorResponse(response);
			}

			const gist: GistResponse = await response.json();
			return { success: true, data: gist };
		} catch (error) {
			return {
				success: false,
				error: {
					type: SyncErrorType.NetworkError,
					message: error instanceof Error ? error.message : "Network error occurred",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		}
	}

	/**
	 * Read specific file content from gist
	 */
	public async readFile(gistId: string, fileName: string): Promise<SyncResult<string>> {
		const gistResult = await this.fetchGist(gistId);

		if (!gistResult.success || !gistResult.data) {
			return { success: false, error: gistResult.error };
		}

		const file = gistResult.data.files[fileName];
		if (!file) {
			return {
				success: false,
				error: {
					type: SyncErrorType.FileNotFoundError,
					message: `File '${fileName}' not found in gist`,
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		// If content is not included in response, fetch from raw_url
		if (file.content !== undefined) {
			return { success: true, data: file.content };
		}

		// Fetch from raw URL
		try {
			const response = await fetch(file.raw_url);
			if (!response.ok) {
				return this.handleErrorResponse(response);
			}
			const content = await response.text();
			return { success: true, data: content };
		} catch (error) {
			return {
				success: false,
				error: {
					type: SyncErrorType.NetworkError,
					message: error instanceof Error ? error.message : "Failed to fetch file content",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		}
	}

	/**
	 * Write file to gist (updates entire gist)
	 */
	public async writeFile(gistId: string, fileName: string, content: string): Promise<SyncResult<GistResponse>> {
		const token = await this.authManager.getToken();
		if (!token) {
			return {
				success: false,
				error: {
					type: SyncErrorType.AuthError,
					message: "Not authenticated. Please connect GitHub first.",
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		}

		// Validate content is not empty
		if (!content || content.trim().length === 0) {
			return {
				success: false,
				error: {
					type: SyncErrorType.ValidationError,
					message: "File content cannot be empty. GitHub requires at least 1 byte of content.",
					timestamp: new Date().toISOString(),
					retryable: false,
				},
			};
		}

		try {
			const response = await fetch(GitHubAPI.gist(gistId), {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
					"User-Agent": "VSCode-Todo-Extension",
				},
				body: JSON.stringify({
					files: {
						[fileName]: {
							content,
						},
					},
				}),
			});

			if (!response.ok) {
				return this.handleErrorResponse(response);
			}

			const gist: GistResponse = await response.json();
			return { success: true, data: gist };
		} catch (error) {
			return {
				success: false,
				error: {
					type: SyncErrorType.NetworkError,
					message: error instanceof Error ? error.message : "Failed to write file",
					error: error instanceof Error ? error : undefined,
					timestamp: new Date().toISOString(),
					retryable: true,
				},
			};
		}
	}

	/**
	 * List all files in gist filtered by directory
	 */
	public async listFiles(gistId: string, directory: "user" | "workspace"): Promise<SyncResult<GistFileInfo[]>> {
		const gistResult = await this.fetchGist(gistId);

		if (!gistResult.success || !gistResult.data) {
			return { success: false, error: gistResult.error };
		}

		const prefix = directory === "user" ? GistDirectories.user : GistDirectories.workspace;
		const files: GistFileInfo[] = [];

		for (const [fileName, fileData] of Object.entries(gistResult.data.files)) {
			if (fileName.startsWith(prefix) && fileName.endsWith(".json")) {
				// Extract display name (remove directory prefix and .json extension)
				const displayName = fileName.substring(prefix.length, fileName.length - 5);
				files.push({
					displayName,
					fullPath: fileName,
					size: fileData.size,
				});
			}
		}

		return { success: true, data: files };
	}

	/**
	 * Verify gist exists and is accessible
	 */
	public async verifyGist(gistId: string): Promise<SyncResult<boolean>> {
		const result = await this.fetchGist(gistId);
		if (!result.success) {
			return { success: false, error: result.error };
		}
		return { success: true, data: true };
	}

	/**
	 * Validate gist ID format
	 */
	public isValidGistId(gistId: string): boolean {
		return GIST_ID_REGEX.test(gistId);
	}

	/**
	 * Handle HTTP error responses
	 */
	private async handleErrorResponse(response: Response): Promise<SyncResult<never>> {
		const statusCode = response.status;
		let errorMessage = `HTTP ${statusCode}: ${response.statusText}`;
		let errorDetails: any = null;

		try {
			const errorData = await response.json();
			errorDetails = errorData;
			if (errorData.message) {
				errorMessage = errorData.message;
			}
			// GitHub often provides more details in the errors array
			if (errorData.errors && Array.isArray(errorData.errors)) {
				const errorsList = errorData.errors.map((e: any) => e.message || e.code || JSON.stringify(e)).join(", ");
				errorMessage += ` - Details: ${errorsList}`;
			}
			// Log for debugging (useful for future issues)
			LogChannel.log(`[GitHubApiClient] GitHub API Error: status=${statusCode}, message=${errorMessage}, details=${JSON.stringify(errorData.errors || {})}`);
		} catch {
			// Ignore JSON parse errors
		}

		let errorType: SyncErrorType;
		let retryable = true;

		switch (statusCode) {
			case 401:
			case 403:
				errorType = SyncErrorType.AuthError;
				retryable = true;
				break;
			case 404:
				errorType = SyncErrorType.NotFoundError;
				retryable = false;
				break;
			case 422:
				errorType = SyncErrorType.ValidationError;
				retryable = false;
				break;
			case 429:
				errorType = SyncErrorType.RateLimitError;
				retryable = true;
				break;
			default:
				errorType = SyncErrorType.UnknownError;
				retryable = true;
		}

		return {
			success: false,
			error: {
				type: errorType,
				message: errorMessage,
				timestamp: new Date().toISOString(),
				retryable,
			},
		};
	}

	/**
	 * Get gist URL for browser viewing
	 */
	public getGistUrl(gistId: string): string {
		return `https://gist.github.com/${gistId}`;
	}
}
