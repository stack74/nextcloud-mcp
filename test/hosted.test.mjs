/**
 * Hosted mode end to end: the real server (dist/index.js --http) against the
 * fake Nextcloud, walking the flow claude.ai performs — discovery, dynamic
 * client registration, authorize -> Nextcloud sign-in -> code -> tokens — and
 * then MCP calls with the person's own Nextcloud permissions.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeNextcloud } from "./helpers/fake-nextcloud.mjs";
import { SERVER_ENTRY } from "./helpers/mcp-client.mjs";

const REDIRECT = "http://localhost:9999/callback";

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startHosted(env, options = {}) {
  const port = options.port ?? (await freePort());
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "nc-mcp-hosted-"));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn("node", [SERVER_ENTRY, "--http"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NEXTCLOUD_MCP_PUBLIC_URL: base,
      NEXTCLOUD_MCP_SECRET: "x".repeat(40),
      NEXTCLOUD_MCP_DB_PATH: path.join(dir, "db.sqlite"),
      NEXTCLOUD_ALLOW_INSECURE_HTTP: "true",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    get stderr() {
      return stderr;
    },
    port,
    dir,
    stop({ keepData = false } = {}) {
      child.kill();
      if (!keepData) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Registers an MCP client and starts /authorize; returns the sign-in page URL and the PKCE verifier. */
async function beginAuthorization(base, clientId, redirect = REDIRECT) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: `${base}/mcp`,
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302);
  return { connectUrl: new URL(res.headers.get("location"), base).href, verifier };
}

