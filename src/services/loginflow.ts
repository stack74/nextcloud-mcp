/**
 * Nextcloud Login Flow v2 and a few unauthenticated/self-service calls around it.
 *
 * Login Flow v2 needs no admin setup: the server asks Nextcloud for a login URL,
 * the person opens it, logs in (with their 2FA) and grants access, and the
 * server polls until Nextcloud hands over an app password for this person.
 * The app password shows up under Settings -> Security -> Devices & sessions,
 * named after our User-Agent, and can be revoked there at any time.
 * https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/
 */

import { TIMEOUT_MS, USER_AGENT } from "../constants.js";

export interface LoginFlowStart {
  /** Where the person logs in. */
  loginUrl: string;
  /** Secret for polling; valid 20 minutes. */
  pollToken: string;
}

export interface LoginFlowResult {
  loginName: string;
  appPassword: string;
}

export interface NextcloudUser {
  id: string;
  displayName: string;
  email: string | null;
  groups: string[];
}

/** How long Nextcloud keeps a login flow open. */
export const LOGIN_FLOW_TTL_SECONDS = 20 * 60;

export const basicAuth = (login: string, password: string): string =>
  `Basic ${Buffer.from(`${login}:${password}`, "utf8").toString("base64")}`;

export async function startLoginFlow(baseUrl: string): Promise<LoginFlowStart> {
  const response = await fetch(`${baseUrl}/index.php/login/v2`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Nextcloud refused to start a login (HTTP ${response.status} from ${baseUrl}/index.php/login/v2).`);
  const body = (await response.json()) as { login?: unknown; poll?: { token?: unknown } };
  if (typeof body.login !== "string" || typeof body.poll?.token !== "string") {
    throw new Error("Unexpected Login Flow answer from Nextcloud (no login URL or poll token).");
  }
  return { loginUrl: body.login, pollToken: body.poll.token };
}

/**
 * Polls once. Returns null while the person has not finished yet.
 * We always poll our configured base URL rather than the endpoint Nextcloud
 * returns, so the token never goes to a host taken from a response.
 */
export async function pollLoginFlow(baseUrl: string, pollToken: string): Promise<LoginFlowResult | null> {
  const response = await fetch(`${baseUrl}/index.php/login/v2/poll`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: pollToken }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`Login Flow poll failed (HTTP ${response.status}).`);
  const body = (await response.json()) as { loginName?: unknown; appPassword?: unknown };
  if (typeof body.loginName !== "string" || typeof body.appPassword !== "string") {
    throw new Error("Unexpected Login Flow poll answer (no loginName/appPassword).");
  }
  return { loginName: body.loginName, appPassword: body.appPassword };
}

/** The user behind an Authorization header (OCS /cloud/user). */
export async function fetchUser(baseUrl: string, authorization: string): Promise<NextcloudUser> {
  const response = await fetch(`${baseUrl}/ocs/v2.php/cloud/user?format=json`, {
    headers: { Authorization: authorization, "OCS-APIRequest": "true", Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Nextcloud did not accept the new credentials (HTTP ${response.status}).`);
  const body = (await response.json()) as {
    ocs?: { data?: { id?: unknown; displayname?: unknown; "display-name"?: unknown; email?: unknown; groups?: unknown } };
  };
  const data = body.ocs?.data ?? {};
  if (typeof data.id !== "string" || !data.id) throw new Error("Nextcloud returned no user ID.");
  const displayName = typeof data.displayname === "string" ? data.displayname : typeof data["display-name"] === "string" ? data["display-name"] : data.id;
  return {
    id: data.id,
    displayName,
    email: typeof data.email === "string" && data.email ? data.email : null,
    groups: Array.isArray(data.groups) ? data.groups.map(String) : [],
  };
}

/**
 * Deletes the app password (or OAuth app token) used for the request, so it
 * disappears from the person's device list. Best effort.
 */
export async function revokeCredentials(baseUrl: string, authorization: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/ocs/v2.php/core/apppassword?format=json`, {
      method: "DELETE",
      headers: { Authorization: authorization, "OCS-APIRequest": "true", Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
