/**
 * Framework-agnostic GitHub Gist REST client. Mirrors the extension's GitHubApiClient but
 * takes a token provider instead of a VS Code auth manager, so it runs unchanged in a
 * browser/PWA, a worker, or Node. `api.github.com` supports CORS, so these calls work
 * directly from a browser with a `gist`-scoped token.
 */

import {
	GistResponse,
	GistFileInfo,
	GistSummary,
	GitHubAPI,
	GistDirectories,
	GIST_ID_REGEX,
	SyncResult,
	SyncErrorType,
} from "./syncTypes";

export type TokenProvider = () => string | undefined | Promise<string | undefined>;

export interface GistClientOptions {
	/** Returns the current `gist`-scoped GitHub token, or undefined when disconnected. */
	getToken: TokenProvider;
	/**
	 * Optional User-Agent. Ignored by browsers (forbidden header) but useful in Node/worker
	 * contexts where GitHub requires one.
	 */
	userAgent?: string;
	/** Optional sink for diagnostic logging. */
	logger?: (message: string) => void;
}

const API_HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
} as const;

export class GistClient {
	constructor(private readonly options: GistClientOptions) {}

	private log(message: string): void {
		this.options.logger?.(message);
	}

	private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string> | null> {
		const token = await this.options.getToken();
		if (!token) {
			return null;
		}
		const headers: Record<string, string> = {
			...API_HEADERS,
			Authorization: `Bearer ${token}`,
			...extra,
		};
		if (this.options.userAgent) {
			headers["User-Agent"] = this.options.userAgent;
		}
		return headers;
	}

