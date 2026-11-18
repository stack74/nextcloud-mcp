/**
 * Configuration for hosted (HTTP + OAuth) mode.
 *
 * One MCP endpoint for one Nextcloud. Every person who adds the connector signs
 * in with their own Nextcloud login; requests then run with their permissions.
 *
 * How the Nextcloud sign-in works:
 *  - "loginflow" (default, no Nextcloud admin setup): Nextcloud's Login Flow v2
 *    issues an app password per person.
 *  - "oauth": Nextcloud's oauth2 app, when NEXTCLOUD_OAUTH_CLIENT_ID/_SECRET are
 *    set. An admin registers the client once with the redirect URI
 *    <public url>/connect/callback (Administration -> Security -> OAuth 2.0 clients).
 */

import { normalizeBaseUrl } from "../constants.js";
import { DEFAULT_REDIRECT_PATTERNS, RedirectPolicy } from "./redirects.js";

export interface HostedConfig {
  /** The Nextcloud everyone connects to. */
  nextcloudUrl: string;
  /** Public base URL of this server; the MCP endpoint is <publicUrl>/mcp. */
  publicUrl: URL;
  mcpUrl: URL;
  host: string;
  port: number;
  /** Encrypts stored Nextcloud credentials. */
  secret: string;
  dbPath: string;
  connectMode: "loginflow" | "oauth";
  oauth?: { clientId: string; clientSecret: string };
  /** Register upload/create/move/copy/delete tools. */
  writes: boolean;
  /** Only these Nextcloud user IDs may connect (in addition to allowedGroups). */
  allowedUsers: string[];
  /** Only members of these Nextcloud groups may connect. Both lists empty: everyone. */
  allowedGroups: string[];
  /** Redirect URIs MCP clients may register (see redirects.ts). */
  redirects: RedirectPolicy;
  icon?: { path: string; mimeType: string; extension: "svg" | "png" | "ico" };
  /** Lifetime of the access tokens this server issues to MCP clients. */
  accessTokenTtlSeconds: number;
  /** Lifetime of the refresh tokens this server issues to MCP clients. */
  refreshTokenTtlSeconds: number;
}

function fail(message: string): never {
  throw new Error(`Hosted mode configuration: ${message}`);
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const insecureAllowed = /^(1|true)$/i.test(env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL ?? "");

  const rawNextcloud = env.NEXTCLOUD_URL?.trim();
  if (!rawNextcloud) fail("NEXTCLOUD_URL is required, e.g. https://cloud.example.com");
  let nextcloudUrl: string;
  try {
    nextcloudUrl = normalizeBaseUrl(rawNextcloud, { allowInsecure: insecureAllowed || /^(1|true)$/i.test(env.NEXTCLOUD_ALLOW_INSECURE_HTTP ?? "") });
  } catch (error) {
    fail(`NEXTCLOUD_URL: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rawUrl = env.NEXTCLOUD_MCP_PUBLIC_URL?.trim();
  if (!rawUrl) fail("NEXTCLOUD_MCP_PUBLIC_URL is required, e.g. https://nextcloud-mcp.example.com");
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl.replace(/\/+$/, ""));
  } catch {
    fail(`NEXTCLOUD_MCP_PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !localhost && !insecureAllowed) {
    fail(
      "NEXTCLOUD_MCP_PUBLIC_URL must use https (http is only allowed for localhost; for a test in a trusted " +
        "local network set MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true)",
    );
  }

  const secret = env.NEXTCLOUD_MCP_SECRET ?? "";
  if (secret.length < 32) fail("NEXTCLOUD_MCP_SECRET must be at least 32 characters (e.g. `openssl rand -base64 48`)");

  const clientId = env.NEXTCLOUD_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.NEXTCLOUD_OAUTH_CLIENT_SECRET?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    fail("set both NEXTCLOUD_OAUTH_CLIENT_ID and NEXTCLOUD_OAUTH_CLIENT_SECRET, or neither (Login Flow v2 is then used)");
  }

  let icon: HostedConfig["icon"];
  const iconPath = env.NEXTCLOUD_MCP_ICON_PATH?.trim();
  if (iconPath) {
    const extension = /\.(svg|png|ico)$/i.exec(iconPath)?.[1]?.toLowerCase() as "svg" | "png" | "ico" | undefined;
    if (!extension) fail(`NEXTCLOUD_MCP_ICON_PATH must end in .svg, .png or .ico, got ${JSON.stringify(iconPath)}`);
    const mimeType = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" }[extension];
    icon = { path: iconPath, mimeType, extension };
  }

  let redirects: RedirectPolicy;
  // Extra entries extend the built-in list (claude.ai, claude.com, loopback);
  // NEXTCLOUD_MCP_DEFAULT_REDIRECT_URIS=false drops the built-ins.
  const withDefaults = !/^(0|false|no)$/i.test(env.NEXTCLOUD_MCP_DEFAULT_REDIRECT_URIS ?? "");
  const redirectSources = [...(withDefaults ? DEFAULT_REDIRECT_PATTERNS : []), ...list(env.NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS)];
  if (redirectSources.length === 0) {
    fail("no redirect URIs allowed: set NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS when NEXTCLOUD_MCP_DEFAULT_REDIRECT_URIS=false");
  }
  try {
    redirects = new RedirectPolicy(redirectSources);
  } catch (error) {
    fail(`NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    nextcloudUrl,
    publicUrl,
    mcpUrl: new URL(`${publicUrl.href.replace(/\/+$/, "")}/mcp`),
    host: env.HOST?.trim() || "0.0.0.0",
    port: intEnv(env, "PORT", 3000),
    secret,
    dbPath: env.NEXTCLOUD_MCP_DB_PATH?.trim() || "./data/nextcloud-mcp.sqlite",
    connectMode: clientId ? "oauth" : "loginflow",
    ...(clientId && clientSecret ? { oauth: { clientId, clientSecret } } : {}),
    writes: /^(1|true|yes)$/i.test(env.NEXTCLOUD_ENABLE_WRITES ?? ""),
    allowedUsers: list(env.NEXTCLOUD_ALLOWED_USERS),
    allowedGroups: list(env.NEXTCLOUD_ALLOWED_GROUPS),
    redirects,
    ...(icon ? { icon } : {}),
    accessTokenTtlSeconds: intEnv(env, "NEXTCLOUD_MCP_ACCESS_TOKEN_TTL", 3600),
    refreshTokenTtlSeconds: intEnv(env, "NEXTCLOUD_MCP_REFRESH_TOKEN_TTL", 90 * 24 * 3600),
  };
}
