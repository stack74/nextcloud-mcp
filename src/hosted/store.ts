/**
 * Persistent state for hosted mode, in SQLite (node:sqlite, no extra dependency).
 *
 * Vocabulary:
 *  - grant:   one person's connection to Nextcloud (an app password or OAuth
 *             tokens) for one MCP client. Every token this server issues points
 *             at a grant.
 *  - session: a short-lived sign-in in progress, between the MCP client's
 *             /authorize and the redirect back to it.
 *
 * Secrets at rest: Nextcloud credentials are AES-256-GCM encrypted; tokens and
 * codes this server issues are stored only as SHA-256 hashes.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface SessionRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  resource: string | null;
  /** Login Flow v2 in progress. */
  login_url: string | null;
  poll_token: string | null;
  poll_expires_at: number | null;
  /** The person approved this client on the consent page. */
  consented: boolean;
  /** Unused since 1.0.3 (the consent token is now derived from a browser nonce); kept for old databases. */
  consent_token_hash: string | null;
  expires_at: number;
}

export interface GrantRow {
  id: string;
  client_id: string;
  kind: "apppassword" | "oauth";
  user_id: string;
  display_name: string | null;
  /** Login name for app passwords (may differ from the user ID, e.g. an e-mail). */
  login_name: string | null;
  /** App password, or OAuth access token. */
  secret: string;
  refresh_token: string | null;
  access_expires_at: number | null;
  created_at: number;
  last_used_at: number;
  /** Set when Nextcloud rejected the credentials for good; the person has to sign in again. */
  broken_reason: string | null;
}

export interface TokenRow {
  kind: "access" | "refresh";
  grant_id: string;
  client_id: string;
  resource: string | null;
  expires_at: number;
}

export interface CodeRow {
  grant_id: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  resource: string | null;
  expires_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
  state TEXT, resource TEXT, upstream_state_hash TEXT, login_url TEXT, poll_token TEXT, poll_expires_at INTEGER,
  expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_upstream ON sessions (upstream_state_hash);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT,
  login_name TEXT, secret TEXT NOT NULL, refresh_token TEXT, access_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, broken_reason TEXT);
