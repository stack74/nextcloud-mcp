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

async function startHosted(env) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "nc-mcp-hosted-"));
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
    stop() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Registers an MCP client and starts /authorize; returns the sign-in page URL and the PKCE verifier. */
async function beginAuthorization(base, clientId) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: `${base}/mcp`,
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302);
  return { connectUrl: new URL(res.headers.get("location"), base).href, verifier };
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
      assert.match(bob.page, /nicht freigeschaltet/);
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
