/**
 * The OAuth authorization server MCP clients (claude.ai, Claude Code, …) talk to.
 *
 * The SDK's mcpAuthRouter handles the protocol (metadata, dynamic client
 * registration, PKCE checks, token endpoint); this provider supplies the state.
 *
 * `authorize` does not show a login form: it starts a sign-in session and sends
 * the person on to Nextcloud (see http.ts, /connect/:sid). Once Nextcloud has
 * confirmed who they are, `completeAuthorization` hands the MCP client its code.
 */

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { CustomOAuthError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HostedConfig } from "./config.js";
import { renderMessage } from "./pages.js";
import type { SessionRow, Store } from "./store.js";

/** How long a sign-in may take, from /authorize to the redirect back. */
export const SESSION_TTL_SECONDS = 30 * 60;

export class HostedOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly config: HostedConfig,
    private readonly store: Store,
  ) {
    this.clientsStore = {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: (client) => {
        // Only known redirect targets: an attacker-controlled one would receive
        // the code for whoever signs in (see redirects.ts).
        const refused = (client.redirect_uris ?? []).filter((uri) => !config.redirects.allows(String(uri)));
        if (refused.length > 0 || (client.redirect_uris ?? []).length === 0) {
          console.error(`Client registration refused: redirect URI(s) not allowed: ${refused.join(", ") || "(none given)"}`);
          throw new CustomOAuthError(
            "invalid_redirect_uri",
            `Redirect URI not allowed on this server: ${refused.join(", ") || "(none given)"}. ` +
              "The operator can extend NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS.",
          );
        }
        const full = client as OAuthClientInformationFull;
        store.saveClient(full);
        return full;
      },
    };
  }

  /** Accepts the MCP endpoint (and the bare origin, which some clients send) as RFC 8707 resource. */
  private checkResource(resource: URL | undefined): void {
    if (!resource) return;
    const allowed = [this.config.mcpUrl.href, this.config.publicUrl.href, `${this.config.publicUrl.origin}/`];
    if (!allowed.includes(resource.href)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.config.mcpUrl.href}`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Checked again here: the client may have registered before the allowlist was narrowed.
    // Answer with a page instead of redirecting — the redirect target is the problem.
    if (!this.config.redirects.allows(params.redirectUri)) {
      console.error(`Authorization refused for client ${client.client_id}: redirect URI ${params.redirectUri} not allowed`);
      res.setHeader("Cache-Control", "no-store");
      res
        .status(400)
        .type("html")
        .send(renderMessage("Sign-in refused", "This app may not sign in to this server: its redirect address is not allowed."));
      return;
    }
    this.checkResource(params.resource);
    const sessionId = this.store.createSession(
      {
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        state: params.state ?? null,
        resource: params.resource?.href ?? null,
      },
      SESSION_TTL_SECONDS,
    );
    res.redirect(302, `/connect/${sessionId}`);
  }

  /** The person signed in: returns the redirect back to the MCP client with a code. */
  completeAuthorization(session: SessionRow, grantId: string): string {
    const code = this.store.createCode({
      grant_id: grantId,
      client_id: session.client_id,
      code_challenge: session.code_challenge,
      redirect_uri: session.redirect_uri,
      resource: session.resource,
    });
    this.store.deleteSession(session.id);
    const target = new URL(session.redirect_uri);
    target.searchParams.set("code", code);
    if (session.state) target.searchParams.set("state", session.state);
    return target.href;
  }

  /** Cancelled or refused: tells the MCP client access was denied. */
  denyAuthorization(session: SessionRow, description: string): string {
    this.store.deleteSession(session.id);
    const target = new URL(session.redirect_uri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", description);
    if (session.state) target.searchParams.set("state", session.state);
    return target.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.store.getCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.store.getCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);
    // Single use, also when the exchange fails further down.
    this.store.deleteCode(authorizationCode);
    return this.issueTokens(row.grant_id, client.client_id, resource?.href ?? row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.store.getToken(refreshToken);
    const grant = row ? this.store.getGrant(row.grant_id) : undefined;
    if (!row || row.kind !== "refresh" || row.client_id !== client.client_id || !grant) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    // A broken Nextcloud connection cannot be fixed by refreshing: make the client sign in again.
    if (grant.broken_reason) {
      this.store.deleteToken(refreshToken);
      throw new InvalidGrantError(`The Nextcloud connection is no longer valid (${grant.broken_reason}); sign in again.`);
    }
    this.checkResource(resource);
    // Rotate: the old refresh token stops working.
    this.store.deleteToken(refreshToken);
    return this.issueTokens(row.grant_id, client.client_id, resource?.href ?? row.resource);
  }

  private issueTokens(grantId: string, clientId: string, resource: string | null): OAuthTokens {
    const access = this.store.createToken({ kind: "access", grant_id: grantId, client_id: clientId, resource }, this.config.accessTokenTtlSeconds);
    const refresh = this.store.createToken({ kind: "refresh", grant_id: grantId, client_id: clientId, resource }, this.config.refreshTokenTtlSeconds);
    this.store.touchGrant(grantId);
    return { access_token: access.token, token_type: "Bearer", expires_in: this.config.accessTokenTtlSeconds, refresh_token: refresh.token };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.store.getToken(token);
    const grant = row?.kind === "access" ? this.store.getGrant(row.grant_id) : undefined;
    // A broken grant answers 401, which makes MCP clients run the sign-in again.
    if (!row || !grant || grant.broken_reason) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: row.client_id,
      scopes: [],
      expiresAt: row.expires_at,
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
      extra: { grantId: row.grant_id },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.deleteToken(request.token);
  }
}
