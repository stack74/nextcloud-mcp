/** Shared constants and runtime configuration for the Nextcloud MCP server. */

import { createRequire } from "node:module";

export const SERVER_NAME = "nextcloud-mcp";

/**
 * Read from package.json rather than duplicated here, so `--version`, the MCP
 * serverInfo and the published package can never disagree.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    // dist/constants.js -> ../package.json
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Shown in Nextcloud under Settings -> Security -> Devices & sessions for the
 * app password Login Flow creates, so people recognise (and can revoke) it.
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (Claude MCP)`;

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

/** Maximum characters in a single tool response before it gets truncated. */
export const CHARACTER_LIMIT = intFromEnv("NEXTCLOUD_CHARACTER_LIMIT", 25_000, 1_000);

/** HTTP request timeout for API calls (not for file transfers, see TRANSFER_TIMEOUT_MS). */
export const TIMEOUT_MS = intFromEnv("NEXTCLOUD_TIMEOUT_MS", 30_000, 1_000);

/** Timeout for uploads and downloads, which may move large files. */
export const TRANSFER_TIMEOUT_MS = intFromEnv("NEXTCLOUD_TRANSFER_TIMEOUT_MS", 10 * 60_000, 10_000);

/** Retries for idempotent reads on 429 / 502-504 / network failures. */
export const MAX_RETRIES = intFromEnv("NEXTCLOUD_MAX_RETRIES", 2, 0);

/** Create/upload/move/delete tools are only registered when this is explicitly enabled. */
export const WRITES_ENABLED = /^(1|true|yes)$/i.test(process.env.NEXTCLOUD_ENABLE_WRITES ?? "");

const MB = 1024 * 1024;

/** Largest file `nextcloud_read_file` downloads to show its content. */
export const MAX_READ_BYTES = intFromEnv("NEXTCLOUD_MAX_READ_MB", 10, 1) * MB;

/** Largest file returned inside a tool result (hosted downloads, images). */
export const MAX_INLINE_BYTES = intFromEnv("NEXTCLOUD_MAX_INLINE_MB", 10, 1) * MB;

/**
 * Largest upload. Hosted uploads arrive base64-encoded inside the JSON-RPC body,
 * so they are additionally capped by the HTTP body limit.
 */
export const MAX_UPLOAD_BYTES = intFromEnv("NEXTCLOUD_MAX_UPLOAD_MB", 100, 1) * MB;

/** Hosted mode: the JSON body limit, which bounds base64 uploads (~3/4 of it). */
export const HOSTED_BODY_LIMIT_BYTES = 30 * MB;

/**
 * Validates and normalises a Nextcloud base URL: https (or http for localhost),
 * no query or fragment, no trailing slash, no trailing /index.php.
 * Subdirectory installs (https://example.com/nextcloud) keep their path.
 */
export function normalizeBaseUrl(raw: string, options: { allowInsecure?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a valid URL: ${JSON.stringify(raw)}. Expected e.g. https://cloud.example.com`);
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (localhost || options.allowInsecure))) {
    throw new Error(`The Nextcloud URL must use https: ${url.href}`);
  }
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/index\.php$/, "");
  return `${url.origin}${pathname}`;
}

/** Escape hatch for tests and LAN setups: allow a plain-http Nextcloud URL. */
export const ALLOW_INSECURE_HTTP = /^(1|true)$/i.test(process.env.NEXTCLOUD_ALLOW_INSECURE_HTTP ?? "");