CREATE INDEX IF NOT EXISTS grants_user ON grants (user_id, client_id);
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  resource TEXT, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(dbPath: string, secret: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.key = Buffer.from(hkdfSync("sha256", secret, "nextcloud-mcp", "credential-encryption", 32));
  }

  /** Adds columns introduced after a database was created. */
  private migrate(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("consented")) this.db.exec("ALTER TABLE sessions ADD COLUMN consented INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("consent_token_hash")) this.db.exec("ALTER TABLE sessions ADD COLUMN consent_token_hash TEXT");
  }

  close(): void {
    this.db.close();
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  private decrypt(stored: string): string {
    const raw = Buffer.from(stored, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  // --- OAuth clients (MCP clients that registered with us) ---------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT data FROM oauth_clients WHERE client_id = ?").get(clientId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare("INSERT OR REPLACE INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), nowSeconds());
  }

  // --- sign-in sessions --------------------------------------------------

  createSession(row: Pick<SessionRow, "client_id" | "redirect_uri" | "code_challenge" | "state" | "resource">, ttlSeconds: number): string {
    const id = randomToken();
    this.db
      .prepare("INSERT INTO sessions (id, client_id, redirect_uri, code_challenge, state, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, row.client_id, row.redirect_uri, row.code_challenge, row.state, row.resource, nowSeconds() + ttlSeconds);
    return id;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || Number(row.expires_at) < nowSeconds()) return undefined;
    return {
      id: String(row.id),
      client_id: String(row.client_id),
      redirect_uri: String(row.redirect_uri),
      code_challenge: String(row.code_challenge),
      state: row.state === null ? null : String(row.state),
      resource: row.resource === null ? null : String(row.resource),
      login_url: row.login_url === null ? null : String(row.login_url),
      poll_token: row.poll_token === null ? null : this.decrypt(String(row.poll_token)),
      poll_expires_at: row.poll_expires_at === null ? null : Number(row.poll_expires_at),
      consented: Number(row.consented) === 1,
      consent_token_hash: row.consent_token_hash === null || row.consent_token_hash === undefined ? null : String(row.consent_token_hash),
      expires_at: Number(row.expires_at),
    };
  }

  setLoginFlow(sessionId: string, loginUrl: string, pollToken: string, expiresAt: number): void {
    this.db
      .prepare("UPDATE sessions SET login_url = ?, poll_token = ?, poll_expires_at = ? WHERE id = ?")
      .run(loginUrl, this.encrypt(pollToken), expiresAt, sessionId);
  }

  markConsented(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET consented = 1 WHERE id = ?").run(sessionId);
  }

  /** OAuth mode: the `state` sent to Nextcloud. Returns the value to send. */
  createUpstreamState(sessionId: string): string {
    const state = randomToken();
    this.db.prepare("UPDATE sessions SET upstream_state_hash = ? WHERE id = ?").run(sha256(state), sessionId);
    return state;
  }

  sessionByUpstreamState(state: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT id FROM sessions WHERE upstream_state_hash = ?").get(sha256(state)) as { id: string } | undefined;
    return row ? this.getSession(row.id) : undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // --- grants --------------------------------------------------------------

  createGrant(row: Omit<GrantRow, "id" | "created_at" | "last_used_at" | "broken_reason">): string {
    const id = randomToken(18);
    const now = nowSeconds();
    this.db
      .prepare(
        `INSERT INTO grants (id, client_id, kind, user_id, display_name, login_name, secret, refresh_token, access_expires_at, created_at, last_used_at, broken_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        row.client_id,
        row.kind,
        row.user_id,
        row.display_name,
        row.login_name,
        this.encrypt(row.secret),
        row.refresh_token === null ? null : this.encrypt(row.refresh_token),
        row.access_expires_at,
        now,
        now,
      );
    return id;
  }

  getGrant(id: string): GrantRow | undefined {
    const row = this.db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.decodeGrant(row) : undefined;
  }

  /** Earlier grants of the same Nextcloud user for the same MCP client (replaced on re-sign-in). */
  grantsFor(userId: string, clientId: string): GrantRow[] {
    const rows = this.db.prepare("SELECT * FROM grants WHERE user_id = ? AND client_id = ?").all(userId, clientId) as Record<string, unknown>[];
    return rows.map((r) => this.decodeGrant(r));
  }

  updateGrantTokens(id: string, accessToken: string, refreshToken: string, accessExpiresAt: number): void {
    this.db
      .prepare("UPDATE grants SET secret = ?, refresh_token = ?, access_expires_at = ?, broken_reason = NULL WHERE id = ?")
      .run(this.encrypt(accessToken), this.encrypt(refreshToken), accessExpiresAt, id);
  }

  markGrantBroken(id: string, reason: string): void {
    this.db.prepare("UPDATE grants SET broken_reason = ? WHERE id = ?").run(reason, id);
  }

  touchGrant(id: string): void {
    this.db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(nowSeconds(), id);
  }

  deleteGrant(id: string): void {
    this.db.prepare("DELETE FROM tokens WHERE grant_id = ?").run(id);
    this.db.prepare("DELETE FROM auth_codes WHERE grant_id = ?").run(id);
    this.db.prepare("DELETE FROM grants WHERE id = ?").run(id);
  }

  private decodeGrant(row: Record<string, unknown>): GrantRow {
    return {
      id: String(row.id),
      client_id: String(row.client_id),
      kind: row.kind === "oauth" ? "oauth" : "apppassword",
      user_id: String(row.user_id),
      display_name: row.display_name === null ? null : String(row.display_name),
      login_name: row.login_name === null ? null : String(row.login_name),
      secret: this.decrypt(String(row.secret)),
      refresh_token: row.refresh_token === null ? null : this.decrypt(String(row.refresh_token)),
      access_expires_at: row.access_expires_at === null ? null : Number(row.access_expires_at),
      created_at: Number(row.created_at),
      last_used_at: Number(row.last_used_at),
      broken_reason: row.broken_reason === null ? null : String(row.broken_reason),
    };
  }

  // --- authorization codes (issued to MCP clients) -----------------------

  createCode(row: Omit<CodeRow, "expires_at">): string {
    const code = randomToken();
    this.db
      .prepare("INSERT INTO auth_codes (code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sha256(code), row.grant_id, row.client_id, row.code_challenge, row.redirect_uri, row.resource, nowSeconds() + 300);
    return code;
  }

  getCode(code: string): CodeRow | undefined {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(sha256(code)) as CodeRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteCode(code: string): void {
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(sha256(code));
  }

  // --- tokens (issued to MCP clients) ------------------------------------

  createToken(row: Omit<TokenRow, "expires_at">, ttlSeconds: number): { token: string; expiresAt: number } {
    const token = randomToken();
    const expiresAt = nowSeconds() + ttlSeconds;
    this.db
      .prepare("INSERT INTO tokens (token_hash, kind, grant_id, client_id, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), row.kind, row.grant_id, row.client_id, row.resource, expiresAt);
    return { token, expiresAt };
  }

  getToken(token: string): TokenRow | undefined {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(sha256(token)) as TokenRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteToken(token: string): void {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha256(token));
  }

  // --- housekeeping ------------------------------------------------------

  /**
   * Drops expired sessions, codes and tokens, and returns grants that no
   * longer have any token (nobody can use them any more) so the caller can
   * revoke their Nextcloud credentials and delete them.
   */
  purgeExpired(): GrantRow[] {
    const now = nowSeconds();
    for (const table of ["sessions", "auth_codes", "tokens"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(now);
    }
    // A grace period keeps a grant whose first tokens are being issued right now.
    const orphans = this.db
      .prepare(
        "SELECT * FROM grants g WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.grant_id = g.id) AND NOT EXISTS (SELECT 1 FROM auth_codes c WHERE c.grant_id = g.id)",
      )
      .all(now - 600) as Record<string, unknown>[];
    return orphans.map((r) => this.decodeGrant(r));
  }
}
