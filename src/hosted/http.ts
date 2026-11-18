/**
 * Hosted mode: Streamable HTTP transport + OAuth, for use as a remote connector
 * (claude.ai "Custom connector", Claude Code `--transport http`, …).
 *
 * Routes:
 *   /.well-known/*, /authorize, /token, /register, /revoke   OAuth (SDK mcpAuthRouter)
 *   GET  /connect/:sid                                      sign-in: Login Flow page or redirect to Nextcloud OAuth
 *   GET  /connect/callback                                  Nextcloud OAuth callback
 *   POST /connect/:sid/cancel                               abort the sign-in
 *   POST /mcp                                               MCP endpoint (stateless, bearer auth)
 *   GET  /healthz                                           liveness
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { HOSTED_BODY_LIMIT_BYTES, SERVER_NAME, SERVER_VERSION } from "../constants.js";
import { createNextcloudServer } from "../server.js";
import { NextcloudClient } from "../services/client.js";
import {
  LOGIN_FLOW_TTL_SECONDS,
  type NextcloudUser,
  basicAuth,
  fetchUser,
  pollLoginFlow,
  revokeCredentials,
  startLoginFlow,
} from "../services/loginflow.js";
import { type HostedConfig, loadHostedConfig } from "./config.js";
import { renderConsentPage, renderDeniedPage, renderLoginFlowPage, renderMessage, setPageIcon } from "./pages.js";
import { HostedOAuthProvider } from "./provider.js";
import { type GrantRow, type SessionRow, Store } from "./store.js";
import { GrantCredentials, NextcloudOAuth, UpstreamOAuthError } from "./upstream.js";

export interface HostedApp {
  app: express.Express;
  store: Store;
  config: HostedConfig;
  /** Revokes and deletes grants nobody can use any more. */
  housekeeping(): Promise<void>;
}

/** Why a Nextcloud user may not use this server, or undefined when they may. */
function refusal(config: HostedConfig, user: NextcloudUser): string | undefined {
  if (config.allowedUsers.length === 0 && config.allowedGroups.length === 0) return undefined;
  if (config.allowedUsers.includes(user.id)) return undefined;
  if (user.groups.some((g) => config.allowedGroups.includes(g))) return undefined;
  return "Your Nextcloud account is not enabled for this connector. Please contact your administrator.";
}

