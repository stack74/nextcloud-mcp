#!/usr/bin/env node
/**
 * MCP server for Nextcloud files.
 *
 * Transports:
 *   stdio (default, local) — one Nextcloud user. Only NEXTCLOUD_URL is required:
 *     the first tool call hands out a login link (Login Flow v2) and the app
 *     password is saved locally. Never log to stdout — it carries the protocol.
 *   --http (hosted)        — Streamable HTTP + OAuth for remote connectors such as
 *     claude.ai; every person signs in with their own Nextcloud login. See src/hosted/.
 */

import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALLOW_INSECURE_HTTP, SERVER_NAME, SERVER_VERSION, WRITES_ENABLED, normalizeBaseUrl } from "./constants.js";
import { NextcloudClient, formatError } from "./services/client.js";
import { basicAuth, revokeCredentials, startLoginFlow } from "./services/loginflow.js";
import { LocalAuth, completeLogin, credentialsFilePath, forgetLogin, loadLogin, waitForLogin } from "./services/local-auth.js";
import { createNextcloudServer } from "./server.js";

const entry = process.argv[1] ?? "dist/index.js";

const USAGE = `${SERVER_NAME} v${SERVER_VERSION}

An MCP server for Nextcloud files: list, search, read (incl. PDF and Office), preview,
download, and — when enabled — upload, create, move, copy and delete.
Speaks the Model Context Protocol over stdio; run it from an MCP client.

Required environment:
  NEXTCLOUD_URL                   Your Nextcloud, e.g. https://cloud.example.com

Sign-in (pick one):
  - Nothing else: the first tool call returns a login link. Log in with your normal
    Nextcloud login (incl. 2FA); an app password is created and saved to
    ${credentialsFilePath()}
  - ${SERVER_NAME} login <url>    Same, up front, in a terminal (opens the browser).
  - NEXTCLOUD_USER + NEXTCLOUD_APP_PASSWORD
                                  An app password you created yourself
                                  (Settings -> Security -> Devices & sessions).

Optional environment:
  NEXTCLOUD_ENABLE_WRITES=true    Enable upload/create/move/copy/delete tools. Default: read-only.
  NEXTCLOUD_MAX_READ_MB           Largest file read_file / content search will open (default 10).
  NEXTCLOUD_MAX_UPLOAD_MB         Largest upload (default 100).
  NEXTCLOUD_CHARACTER_LIMIT       Max characters per tool response (default 25000).
  NEXTCLOUD_TIMEOUT_MS            API timeout in ms (default 30000).

Commands and flags:
  login [url]       Log in via the browser and save an app password for this computer.
  logout [url]      Revoke the saved app password in Nextcloud and delete it locally.
  --selftest        Make a few read-only calls and report what came back.
  --http            Run as a hosted server (Streamable HTTP + OAuth) for claude.ai and
                    other remote clients. See the README, section "Hosted mode".
  --help, -h        Show this help.
  --version, -v     Print the version.

Register with Claude Code:
  claude mcp add nextcloud --env NEXTCLOUD_URL=https://cloud.example.com -- node ${entry}
`;

function baseUrlFrom(arg: string | undefined): string {
  const raw = arg?.trim() || process.env.NEXTCLOUD_URL?.trim();
  if (!raw) {
    console.error("ERROR: NEXTCLOUD_URL is required, e.g. https://cloud.example.com\nRun with --help for all options.");
    process.exit(1);
  }
  try {
    return normalizeBaseUrl(raw, { allowInsecure: ALLOW_INSECURE_HTTP });
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // the URL is printed anyway
  }
}

