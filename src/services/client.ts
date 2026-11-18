/**
 * HTTP client for one Nextcloud user.
 *
 * Nextcloud exposes files over WebDAV (/remote.php/dav) and everything else over
 * the OCS API (/ocs/v2.php). Both accept the same credentials:
 *  - an app password from Login Flow v2, sent as HTTP Basic, or
 *  - an OAuth2 access token from Nextcloud's oauth2 app, sent as Bearer.
 *
 * Responsibilities:
 *  - credentials per request, with one forced refresh after a 401 (OAuth)
 *  - retries with backoff for idempotent reads on 429 / 502-504 / network blips
 *  - mapping failures onto messages that tell the model what to do next
 *
 * No retries after 401: Nextcloud's brute-force protection slows down an IP that
 * keeps sending bad credentials, for every user behind that IP.
 */

import { MAX_RETRIES, TIMEOUT_MS, TRANSFER_TIMEOUT_MS, USER_AGENT } from "../constants.js";
import { encodePath } from "./paths.js";

export interface Credentials {
  /** Complete Authorization header value ("Basic …" or "Bearer …"). */
  authorization: string;
  /** Nextcloud user ID, when already known. Login names (e.g. an e-mail) can differ from it. */
  userId?: string;
}

/**
 * Supplies credentials for each request. `forceRefresh` is set after Nextcloud
 * answered 401, so an OAuth source can refresh an access token that expired early.
 */
export type CredentialSource = (options: { forceRefresh: boolean }) => Promise<Credentials>;

export class NextcloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Nextcloud answered ${status} to ${method} ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "NextcloudApiError";
  }
}

/** Thrown when the user has to (re)connect their Nextcloud account first. */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Default: retry only GET, HEAD, PROPFIND, SEARCH, REPORT. */
  retry?: boolean;
  /** Use the long transfer timeout. */
  transfer?: boolean;
  /** Statuses that are returned instead of thrown (e.g. 404 for "does it exist?"). */
  allowStatus?: number[];
}