/** The consent page: approves it (with the CSRF cookie, as a browser would) and returns its HTML. */
async function consent(connectUrl) {
  const page = await fetch(connectUrl);
  const html = await page.text();
  assert.match(html, /Allow access to your Nextcloud\?/);
  const cookie = /ncmcp_browser=[^;]+/.exec(page.headers.get("set-cookie") ?? "")?.[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(cookie && csrf, "consent page must set a cookie and carry a CSRF token");
  const res = await fetch(`${connectUrl}/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(res.status, 303);
  return html;
}

async function registerRaw(base, redirect = REDIRECT) {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  return fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
}

async function register(base) {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

async function exchange(base, clientId, code, verifier) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

/** Full Login Flow sign-in as `user`. Returns the MCP access token. */
async function signInLoginFlow(nc, base, clientId, user) {
  const { connectUrl, verifier } = await beginAuthorization(base, clientId);
  await consent(connectUrl);
  const page = await (await fetch(connectUrl)).text();
  assert.match(page, /http-equiv="refresh"/);
  const loginUrl = /href="([^"]*\/login\/v2\/flow\/\w+)"/.exec(page)?.[1];
  assert.ok(loginUrl, "no Nextcloud login link on the page");
  // Not logged in yet: the page keeps waiting.
  assert.equal((await fetch(connectUrl, { redirect: "manual" })).status, 200);
  await fetch(`${loginUrl}?as=${user}`);
  const done = await fetch(connectUrl, { redirect: "manual" });
  if (done.status !== 303) return { refused: done.status, page: await done.text() };
  const back = new URL(done.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st4te");
  const tokens = await exchange(base, clientId, back.searchParams.get("code"), verifier);
  return { tokens };
}

async function mcp(base, token, method, params = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text(), headers: res.headers };
}
const toolText = (r) => r.body.result.content.map((c) => c.text ?? "").join("\n");

describe("hosted mode with Login Flow v2", () => {
  let nc;
  let server;
  before(async () => {
    nc = await startFakeNextcloud();
    nc.addFile("alice", "Projekte/Plan.md", "# Plan\nLaunch im Dezember", "text/markdown");
    nc.addFile("bob", "bob.txt", "nur bob", "text/plain");
    server = await startHosted({ NEXTCLOUD_URL: nc.base, NEXTCLOUD_ENABLE_WRITES: "true" });
  });
  after(() => {
    server?.stop();
    nc?.close();
  });

  it("advertises OAuth metadata for the MCP endpoint", async () => {
    const res = await fetch(`${server.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    const meta = await (await fetch(`${server.base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(meta.resource, `${server.base}/mcp`);
  });

  it("signs a person in and runs tools with their permissions", async () => {
    const clientId = await register(server.base);
    const { tokens } = await signInLoginFlow(nc, server.base, clientId, "alice");
    const who = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_whoami", arguments: {} });
    assert.match(toolText(who), /Alice Example/);
    const read = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_read_file", arguments: { path: "/Projekte/Plan.md" } });
    assert.match(toolText(read), /Launch im Dezember/);
    const bobs = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_read_file", arguments: { path: "/bob.txt" } });
    assert.equal(bobs.body.result.isError, true, "alice must not see bob's files");

    // Hosted: no local paths in tools.
    const list = await mcp(server.base, tokens.access_token, "tools/list");
    const tools = Object.fromEntries(list.body.result.tools.map((t) => [t.name, t]));
    assert.ok(!("output_path" in tools.nextcloud_download_file.inputSchema.properties));
    assert.ok(!("local_path" in tools.nextcloud_upload_file.inputSchema.properties));
    const dl = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_download_file", arguments: { path: "/Projekte/Plan.md" } });
    assert.equal(dl.body.result.content[1].type, "resource");
    assert.equal(Buffer.from(dl.body.result.content[1].resource.blob, "base64").toString(), "# Plan\nLaunch im Dezember");
  });

  it("replaces the earlier connection when the same client signs in again", async () => {
    const clientId = await register(server.base);
    const first = await signInLoginFlow(nc, server.base, clientId, "alice");
    const passwordsBefore = new Set(nc.state.appPasswords.keys());
    const second = await signInLoginFlow(nc, server.base, clientId, "alice");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await mcp(server.base, first.tokens.access_token, "tools/list")).status, 401, "old token must stop working");
    assert.equal((await mcp(server.base, second.tokens.access_token, "tools/list")).status, 200);
    const stillThere = [...passwordsBefore].filter((p) => nc.state.appPasswords.has(p));
    assert.equal(stillThere.length, passwordsBefore.size - 1, "the old app password is revoked in Nextcloud");
  });

  it("asks the client to sign in again once the app password is revoked", async () => {
    const clientId = await register(server.base);
    const { tokens } = await signInLoginFlow(nc, server.base, clientId, "alice");
    // Revoke every app password of alice, as if done in Settings -> Security.
    for (const [password, user] of nc.state.appPasswords) if (user === "alice") nc.state.appPasswords.delete(password);
    const call = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_list_files", arguments: {} });
    assert.match(toolText(call), /revoked.*reconnect/is);
    const next = await mcp(server.base, tokens.access_token, "tools/list");
    assert.equal(next.status, 401, "a broken connection answers 401 so the client re-runs the sign-in");
  });

  it("can be cancelled", async () => {
    const clientId = await register(server.base);
    const { connectUrl } = await beginAuthorization(server.base, clientId);
    await fetch(connectUrl);
    const res = await fetch(`${connectUrl}/cancel`, { method: "POST", redirect: "manual" });
    const back = new URL(res.headers.get("location"));
    assert.equal(back.searchParams.get("error"), "access_denied");
  });
});

describe("hosted mode access restrictions", () => {
  it("refuses users outside NEXTCLOUD_ALLOWED_GROUPS and revokes their app password", async () => {
    const nc = await startFakeNextcloud();
    const server = await startHosted({ NEXTCLOUD_URL: nc.base, NEXTCLOUD_ALLOWED_GROUPS: "staff" });
    try {
      const clientId = await register(server.base);
      const bob = await signInLoginFlow(nc, server.base, clientId, "bob");
      assert.equal(bob.refused, 403);
      assert.match(bob.page, /not enabled for this connector/);
      assert.equal([...nc.state.appPasswords.values()].filter((u) => u === "bob").length, 0);
      const alice = await signInLoginFlow(nc, server.base, clientId, "alice");
      assert.ok(alice.tokens.access_token);
    } finally {
      server.stop();
      nc.close();
    }
  });
});

describe("hosted mode with Nextcloud OAuth2", () => {
  it("signs in through Nextcloud's oauth2 app and refreshes its short-lived tokens", async () => {
    // 30 s tokens: below the 60 s safety margin, so every call refreshes.
    const nc = await startFakeNextcloud({ accessTtl: 30 });
    nc.addFile("alice", "a.txt", "hallo", "text/plain");
    const server = await startHosted({ NEXTCLOUD_URL: nc.base, NEXTCLOUD_OAUTH_CLIENT_ID: "nc-client", NEXTCLOUD_OAUTH_CLIENT_SECRET: "nc-secret" });
    try {
      const clientId = await register(server.base);
      const { connectUrl, verifier } = await beginAuthorization(server.base, clientId);
      await consent(connectUrl);
      const toNextcloud = await fetch(connectUrl, { redirect: "manual" });
      assert.equal(toNextcloud.status, 303);
      const authorizeUrl = new URL(toNextcloud.headers.get("location"));
      assert.equal(authorizeUrl.pathname, "/index.php/apps/oauth2/authorize");
      assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `${server.base}/connect/callback`);
      authorizeUrl.searchParams.set("as", "alice");
      const callback = await fetch(authorizeUrl, { redirect: "manual" });
      const done = await fetch(callback.headers.get("location"), { redirect: "manual" });
      assert.equal(done.status, 303, await done.clone().text());
      const back = new URL(done.headers.get("location"));
      const tokens = await exchange(server.base, clientId, back.searchParams.get("code"), verifier);

      const first = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_read_file", arguments: { path: "/a.txt" } });
      assert.match(toolText(first), /hallo/);
      const second = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_whoami", arguments: {} });
      assert.match(toolText(second), /Alice Example/);
      assert.ok(nc.state.refreshCount >= 1, "access token was refreshed");

      // Revoked in Nextcloud: refresh fails for good -> 401 for the client.
      nc.state.refresh.clear();
      nc.state.bearer.clear();
      const broken = await mcp(server.base, tokens.access_token, "tools/call", { name: "nextcloud_whoami", arguments: {} });
      assert.match(toolText(broken), /revoked/);
      assert.equal((await mcp(server.base, tokens.access_token, "tools/list")).status, 401);
    } finally {
      server.stop();
      nc.close();
    }
  });
});

describe("hosted mode: who may receive the access (confused deputy)", () => {
  let nc;
  before(async () => {
    nc = await startFakeNextcloud();
  });
  after(() => nc?.close());

  it("only lets known redirect URIs register; the list can be extended or replaced via env", async () => {
    const server = await startHosted({ NEXTCLOUD_URL: nc.base, NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS: "https://app.example.com/oauth/callback" });
    try {
      const evil = await registerRaw(server.base, "https://attacker.example/steal");
      assert.equal(evil.status, 400);
      assert.equal((await evil.json()).error, "invalid_redirect_uri");
      // Look-alikes of allowed hosts do not pass.
      for (const uri of ["https://claude.ai.attacker.example/api/mcp/auth_callback", "http://localhost.attacker.example/cb", "https://claude.ai/other"]) {
        assert.equal((await registerRaw(server.base, uri)).status, 400, uri);
      }
      for (const uri of [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
        "http://localhost:53682/callback",
        "http://127.0.0.1:8080/",
        "https://app.example.com/oauth/callback",
      ]) {
        assert.equal((await registerRaw(server.base, uri)).status, 201, uri);
      }
    } finally {
      server.stop();
    }
    const strict = await startHosted({
      NEXTCLOUD_URL: nc.base,
      NEXTCLOUD_MCP_DEFAULT_REDIRECT_URIS: "false",
      NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback",
    });
    try {
      assert.equal((await registerRaw(strict.base, "http://localhost:53682/callback")).status, 400);
      assert.equal((await registerRaw(strict.base, "https://claude.ai/api/mcp/auth_callback")).status, 201);
    } finally {
      strict.stop();
    }
  });

  it("refuses /authorize for clients registered before the list was narrowed — without redirecting", async () => {
    const loose = await startHosted({ NEXTCLOUD_URL: nc.base, NEXTCLOUD_MCP_ALLOWED_REDIRECT_URIS: "https://old.example/cb" });
    const clientId = (await (await registerRaw(loose.base, "https://old.example/cb")).json()).client_id;
    loose.stop({ keepData: true });
    await new Promise((r) => setTimeout(r, 300));
    const narrowed = await startHosted({ NEXTCLOUD_URL: nc.base }, { dir: loose.dir, port: loose.port });
    try {
      const url = new URL(`${narrowed.base}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://old.example/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      }).toString();
      const res = await fetch(url, { redirect: "manual" });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    } finally {
      narrowed.stop();
    }
  });

  it("shows who asks before anything goes to Nextcloud, and the consent cannot be forged cross-site", async () => {
    const server = await startHosted({ NEXTCLOUD_URL: nc.base });
    try {
      const clientId = await register(server.base);
      const { connectUrl } = await beginAuthorization(server.base, clientId);
      const page = await fetch(connectUrl);
      const html = await page.text();
      assert.match(html, /“test client”/);
      assert.match(html, /your own computer<\/b> \(localhost:9999\)/);
      assert.doesNotMatch(html, /login\/v2\/flow/, "no Nextcloud login before consent");
      assert.equal(nc.state.flows.size, 0, "no login flow started before consent");
      const setCookie = page.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^ncmcp_browser=[A-Za-z0-9_-]{43}; Max-Age=86400; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
      const attackerCookie = /ncmcp_browser=[^;]+/.exec(setCookie)[0];
      const attackerToken = /name="csrf" value="([^"]+)"/.exec(html)[1];

      // The attacker started /authorize, so they can open the page and read a token — for THEIR browser.
      const victimPage = await fetch(connectUrl);
      const victimCookie = /ncmcp_browser=[^;]+/.exec(victimPage.headers.get("set-cookie") ?? "")[0];
      const victimToken = /name="csrf" value="([^"]+)"/.exec(await victimPage.text())[1];
      const post = (cookie, csrf) =>
        fetch(`${connectUrl}/consent`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
          body: new URLSearchParams({ csrf }),
        });
      assert.equal((await post(undefined, attackerToken)).status, 403, "no cookie (cross-site, or cookie blocked)");
      assert.equal((await post(victimCookie, attackerToken)).status, 403, "attacker's token with the victim's cookie");
      assert.equal((await post(attackerCookie, victimToken)).status, 403, "token of another browser");
      assert.equal((await post("ncmcp_browser=short", attackerToken)).status, 403, "malformed nonce");
      const stillConsent = await (await fetch(connectUrl)).text();
      assert.match(stillConsent, /Allow access to your Nextcloud/);
      assert.equal((await post(victimCookie, victimToken)).status, 303, "the right browser can consent");
    } finally {
      server.stop();
    }
  });
});

describe("hosted mode over https: the consent cookie cannot be planted by a sibling subdomain", () => {
  it("uses a __Host- cookie (Secure, Path=/, no Domain)", async () => {
    const nc = await startFakeNextcloud();
    const port = await freePort();
    const publicUrl = `https://127.0.0.1:${port}`;
    const server = await startHosted({ NEXTCLOUD_URL: nc.base, NEXTCLOUD_MCP_PUBLIC_URL: publicUrl }, { port });
    try {
      const plain = `http://127.0.0.1:${port}`; // requested directly, as a TLS proxy would
      const registered = await fetch(`${plain}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
      });
      const clientId = (await registered.json()).client_id;
      const url = new URL(`${plain}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        resource: `${publicUrl}/mcp`,
      }).toString();
      const res = await fetch(url, { redirect: "manual" });
      const page = await fetch(new URL(res.headers.get("location"), plain));
      const setCookie = page.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^__Host-ncmcp_browser=[A-Za-z0-9_-]{43}; Max-Age=86400; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/);
      assert.doesNotMatch(setCookie, /Domain=/i);
    } finally {
      server.stop();
      nc.close();
    }
  });
});