export async function createHostedApp(config: HostedConfig): Promise<HostedApp> {
  const store = new Store(config.dbPath, config.secret);
  const oauth = config.oauth ? new NextcloudOAuth(config, config.oauth) : undefined;
  const credentials = new GrantCredentials(store, oauth);
  const provider = new HostedOAuthProvider(config, store);
  const nextcloudHost = new URL(config.nextcloudUrl).host;

  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy (Coolify/Traefik): needed for the SDK's rate limiting.
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  let icons: Icon[] | undefined;
  if (config.icon) {
    const { path: iconPath, mimeType, extension } = config.icon;
    let body: Buffer;
    try {
      body = readFileSync(iconPath);
    } catch (error) {
      throw new Error(`Hosted mode configuration: cannot read NEXTCLOUD_MCP_ICON_PATH ${JSON.stringify(iconPath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const iconRoute = `/favicon.${extension}`;
    const sendIcon = (_req: Request, res: Response): void => {
      res.set("Cache-Control", "public, max-age=86400").type(mimeType).send(body);
    };
    app.get(iconRoute, sendIcon);
    if (iconRoute !== "/favicon.ico") app.get("/favicon.ico", sendIcon);
    setPageIcon(iconRoute, mimeType);
    icons = [{ src: new URL(iconRoute, config.publicUrl).href, mimeType, ...(extension === "svg" ? { sizes: ["any"] } : {}) }];
  }

  app.use(mcpAuthRouter({ provider, issuerUrl: config.publicUrl, resourceServerUrl: config.mcpUrl, resourceName: "Nextcloud" }));

  // --- sign-in ---------------------------------------------------------------

  const pageHeaders = (res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
    );
  };

  const expired = (res: Response): void => {
    pageHeaders(res);
    res
      .status(400)
      .type("html")
      .send(renderMessage("Link expired", "This sign-in is no longer valid. Start the connection in Claude again."));
  };

  const failed = (res: Response, text: string): void => {
    pageHeaders(res);
    res.status(502).type("html").send(renderMessage("Sign-in failed", text));
  };

  /**
   * Nextcloud confirmed who the person is: check they may use this server,
   * replace their earlier connection from the same MCP client, issue the code.
   */
  const finish = async (
    res: Response,
    session: SessionRow,
    kind: GrantRow["kind"],
    authorization: string,
    secrets: { secret: string; refresh_token: string | null; access_expires_at: number | null; login_name: string | null },
  ): Promise<void> => {
    let user: NextcloudUser;
    try {
      user = await fetchUser(config.nextcloudUrl, authorization);
    } catch (error) {
      console.error(`Sign-in: cannot read the Nextcloud user: ${error instanceof Error ? error.message : String(error)}`);
      await revokeCredentials(config.nextcloudUrl, authorization);
      return failed(res, "Nextcloud did not confirm the new login. Please try again.");
    }

    const refused = refusal(config, user);
    if (refused) {
      console.error(`Sign-in refused for Nextcloud user ${user.id} (not in NEXTCLOUD_ALLOWED_USERS/GROUPS)`);
      await revokeCredentials(config.nextcloudUrl, authorization);
      pageHeaders(res);
      res.status(403).type("html").send(renderDeniedPage({ sessionId: session.id, who: user.displayName, reason: refused }));
      return;
    }

    // Signing in again from the same client replaces the old connection, so the
    // person's device list in Nextcloud does not fill up with stale app passwords.
    for (const old of store.grantsFor(user.id, session.client_id)) {
      store.deleteGrant(old.id);
      void revokeCredentials(config.nextcloudUrl, GrantCredentials.revocationHeader(old));
    }
    const grantId = store.createGrant({
      client_id: session.client_id,
      kind,
      user_id: user.id,
      display_name: user.displayName,
      ...secrets,
    });
    console.error(`Nextcloud user ${user.id} connected (${kind})`);
    res.redirect(303, provider.completeAuthorization(session, grantId));
  };

  app.get("/connect/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const session = state ? store.sessionByUpstreamState(state) : undefined;
    if (!oauth || !session) return expired(res);
    if (typeof req.query.code !== "string") {
      // Nextcloud sends ?error=… when the person declines.
      return res.redirect(303, provider.denyAuthorization(session, "The user declined access in Nextcloud."));
    }
    let tokens;
    try {
      tokens = await oauth.exchangeCode(req.query.code);
    } catch (error) {
      console.error(`Nextcloud code exchange failed: ${error instanceof Error ? error.message : String(error)}`);
      return failed(
        res,
        error instanceof UpstreamOAuthError && error.permanent
          ? "Nextcloud refused the sign-in. Check the client ID and secret of the OAuth client in Nextcloud."
          : "Nextcloud cannot be reached right now. Please try again shortly.",
      );
    }
    await finish(res, session, "oauth", `Bearer ${tokens.accessToken}`, {
      secret: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      access_expires_at: tokens.accessExpiresAt,
      login_name: null,
    });
  });

  // --- consent -------------------------------------------------------------
  //
  // Before anything goes to Nextcloud, the person sees which client asks and
  // where the access will end up (MCP security best practices: a proxy must get
  // consent per dynamically registered client).
  //
  // The consent form is CSRF-protected. Whoever started /authorize knows the
  // session id and can open the page too, so the token must not depend on the
  // session alone: it is HMAC(secret, sid + a random per-browser nonce), and the
  // nonce lives in an HttpOnly cookie. Over https the cookie carries the __Host-
  // prefix (Secure, Path=/, no Domain), so a sibling subdomain — which counts as
  // the same site — cannot plant a nonce of its choosing either.

  const BROWSER_COOKIE = config.publicUrl.protocol === "https:" ? "__Host-ncmcp_browser" : "ncmcp_browser";
  const NONCE = /^[A-Za-z0-9_-]{43}$/;
  const readCookie = (req: Request, name: string): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key !== name) continue;
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const sameToken = (a: string, b: string): boolean => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const consentToken = (sid: string, nonce: string): string =>
    createHmac("sha256", config.secret).update(`consent:${sid}:${nonce}`).digest("base64url");

  /** The browser's nonce, set (or refreshed) on the response. */
  const browserNonce = (req: Request, res: Response): string => {
    const existing = readCookie(req, BROWSER_COOKIE);
    const nonce = existing && NONCE.test(existing) ? existing : randomBytes(32).toString("base64url");
    res.cookie(BROWSER_COOKIE, nonce, {
      httpOnly: true,
      secure: config.publicUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 3600 * 1000,
    });
    return nonce;
  };

  const showConsent = (req: Request, res: Response, session: SessionRow): void => {
    const token = consentToken(session.id, browserNonce(req, res));
    pageHeaders(res);
    res.type("html").send(
      renderConsentPage({
        sessionId: session.id,
        csrfToken: token,
        clientName: store.getClient(session.client_id)?.client_name,
        redirectUri: session.redirect_uri,
        nextcloudHost,
        writes: config.writes,
      }),
    );
  };

  app.post("/connect/:sid/consent", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const session = store.getSession(String(req.params.sid));
    if (!session) return expired(res);
    const form = typeof req.body?.csrf === "string" ? req.body.csrf : "";
    const nonce = readCookie(req, BROWSER_COOKIE) ?? "";
    const valid = NONCE.test(nonce) && Boolean(form) && sameToken(form, consentToken(session.id, nonce));
    if (!valid) {
      console.error(`Consent refused for session (client ${session.client_id}): CSRF token missing or wrong`);
      pageHeaders(res);
      res.status(403).type("html").send(renderMessage("Not confirmed", "Your consent could not be verified. Start the connection in Claude again."));
      return;
    }
    store.markConsented(session.id);
    res.redirect(303, `/connect/${encodeURIComponent(session.id)}`);
  });

  app.get("/connect/:sid", async (req, res) => {
    const session = store.getSession(String(req.params.sid));
    if (!session) return expired(res);
    if (!session.consented) return showConsent(req, res, session);

    if (oauth) {
      res.redirect(303, oauth.authorizationUrl(store.createUpstreamState(session.id)));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (session.poll_token && session.login_url && (session.poll_expires_at ?? 0) > now) {
      let result;
      try {
        result = await pollLoginFlow(config.nextcloudUrl, session.poll_token);
      } catch (error) {
        console.error(`Login Flow poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result) {
        // Nextcloud hands the credentials out once; the flow is used up either way.
        store.setLoginFlow(session.id, session.login_url, "", 0);
        return finish(res, session, "apppassword", basicAuth(result.loginName, result.appPassword), {
          secret: result.appPassword,
          refresh_token: null,
          access_expires_at: null,
          login_name: result.loginName,
        });
      }
      pageHeaders(res);
      res.type("html").send(renderLoginFlowPage({ sessionId: session.id, loginUrl: session.login_url, nextcloudHost }));
      return;
    }

    let flow;
    try {
      flow = await startLoginFlow(config.nextcloudUrl);
    } catch (error) {
      console.error(`Cannot start Login Flow: ${error instanceof Error ? error.message : String(error)}`);
      return failed(res, `${nextcloudHost} cannot be reached right now. Please try again shortly.`);
    }
    store.setLoginFlow(session.id, flow.loginUrl, flow.pollToken, now + LOGIN_FLOW_TTL_SECONDS - 30);
    pageHeaders(res);
    res.type("html").send(renderLoginFlowPage({ sessionId: session.id, loginUrl: flow.loginUrl, nextcloudHost }));
  });

  app.post("/connect/:sid/cancel", (req, res) => {
    const session = store.getSession(String(req.params.sid));
    if (!session) return expired(res);
    res.redirect(303, provider.denyAuthorization(session, "The user cancelled connecting Nextcloud."));
  });

  // --- MCP endpoint ---------------------------------------------------------

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl) });

  app.post("/mcp", bearer, express.json({ limit: HOSTED_BODY_LIMIT_BYTES }), async (req, res) => {
    const grantId = String(req.auth?.extra?.grantId ?? "");
    const client = new NextcloudClient(config.nextcloudUrl, ({ forceRefresh }) => credentials.credentials(grantId, forceRefresh), {
      canRefresh: true,
    });
    const { server } = createNextcloudServer(client, { hosted: true, writesEnabled: config.writes, ...(icons ? { icons } : {}) });

    // Stateless: a fresh server + transport per request, closed with the response.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/", (_req, res) => {
    pageHeaders(res);
    res.type("html").send(renderMessage("Nextcloud MCP", `This server provides ${nextcloudHost} as an MCP connector. Connector URL: ${config.mcpUrl.href}`));
  });

  const housekeeping = async (): Promise<void> => {
    for (const grant of store.purgeExpired()) {
      // Best effort: the app password / OAuth token disappears from the person's device list.
      await revokeCredentials(config.nextcloudUrl, GrantCredentials.revocationHeader(grant));
      store.deleteGrant(grant.id);
    }
  };

  return { app, store, config, housekeeping };
}

/** Entry point for `nextcloud-mcp --http`. */
export async function startHttpServer(): Promise<void> {
  const config = loadHostedConfig();
  const { app, store, housekeeping } = await createHostedApp(config);

  const timer = setInterval(() => {
    housekeeping().catch((error: unknown) => console.error(`Housekeeping failed: ${error instanceof Error ? error.message : String(error)}`));
  }, 10 * 60 * 1000);
  timer.unref();

  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
      process.exit(1);
    }
    const access =
      config.allowedUsers.length || config.allowedGroups.length
        ? `allowed: users [${config.allowedUsers.join(", ")}] groups [${config.allowedGroups.join(", ")}]`
        : "every Nextcloud user may connect";
    console.error(
      `${SERVER_NAME} v${SERVER_VERSION} listening on ${config.host}:${config.port} | MCP endpoint ${config.mcpUrl.href} | ` +
        `Nextcloud ${config.nextcloudUrl} via ${config.connectMode === "oauth" ? `OAuth2 (redirect URI ${config.publicUrl.href.replace(/\/+$/, "")}/connect/callback)` : "Login Flow v2"} | ` +
        `writes ${config.writes ? "ENABLED" : "disabled"} | ${access}`,
    );
  });

  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
