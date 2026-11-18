/**
 * Credentials for local (stdio) mode.
 *
 * In order of precedence:
 *  1. NEXTCLOUD_USER + NEXTCLOUD_APP_PASSWORD from the environment.
 *  2. An app password saved by an earlier login, in
 *     ~/.config/nextcloud-mcp/credentials.json (mode 0600), keyed by server URL.
 *  3. None: the first tool call starts Login Flow v2 and returns the login link;
 *     the server polls in the background and saves the app password once the
 *     person has logged in. `nextcloud-mcp login <url>` does the same up front.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AuthRequiredError, type CredentialSource, type Credentials } from "./client.js";
import { LOGIN_FLOW_TTL_SECONDS, basicAuth, fetchUser, pollLoginFlow, startLoginFlow } from "./loginflow.js";

export interface StoredLogin {
  loginName: string;
  appPassword: string;
  userId: string;
  displayName?: string;
  savedAt: string;
}

interface CredentialsFile {
  servers: Record<string, StoredLogin>;
}

export function credentialsFilePath(): string {
  const explicit = process.env.NEXTCLOUD_CREDENTIALS_FILE?.trim();
  if (explicit) return explicit;
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(base, "nextcloud-mcp", "credentials.json");
}

function readFile(): CredentialsFile {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFilePath(), "utf8")) as Partial<CredentialsFile>;
    return { servers: parsed.servers && typeof parsed.servers === "object" ? parsed.servers : {} };
  } catch {
    return { servers: {} };
  }
}

function writeFile(data: CredentialsFile): void {
  const file = credentialsFilePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function loadLogin(baseUrl: string): StoredLogin | undefined {
  return readFile().servers[baseUrl];
}

export function saveLogin(baseUrl: string, login: StoredLogin): void {
  const data = readFile();
  data.servers[baseUrl] = login;
  writeFile(data);
}

export function forgetLogin(baseUrl: string): boolean {
  const data = readFile();
  if (!(baseUrl in data.servers)) return false;
  delete data.servers[baseUrl];
  writeFile(data);
  return true;
}

/** Turns a finished login flow into a verified, saved login. */
export async function completeLogin(baseUrl: string, loginName: string, appPassword: string): Promise<StoredLogin> {
  const user = await fetchUser(baseUrl, basicAuth(loginName, appPassword));
  const login: StoredLogin = { loginName, appPassword, userId: user.id, displayName: user.displayName, savedAt: new Date().toISOString() };
  saveLogin(baseUrl, login);
  return login;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a login flow until it completes or expires. */
export async function waitForLogin(baseUrl: string, pollToken: string, intervalMs = 2000): Promise<{ loginName: string; appPassword: string }> {
  const deadline = Date.now() + LOGIN_FLOW_TTL_SECONDS * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await pollLoginFlow(baseUrl, pollToken);
      if (result) return result;
    } catch {
      // network blip: keep polling
    }
    await sleep(intervalMs);
  }
  throw new Error("The login link expired (20 minutes) without a login.");
}

/** Credential source for stdio mode. */
export class LocalAuth {
  private flow?: { loginUrl: string; expiresAt: number; done: Promise<StoredLogin> };
  private login?: StoredLogin;

  constructor(private readonly baseUrl: string) {}

  /** Credentials come from the environment, so a 401 cannot be fixed by logging in again. */
  get fromEnvironment(): boolean {
    return Boolean(process.env.NEXTCLOUD_USER?.trim() && process.env.NEXTCLOUD_APP_PASSWORD?.trim());
  }

  readonly source: CredentialSource = async ({ forceRefresh }): Promise<Credentials> => {
    const envUser = process.env.NEXTCLOUD_USER?.trim();
    const envPassword = process.env.NEXTCLOUD_APP_PASSWORD?.trim();
    if (envUser && envPassword) {
      if (forceRefresh) {
        throw new AuthRequiredError(
          "Nextcloud rejected NEXTCLOUD_USER / NEXTCLOUD_APP_PASSWORD (401). Create a new app password in Nextcloud " +
            "(Settings -> Security -> Devices & sessions) and update the MCP server configuration.",
        );
      }
      return { authorization: basicAuth(envUser, envPassword) };
    }

    if (forceRefresh) {
      // The saved app password was revoked: forget it and log in again.
      this.login = undefined;
      forgetLogin(this.baseUrl);
    } else {
      this.login ??= loadLogin(this.baseUrl);
      if (this.login) return { authorization: basicAuth(this.login.loginName, this.login.appPassword), userId: this.login.userId };
    }

    if (!this.flow || this.flow.expiresAt < Date.now()) {
      const started = await startLoginFlow(this.baseUrl);
      const done = waitForLogin(this.baseUrl, started.pollToken).then(async ({ loginName, appPassword }) => {
        const login = await completeLogin(this.baseUrl, loginName, appPassword);
        this.login = login;
        this.flow = undefined;
        console.error(`Logged in to ${this.baseUrl} as ${login.userId}; app password saved to ${credentialsFilePath()}`);
        return login;
      });
      done.catch((error: unknown) => {
        console.error(`Nextcloud login did not complete: ${error instanceof Error ? error.message : String(error)}`);
        this.flow = undefined;
      });
      this.flow = { loginUrl: started.loginUrl, expiresAt: Date.now() + (LOGIN_FLOW_TTL_SECONDS - 30) * 1000, done };
      console.error(`Nextcloud login required. Open: ${started.loginUrl}`);
    }
    throw new AuthRequiredError(
      `Not connected to Nextcloud (${this.baseUrl}) yet${forceRefresh ? " — the saved app password was revoked" : ""}. ` +
        `Give the user this link to log in and grant access (valid 20 minutes): ${this.flow.loginUrl}\n` +
        "After they confirm in the browser, call the tool again — no restart needed.",
    );
  };
}
