/**
 * Credentials towards Nextcloud (the "upstream") in hosted mode.
 *
 * OAuth mode uses Nextcloud's oauth2 app. Its quirks, from the server source
 * (apps/oauth2/lib/Controller/OauthApiController.php):
 *  - no PKCE, no scopes, no dynamic client registration — an admin registers a
 *    confidential client with a fixed redirect URI;
 *  - access tokens live 1 hour; every refresh rotates the refresh token, which
 *    itself does not expire;
 *  - the token response carries the Nextcloud `user_id`.
 *
 * Login Flow mode yields an app password, which never expires but can be revoked.
 */

import { TIMEOUT_MS, USER_AGENT } from "../constants.js";
import { AuthRequiredError, type Credentials } from "../services/client.js";
import { basicAuth } from "../services/loginflow.js";
import type { HostedConfig } from "./config.js";
import type { GrantRow, Store } from "./store.js";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  userId: string;
}

/** `permanent`: the person has to sign in again. */
export class UpstreamOAuthError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "UpstreamOAuthError";
  }
}

export class NextcloudOAuth {
  readonly redirectUri: string;

  constructor(
    private readonly config: HostedConfig,
    private readonly client: { clientId: string; clientSecret: string },
  ) {
    this.redirectUri = `${config.publicUrl.href.replace(/\/+$/, "")}/connect/callback`;
  }

  authorizationUrl(state: string): string {
    const url = new URL(`${this.config.nextcloudUrl}/index.php/apps/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.client.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    return url.href;
  }

  exchangeCode(code: string): Promise<OAuthTokens> {
    return this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
    const body = new URLSearchParams({ ...params, client_id: this.client.clientId, client_secret: this.client.clientSecret });
    let response: Response;
    try {
      response = await fetch(`${this.config.nextcloudUrl}/index.php/apps/oauth2/api/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamOAuthError(`Nextcloud token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // handled below
    }
    if (!response.ok) {
      const code = typeof json.error === "string" ? json.error : `http_${response.status}`;
      // Nextcloud answers 400 for an unknown/used code or refresh token and a wrong client secret.
      throw new UpstreamOAuthError(`Nextcloud refused the token request: ${code}`, response.status === 400 || response.status === 401);
    }
    const { access_token: accessToken, refresh_token: refreshToken, user_id: userId } = json;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof userId !== "string") {
      throw new UpstreamOAuthError("Nextcloud token response lacks access_token, refresh_token or user_id", false);
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    return { accessToken, refreshToken, accessExpiresAt: Math.floor(Date.now() / 1000) + expiresIn, userId };
  }
}

const RECONNECT =
  "Disconnect and reconnect the Nextcloud connector (in claude.ai: Settings -> Connectors), " +
  "then sign in to Nextcloud again.";

/**
 * Hands out valid Nextcloud credentials per grant, refreshing OAuth access
 * tokens shortly before they expire. Concurrent callers share one refresh:
 * Nextcloud rotates refresh tokens, so two parallel refreshes would break the grant.
 */
export class GrantCredentials {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: Store,
    private readonly oauth: NextcloudOAuth | undefined,
  ) {}

  async credentials(grantId: string, forceRefresh: boolean): Promise<Credentials> {
    const grant = this.store.getGrant(grantId);
    if (!grant) throw new AuthRequiredError(`This Nextcloud connection no longer exists. ${RECONNECT}`);
    if (grant.broken_reason) throw new AuthRequiredError(`The Nextcloud connection is no longer valid (${grant.broken_reason}). ${RECONNECT}`);

    if (grant.kind === "apppassword") {
      if (forceRefresh) {
        // Nextcloud rejected the app password: revoked in Settings -> Security, or the user was disabled.
        const reason = "Nextcloud rejected the app password — it was probably revoked";
        this.store.markGrantBroken(grantId, reason);
        throw new AuthRequiredError(`${reason}. ${RECONNECT}`);
      }
      return { authorization: basicAuth(grant.login_name ?? grant.user_id, grant.secret), userId: grant.user_id };
    }

    const now = Math.floor(Date.now() / 1000);
    if (!forceRefresh && (grant.access_expires_at ?? 0) - 60 > now) {
      return { authorization: `Bearer ${grant.secret}`, userId: grant.user_id };
    }
    const token = await this.refresh(grant);
    return { authorization: `Bearer ${token}`, userId: grant.user_id };
  }

  private refresh(grant: GrantRow): Promise<string> {
    const running = this.inflight.get(grant.id);
    if (running) return running;
    const job = (async (): Promise<string> => {
      if (!this.oauth || !grant.refresh_token) {
        this.store.markGrantBroken(grant.id, "OAuth is no longer configured on this server");
        throw new AuthRequiredError(`Nextcloud OAuth is no longer configured on this server. ${RECONNECT}`);
      }
      try {
        const tokens = await this.oauth.refresh(grant.refresh_token);
        this.store.updateGrantTokens(grant.id, tokens.accessToken, tokens.refreshToken, tokens.accessExpiresAt);
        return tokens.accessToken;
      } catch (error) {
        if (error instanceof UpstreamOAuthError && error.permanent) {
          this.store.markGrantBroken(grant.id, "access was revoked in Nextcloud");
          throw new AuthRequiredError(`Nextcloud no longer accepts this connection (access revoked). ${RECONNECT}`);
        }
        throw error;
      }
    })().finally(() => this.inflight.delete(grant.id));
    this.inflight.set(grant.id, job);
    return job;
  }

  /** The Authorization header to revoke a grant's credentials in Nextcloud (no refresh). */
  static revocationHeader(grant: GrantRow): string {
    return grant.kind === "apppassword" ? basicAuth(grant.login_name ?? grant.user_id, grant.secret) : `Bearer ${grant.secret}`;
  }
}
