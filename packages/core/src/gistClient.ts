/**
 * Framework-agnostic GitHub Gist REST client. Mirrors the extension's GitHubApiClient but
 * takes a token provider instead of a VS Code auth manager. `api.github.com` supports CORS, so
 * these calls work directly from a browser with a `gist`-scoped token — which is what the PWA,
 * its only consumer today, does. Node hosts it unchanged; see {@link NO_HTTP_CACHE} before
 * hosting it in a worker runtime.
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

/**
 * Every READ goes out with this. Not optional, and not a micro-optimisation in reverse.
 *
 * `api.github.com` answers a gist GET with `Cache-Control: private, max-age=60`, so a browser's
 * HTTP cache satisfies the next 60 seconds of identical GETs *without touching the network*.
 *
 * The bug was one-sided because the HTTP client is the one piece of gist sync that is NOT shared:
 * the engine, the merge and the equality are, but each host brings its own `GistFileIO`. This one
 * is the PWA's, and the PWA is the only thing that constructs it. The extension's is
 * `src/sync/GitHubApiClient.ts`, which is `vscode`-bound and runs in the extension host — Node,
 * no HTTP cache — so it read fresh throughout and raised the conflict correctly while this client
 * silently lost the same edit.
 *
 * What it costs when it bites: a reconcile reads a gist the other peer has already updated, gets
 * its own 60-second-old copy back, and computes `remote === base`. That is not "both sides
 * changed" — it is "only local changed", which takes the straight push path: no merge, no
 * conflict, no prompt. `pushVerified`'s re-read, the guard that exists precisely to catch a peer
 * writing inside the read-write window, hits the same cache entry and agrees nothing moved. The
 * PATCH then overwrites the other peer's edit and `saveCache` records the overwrite as the clean
 * baseline, so the lost edit is never pulled back — which is how a conflict the extension raises
 * correctly becomes a silent overwrite in the PWA.
 *
 * `no-cache` rather than `no-store`: it forces revalidation on every read but still sends the
 * ETag, and GitHub's 304s do not count against the rate limit — so polling stays cheap while the
 * answer is always current. A 304 can only come back when the ETag still matches, so the body the
 * browser replays is current by definition.
 *
 * Node ignores the field, which is all the hosting this client has today. A worker runtime is the
 * one to check before adding: workerd *validates* `cache` rather than ignoring it and rejects
 * values it has not implemented, so an old compatibility date would turn every read into a
 * `TypeError` that `networkError` reports as a plain retryable network failure.
 */
const NO_HTTP_CACHE: Pick<RequestInit, "cache"> = { cache: "no-cache" };

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
			const response = await fetch(`${GitHubAPI.gists}?per_page=100`, {
				method: "GET",
				headers,
				...NO_HTTP_CACHE,
			});
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
			const response = await fetch(GitHubAPI.gist(gistId), {
				method: "GET",
				headers,
				...NO_HTTP_CACHE,
			});
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
			const response = await fetch(file.raw_url, { ...NO_HTTP_CACHE });
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