const IDEMPOTENT = new Set(["GET", "HEAD", "PROPFIND", "SEARCH", "REPORT", "OPTIONS"]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls a readable message out of a WebDAV or OCS error body. */
function extractDetail(raw: string): string {
  if (!raw) return "";
  const davMessage = /<(?:\w+:)?message[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/i.exec(raw);
  if (davMessage?.[1]?.trim()) return davMessage[1].trim().slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { ocs?: { meta?: { message?: unknown } }; message?: unknown; error?: unknown };
    const message = parsed.ocs?.meta?.message ?? parsed.message ?? parsed.error;
    if (typeof message === "string" && message) return message.slice(0, 500);
  } catch {
    // not JSON
  }
  // HTML error pages carry no useful detail.
  if (/^\s*</.test(raw)) return "";
  return raw.slice(0, 300);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  return Number.isNaN(seconds) ? undefined : Math.min(seconds, 60);
}

export class NextcloudClient {
  private readonly credentials: CredentialSource;
  private readonly canRefresh: boolean;
  private userIdPromise?: Promise<string>;
  /** Path part of the base URL, "" or e.g. "/nextcloud". */
  readonly basePath: string;

  constructor(
    readonly baseUrl: string,
    credentials: CredentialSource,
    options: { canRefresh?: boolean } = {},
  ) {
    this.credentials = credentials;
    this.canRefresh = options.canRefresh ?? false;
    this.basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  }

  /** The Nextcloud user ID (needed for WebDAV paths). Looked up once if the credentials do not carry it. */
  userId(): Promise<string> {
    if (!this.userIdPromise) {
      this.userIdPromise = (async () => {
        const creds = await this.credentials({ forceRefresh: false });
        if (creds.userId) return creds.userId;
        const user = await this.ocs<{ id?: unknown }>("/cloud/user");
        if (typeof user?.id !== "string" || !user.id) throw new Error("Nextcloud did not return the user ID.");
        return user.id;
      })();
      // Do not cache a failure.
      this.userIdPromise.catch(() => {
        this.userIdPromise = undefined;
      });
    }
    return this.userIdPromise;
  }

  /** WebDAV URL path of a file or folder, relative to the base URL. */
  async filesPath(path: string): Promise<string> {
    const user = await this.userId();
    const encoded = encodePath(path);
    return `/remote.php/dav/files/${encodeURIComponent(user)}${encoded ? `/${encoded}` : ""}`;
  }

  /** Absolute WebDAV URL of a file or folder (for Destination headers). */
  async filesUrl(path: string): Promise<string> {
    return `${this.baseUrl}${await this.filesPath(path)}`;
  }

  /** Calls the OCS API and returns `ocs.data`. `path` is relative to /ocs/v2.php. */
  async ocs<T>(path: string, options: { method?: string; query?: Record<string, string | number | undefined>; form?: Record<string, string> } = {}): Promise<T> {
    const params = new URLSearchParams({ format: "json" });
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") params.append(key, String(value));
    }
    const headers: Record<string, string> = { "OCS-APIRequest": "true", Accept: "application/json" };
    let body: string | undefined;
    if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const response = await this.send(`/ocs/v2.php${path}?${params}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const json = (await response.json()) as { ocs?: { data?: T } };
    return json.ocs?.data as T;
  }

  /**
   * Sends a request to `${baseUrl}${path}` with credentials. Returns the response
   * when it is ok (or its status is in `allowStatus`); throws NextcloudApiError otherwise.
   */
  async send(path: string, options: SendOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const retry = options.retry ?? IDEMPOTENT.has(method);
    const url = `${this.baseUrl}${path}`;
    const label = path.split("?")[0]!;

    let lastError: unknown;
    let refreshed = false;
    const attempts = retry ? MAX_RETRIES : 0;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      const creds = await this.credentials({ forceRefresh: refreshed });
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: creds.authorization,
            "User-Agent": USER_AGENT,
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: options.body }),
          redirect: "manual",
          signal: AbortSignal.timeout(options.transfer ? TRANSFER_TIMEOUT_MS : TIMEOUT_MS),
        });

        if (response.ok || options.allowStatus?.includes(response.status)) return response;

        if (response.status === 401 && this.canRefresh && !refreshed) {
          refreshed = true;
          await response.body?.cancel();
          attempt--; // the refresh retry does not count
          continue;
        }

        const transient = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
        if (transient && attempt < attempts) {
          const wait = parseRetryAfter(response.headers.get("retry-after"));
          await response.body?.cancel();
          await sleep(wait !== undefined ? wait * 1000 : 2 ** attempt * 1000);
          continue;
        }

        if (response.status === 401) {
          await response.body?.cancel();
          throw new AuthRequiredError(
            "Nextcloud rejected the credentials (401). The app password or login was revoked, or the session expired.",
          );
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new NextcloudApiError(
            response.status,
            method,
            label,
            `redirected to ${response.headers.get("location") ?? "?"} — check that the Nextcloud URL is the canonical one (https, no /index.php)`,
          );
        }
        throw new NextcloudApiError(response.status, method, label, extractDetail(await response.text()));
      } catch (error) {
        if (error instanceof NextcloudApiError || error instanceof AuthRequiredError) throw error;
        lastError = error;
        if (attempt < attempts) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
      }
    }

    if (lastError instanceof Error && lastError.name === "TimeoutError") {
      throw new Error(`${method} ${label} timed out. Retry, or narrow the request (smaller folder, fewer results).`);
    }
    const reason = lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError);
    throw new Error(`Cannot reach Nextcloud at ${this.baseUrl}: ${reason}`);
  }
}

/** Turns any thrown error into a message that tells the model what to do next. */
export function formatError(error: unknown): string {
  if (error instanceof AuthRequiredError) return `Error: ${error.message}`;
  if (error instanceof NextcloudApiError) {
    const { status, method, path, detail } = error;
    const suffix = detail ? ` Nextcloud says: ${detail}` : "";
    switch (status) {
      case 400:
        return `Error: Nextcloud rejected the request as invalid (400, ${method}).${suffix}`;
      case 403:
        return `Error: permission denied (403, ${method}). The user may lack write or delete permission on this item (e.g. a read-only share), or the name is not allowed.${suffix}`;
      case 404:
        return `Error: not found (404). Check the path — list the parent folder with nextcloud_list_files or use nextcloud_search_files.${suffix}`;
      case 405:
        return `Error: not allowed (405, ${method}). This usually means the target already exists (e.g. creating a folder that exists).${suffix}`;
      case 409:
        return `Error: conflict (409, ${method}). The parent folder does not exist.${suffix}`;
      case 412:
        return `Error: the target already exists (412). Pass overwrite=true to replace it, or choose another name.${suffix}`;
      case 413:
        return `Error: the file is too large for the Nextcloud server or the proxy in front of it (413).${suffix}`;
      case 423:
        return `Error: the file is locked (423), probably open in an editor. Try again later.${suffix}`;
      case 429:
        return `Error: Nextcloud is rate-limiting requests (429). Wait a minute before retrying.${suffix}`;
      case 507:
        return `Error: the user's storage quota is exhausted (507).${suffix}`;
      default:
        if (status >= 500) return `Error: Nextcloud server error (${status}) on ${method} ${path}. Retry shortly.${suffix}`;
        return `Error: Nextcloud answered ${status} to ${method} ${path}.${suffix}`;
    }
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: unexpected failure: ${String(error)}`;
}