/** `login`: interactive, prints to stdout (never inside an MCP session). */
async function login(baseUrl: string): Promise<number> {
  const log = (line: string): void => void process.stdout.write(`${line}\n`);
  const flow = await startLoginFlow(baseUrl);
  log(`Log in to ${baseUrl} and grant access in your browser:\n\n  ${flow.loginUrl}\n`);
  if (!process.argv.includes("--no-browser")) openBrowser(flow.loginUrl);
  log("Waiting for the login (up to 20 minutes)…");
  const { loginName, appPassword } = await waitForLogin(baseUrl, flow.pollToken);
  const saved = await completeLogin(baseUrl, loginName, appPassword);
  log(`\nLogged in as ${saved.displayName ?? saved.userId} (${saved.userId}).`);
  log(`App password saved to ${credentialsFilePath()}.`);
  log(`It appears in Nextcloud under Settings -> Security -> Devices & sessions and can be revoked there.`);
  return 0;
}

async function logout(baseUrl: string): Promise<number> {
  const saved = loadLogin(baseUrl);
  if (!saved) {
    process.stdout.write(`No saved login for ${baseUrl}.\n`);
    return 0;
  }
  const revoked = await revokeCredentials(baseUrl, basicAuth(saved.loginName, saved.appPassword));
  forgetLogin(baseUrl);
  process.stdout.write(
    `${revoked ? "Revoked the app password in Nextcloud and deleted" : "Deleted"} the saved login for ${baseUrl}.` +
      `${revoked ? "" : " Nextcloud did not confirm the revocation — check Settings -> Security -> Devices & sessions."}\n`,
  );
  return 0;
}

async function selftest(client: NextcloudClient): Promise<number> {
  const log = (line: string): void => void process.stdout.write(`${line}\n`);
  log(`${SERVER_NAME} v${SERVER_VERSION} self-test against ${client.baseUrl}`);
  let failures = 0;
  const probe = async (label: string, fn: () => Promise<string>): Promise<void> => {
    try {
      log(`  OK    ${label}: ${await fn()}`);
    } catch (error) {
      failures++;
      log(`  FAIL  ${label}: ${formatError(error)}`);
    }
  };
  await probe("User", async () => {
    const user = await client.ocs<{ id: string; displayname?: string }>("/cloud/user");
    return `${user.displayname ?? user.id} (${user.id})`;
  });
  if (failures > 0) return 1; // no point going on without a login
  const { propfind, search } = await import("./services/webdav.js");
  await probe("List /", async () => `${(await propfind(client, "", 1)).length - 1} entries`);
  await probe("Search (recent files)", async () => {
    const results = await search(client, {
      scope: "",
      conditions: [{ op: "not", condition: { op: "eq", prop: "d:getcontenttype", value: "httpd/unix-directory" } }],
      orderBy: [{ prop: "d:getlastmodified", descending: true }],
      limit: 3,
      offset: 0,
    });
    return results.map((r) => `/${r.path}`).join(", ") || "(no files)";
  });
  log(failures === 0 ? "\nAll probes passed." : `\n${failures} probe(s) failed.`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (argv.includes("--http") || process.env.NEXTCLOUD_MCP_TRANSPORT === "http") {
    // Loaded lazily so stdio installs never touch express or node:sqlite.
    const { startHttpServer } = await import("./hosted/http.js");
    await startHttpServer();
    return;
  }
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional[0] === "login") {
    process.exitCode = await login(baseUrlFrom(positional[1]));
    return;
  }
  if (positional[0] === "logout") {
    process.exitCode = await logout(baseUrlFrom(positional[1]));
    return;
  }

  const baseUrl = baseUrlFrom(undefined);
  const auth = new LocalAuth(baseUrl);
  // Saved app passwords can be replaced by logging in again; env credentials cannot.
  const client = new NextcloudClient(baseUrl, auth.source, { canRefresh: !auth.fromEnvironment });

  if (argv.includes("--selftest")) {
    process.exitCode = await selftest(client);
    return;
  }

  const { server, context } = createNextcloudServer(client);
  await server.connect(new StdioServerTransport());
  const signedIn = auth.fromEnvironment ? "app password from environment" : loadLogin(baseUrl) ? "saved login" : "not logged in yet (first tool call returns a login link)";
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} ready on stdio | ${baseUrl} | ${signedIn} | ` +
      `${context.stats.read} read + ${context.stats.write} write tools | writes ${WRITES_ENABLED ? "ENABLED" : "disabled (read-only)"}`,
  );
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