	private authError<T>(): SyncResult<T> {
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

	public isValidGistId(gistId: string): boolean {
		return GIST_ID_REGEX.test(gistId);
	}

	/** Lists the authenticated user's gists (first 100). */
	public async listGists(): Promise<SyncResult<GistSummary[]>> {
		const headers = await this.authHeaders();
		if (!headers) {
			return this.authError();
		}

		type GistListResponseItem = {
			id: string;
			description?: string | null;
			public: boolean;
			files: Record<string, { filename: string }>;
			updated_at: string;
		};

		try {
			const response = await fetch(`${GitHubAPI.gists}?per_page=100`, { method: "GET", headers });
			if (!response.ok) {
				return this.handleErrorResponse(response);
			}
			const gists: GistListResponseItem[] = await response.json();
			const summaries: GistSummary[] = gists.map((gist) => ({
				id: gist.id,
				description: gist.description?.trim() ?? "",
				isPublic: gist.public,
				filesCount: Object.keys(gist.files ?? {}).length,
				updatedAt: gist.updated_at,
			}));
			return { success: true, data: summaries };
		} catch (error) {
			return this.networkError(error, "Failed to list gists");
		}
	}

	/**
	 * Finds the sync gist by its description (the extension stamps every sync gist with the
	 * same description). Returns the most recently updated match, or undefined if none.
	 */
	public async findGistByDescription(description: string): Promise<SyncResult<GistSummary | undefined>> {
		const result = await this.listGists();
		if (!result.success || !result.data) {
			return { success: false, error: result.error };
		}
		const matches = result.data
			.filter((g) => g.description === description)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return { success: true, data: matches[0] };
	}

	/** Creates a new (secret by default) gist with the given files. */
	public async createGist(
		description: string,
		files: Record<string, string>,
		isPublic = false
	): Promise<SyncResult<GistResponse>> {
		const headers = await this.authHeaders({ "Content-Type": "application/json" });
		if (!headers) {
			return this.authError();
		}

		const entries = Object.entries(files);
		if (entries.length === 0) {
			return this.validationError("At least one file is required to create a gist.");
		}

		const payloadFiles: Record<string, { content: string }> = {};
		for (const [fileName, content] of entries) {
			if (!content?.trim()) {
				return this.validationError(`File content cannot be empty for '${fileName}'.`);
			}
			payloadFiles[fileName] = { content };
		}

		try {
			const response = await fetch(GitHubAPI.gists, {
				method: "POST",
				headers,
				body: JSON.stringify({ description, public: isPublic, files: payloadFiles }),
			});
			if (!response.ok) {
				return this.handleErrorResponse(response);
			}
			const gist: GistResponse = await response.json();
			return { success: true, data: gist };
		} catch (error) {
			return this.networkError(error, "Failed to create gist");
		}
	}

	/** Fetches gist metadata and files. */
	public async fetchGist(gistId: string): Promise<SyncResult<GistResponse>> {
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
		const headers = await this.authHeaders();
		if (!headers) {
			return this.authError();
		}
		try {
			const response = await fetch(GitHubAPI.gist(gistId), { method: "GET", headers });
			if (!response.ok) {
				return this.handleErrorResponse(response);
			}
			const gist: GistResponse = await response.json();
			return { success: true, data: gist };
		} catch (error) {
			return this.networkError(error, "Network error occurred");
		}
	}

	/**
	 * Reads a single file's content. Falls back to `raw_url` when GitHub truncates the inline
	 * content (files larger than ~1MB), matching the extension's behavior.
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

		if (file.content !== undefined && !file.truncated) {
			return { success: true, data: file.content };
		}

		try {
			const response = await fetch(file.raw_url);
			if (!response.ok) {
				return this.handleErrorResponse(response);
			}
			const content = await response.text();
			return { success: true, data: content };
		} catch (error) {
			return this.networkError(error, "Failed to fetch file content");
		}
	}

	/** Writes a single file (PATCH updates the whole gist but only the named file changes). */
	public async writeFile(gistId: string, fileName: string, content: string): Promise<SyncResult<GistResponse>> {
		const headers = await this.authHeaders({ "Content-Type": "application/json" });
		if (!headers) {
			return this.authError();
		}
		if (!content || content.trim().length === 0) {
			return this.validationError("File content cannot be empty. GitHub requires at least 1 byte of content.");
		}
		try {
			const response = await fetch(GitHubAPI.gist(gistId), {
				method: "PATCH",
				headers,
				body: JSON.stringify({ files: { [fileName]: { content } } }),
			});
			if (!response.ok) {
				return this.handleErrorResponse(response);
			}
			const gist: GistResponse = await response.json();
			return { success: true, data: gist };
		} catch (error) {
			return this.networkError(error, "Failed to write file");
		}
	}

	/** Lists files in the gist filtered by the `user-`/`workspace-` prefix. */
	public async listFiles(gistId: string, directory: "user" | "workspace"): Promise<SyncResult<GistFileInfo[]>> {
		const gistResult = await this.fetchGist(gistId);
		if (!gistResult.success || !gistResult.data) {
			return { success: false, error: gistResult.error };
		}

		const prefix = directory === "user" ? GistDirectories.user : GistDirectories.workspace;
		const files: GistFileInfo[] = [];
		for (const [fileName, fileData] of Object.entries(gistResult.data.files)) {
			if (fileName.startsWith(prefix) && fileName.endsWith(".json")) {
				files.push({
					displayName: fileName.substring(prefix.length, fileName.length - 5),
					fullPath: fileName,
					size: fileData.size,
				});
			}
		}
		return { success: true, data: files };
	}

	public getGistUrl(gistId: string): string {
		return `https://gist.github.com/${gistId}`;
	}

	private validationError<T>(message: string): SyncResult<T> {
		return {
			success: false,
			error: { type: SyncErrorType.ValidationError, message, timestamp: new Date().toISOString(), retryable: false },
		};
	}

	private networkError<T>(error: unknown, fallback: string): SyncResult<T> {
		return {
			success: false,
			error: {
				type: SyncErrorType.NetworkError,
				message: error instanceof Error ? error.message : fallback,
				error: error instanceof Error ? error : undefined,
				timestamp: new Date().toISOString(),
				retryable: true,
			},
		};
	}

	private async handleErrorResponse(response: Response): Promise<SyncResult<never>> {
		const statusCode = response.status;
		let errorMessage = `HTTP ${statusCode}: ${response.statusText}`;

		try {
			const errorData = await response.json();
			if (errorData.message) {
				errorMessage = errorData.message;
			}
			if (errorData.errors && Array.isArray(errorData.errors)) {
				const errorsList = errorData.errors
					.map((e: { message?: string; code?: string }) => e.message || e.code || JSON.stringify(e))
					.join(", ");
				errorMessage += ` - Details: ${errorsList}`;
			}
			this.log(`[GistClient] GitHub API Error: status=${statusCode}, message=${errorMessage}`);
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
			error: { type: errorType, message: errorMessage, timestamp: new Date().toISOString(), retryable },
		};
	}
}
