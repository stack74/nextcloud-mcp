/**
 * A small in-memory Nextcloud for tests: WebDAV (PROPFIND, SEARCH, GET, PUT,
 * MKCOL, MOVE, COPY, DELETE, trash bin), OCS (user, unified search, app
 * password deletion), previews, Login Flow v2 and the oauth2 app.
 *
 * Only what the server under test uses, but on the real wire format.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const xmlEscape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

export async function startFakeNextcloud(options = {}) {
  const users = options.users ?? {
    alice: { login: "alice@example.com", displayname: "Alice Example", groups: ["staff"], email: "alice@example.com" },
    bob: { login: "bob", displayname: "Bob", groups: ["guests"], email: null },
  };
  const state = {
    files: new Map(), // `${user}:${path}` -> node
    trash: new Map(), // `${user}:${trashId}` -> { node, path, deletedAt }
    appPasswords: new Map(), // password -> user
    bearer: new Map(), // access token -> user
    refresh: new Map(), // refresh token -> user
    flows: new Map(), // poll token -> { loginToken, user|null, used }
    codes: new Map(), // oauth code -> user
    requests: [],
    revoked: [],
    refreshCount: 0,
    oauthClient: options.oauthClient ?? { id: "nc-client", secret: "nc-secret", redirect: null },
    accessTtl: options.accessTtl ?? 3600,
  };
  let nextId = 100;

  const node = (type, data = Buffer.alloc(0), mime) => ({
    type,
    data: Buffer.from(data),
    mime: type === "folder" ? "httpd/unix-directory" : (mime ?? "application/octet-stream"),
    mtime: Date.now(),
    id: nextId++,
    favorite: false,
  });
  const key = (user, path) => `${user}:${path}`;
  const parent = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

  /** Adds a file (and its parent folders) for a user. */
  function addFile(user, path, data, mime, extra = {}) {
    const segments = path.split("/").filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      const p = segments.slice(0, i).join("/");
      if (!state.files.has(key(user, p))) state.files.set(key(user, p), node("folder"));
    }
    const n = { ...node("file", data, mime), ...extra };
    state.files.set(key(user, segments.join("/")), n);
    return n;
  }
  for (const user of Object.keys(users)) state.files.set(key(user, ""), node("folder"));

  function children(user, path) {
    const prefix = path ? `${path}/` : "";
    const out = [];
    for (const [k, n] of state.files) {
      if (!k.startsWith(`${user}:`)) continue;
      const p = k.slice(user.length + 1);
      if (p === path || !p.startsWith(prefix)) continue;
      if (p.slice(prefix.length).includes("/")) continue;
      out.push([p, n]);
    }
    return out;
  }
  function descendants(user, path) {
    const prefix = path ? `${path}/` : "";
    return [...state.files.keys()].filter((k) => k.startsWith(`${user}:${prefix}`) && k !== key(user, path)).map((k) => k.slice(user.length + 1));
  }
  const sizeOf = (user, path, n) => (n.type === "file" ? n.data.length : descendants(user, path).reduce((s, p) => s + (state.files.get(key(user, p)).type === "file" ? state.files.get(key(user, p)).data.length : 0), 0));

  function propXml(user, path, n) {
    const href = `/remote.php/dav/files/${encodeURIComponent(user)}/${encodePath(path)}${n.type === "folder" && path ? "/" : ""}`;
    return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>
<d:getlastmodified>${new Date(n.mtime).toUTCString()}</d:getlastmodified>
${n.type === "file" ? `<d:getcontentlength>${n.data.length}</d:getcontentlength>` : ""}
<d:getcontenttype>${xmlEscape(n.mime)}</d:getcontenttype>
<d:resourcetype>${n.type === "folder" ? "<d:collection/>" : ""}</d:resourcetype>
<d:getetag>"etag${n.id}"</d:getetag>
<oc:fileid>${n.id}</oc:fileid><oc:size>${sizeOf(user, path, n)}</oc:size><oc:permissions>RGDNVW${n.type === "folder" ? "CK" : ""}</oc:permissions>
<oc:favorite>${n.favorite ? 1 : 0}</oc:favorite><oc:owner-display-name>${xmlEscape(users[user].displayname)}</oc:owner-display-name>
<nc:has-preview>${n.mime.startsWith("image/") || n.mime === "application/pdf" ? "true" : "false"}</nc:has-preview>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
<d:propstat><d:prop><nc:mount-type/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
  }
  const multistatus = (body) =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${body}</d:multistatus>`;

  function authUser(req) {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      const [login, ...rest] = Buffer.from(header.slice(6), "base64").toString().split(":");
      const password = rest.join(":");
      const user = state.appPasswords.get(password);
      if (user && (users[user].login === login || user === login)) return { user, token: password };
      return null;
    }
    if (header.startsWith("Bearer ")) {
      const entry = state.bearer.get(header.slice(7));
      if (entry && entry.expires > Date.now()) return { user: entry.user, token: header.slice(7) };
    }
    return null;
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ocs = (res, data, status = 200) => json(res, status, { ocs: { meta: { status: "ok", statuscode: status }, data } });

  function issueOAuth(user) {
    const access = randomBytes(12).toString("hex");
    const refresh = randomBytes(12).toString("hex");
    state.bearer.set(access, { user, expires: Date.now() + state.accessTtl * 1000 });
    state.refresh.set(refresh, user);
    return { access_token: access, token_type: "Bearer", expires_in: state.accessTtl, refresh_token: refresh, user_id: user };
  }

  /** Very small SEARCH evaluator: displayname/getcontenttype like/eq, not, size lte, lastmodified gte/lt. */
  function evaluate(where, path, n) {
    const name = path.split("/").pop() ?? "";
    const like = (value, pattern) => new RegExp(`^${pattern.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(value);
    const valueOf = (prop) =>
      prop === "displayname" ? name : prop === "getcontenttype" ? n.mime : prop === "size" ? n.data.length : prop === "getlastmodified" ? Math.floor(n.mtime / 1000) : prop === "favorite" ? n.favorite : undefined;
    const ev = (xml) => {
      const m = /^<d:(\w+(?:-\w+)?)>([\s\S]*)<\/d:\1>$/.exec(xml.trim());
      if (!m) return true;
      const [, op, inner] = m;
      if (op === "and" || op === "or") {
        const parts = splitTop(inner);
        return op === "and" ? parts.every(ev) : parts.some(ev);
      }
      if (op === "not") return !ev(inner);
      const prop = /<d:prop><(?:\w+:)?([\w-]+)\/><\/d:prop>/.exec(inner)?.[1];
      const literal = /<d:literal>([\s\S]*?)<\/d:literal>/.exec(inner)?.[1]?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const actual = valueOf(prop);
      if (prop === "favorite") return (literal === "yes") === actual;
      // Like Nextcloud's SearchBuilder: a MIME type is "type/subtype" or "type/%", nothing else.
      if (prop === "getcontenttype" && op === "like" && literal.includes("%") && !/^[^%]+\/%$/.test(literal)) {
        throw new Error(`Unsupported query value for mimetype: ${literal}, only values in the format "mime/type" or "mime/%" are supported`);
      }
      switch (op) {
        case "like": return like(String(actual), literal);
        case "eq": return String(actual) === literal;
        case "lte": return Number(actual) <= Number(literal);
        case "lt": return Number(actual) < Number(literal);
        case "gte": return Number(actual) >= Number(literal);
        case "gt": return Number(actual) > Number(literal);
        default: return true;
      }
    };
    return ev(where);
  }
  /** Splits "<d:a>..</d:a><d:b>..</d:b>" into top-level elements. */
  function splitTop(xml) {
    const parts = [];
    let depth = 0;
    let start = 0;
    const re = /<(\/?)d:([\w-]+)(\/?)>/g;
    let m;
    while ((m = re.exec(xml))) {
      if (m[3]) continue;
      if (!m[1]) {
        if (depth === 0) start = m.index;
        depth++;
      } else {
        depth--;
        if (depth === 0) parts.push(xml.slice(start, re.lastIndex));
      }
    }
    return parts;
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    const p = url.pathname;

    if (p === "/status.php") return json(res, 200, { installed: true, versionstring: "35.0.3" });

    // --- Login Flow v2
    if (p === "/index.php/login/v2" && req.method === "POST") {
      const poll = randomBytes(8).toString("hex");
      const login = randomBytes(8).toString("hex");
      state.flows.set(poll, { loginToken: login, user: null, used: false, userAgent: req.headers["user-agent"] });
      return json(res, 200, { poll: { token: poll, endpoint: `${base}/index.php/login/v2/poll` }, login: `${base}/index.php/login/v2/flow/${login}` });
    }
    const flowMatch = /^\/index\.php\/login\/v2\/flow\/(\w+)$/.exec(p);
    if (flowMatch) {
      // Tests "log in" by requesting the flow URL with ?as=<user>.
      for (const flow of state.flows.values()) if (flow.loginToken === flowMatch[1]) flow.user = url.searchParams.get("as");
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("Account connected");
    }
    if (p === "/index.php/login/v2/poll" && req.method === "POST") {
      const token = new URLSearchParams(body.toString()).get("token");
      const flow = state.flows.get(token);
      if (!flow || !flow.user || flow.used) return json(res, 404, []);
      flow.used = true;
      const password = `app-${randomBytes(10).toString("hex")}`;
      state.appPasswords.set(password, flow.user);
      return json(res, 200, { server: base, loginName: users[flow.user].login, appPassword: password });
    }

    // --- oauth2 app
    if (p === "/index.php/apps/oauth2/authorize") {
      const client = state.oauthClient;
      if (url.searchParams.get("client_id") !== client.id) return json(res, 404, {});
      const user = url.searchParams.get("as") ?? "alice";
      const code = randomBytes(8).toString("hex");
      state.codes.set(code, user);
      const back = new URL(client.redirect ?? url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (p === "/index.php/apps/oauth2/api/v1/token" && req.method === "POST") {
      const params = new URLSearchParams(body.toString());
      if (params.get("client_id") !== state.oauthClient.id || params.get("client_secret") !== state.oauthClient.secret) {
        return json(res, 400, { error: "invalid_client" });
      }
      if (params.get("grant_type") === "authorization_code") {
        const user = state.codes.get(params.get("code"));
        state.codes.delete(params.get("code"));
        if (!user) return json(res, 400, { error: "invalid_request" });
        return json(res, 200, issueOAuth(user));
      }
      if (params.get("grant_type") === "refresh_token") {
        const user = state.refresh.get(params.get("refresh_token"));
        if (!user) return json(res, 400, { error: "invalid_request" });
        state.refresh.delete(params.get("refresh_token"));
        state.refreshCount++;
        return json(res, 200, issueOAuth(user));
      }
      return json(res, 400, { error: "invalid_grant" });
    }

    // --- everything below needs a login
    const auth = authUser(req);
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/xml" });
      return res.end('<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>No public access</s:message></d:error>');
    }
    const user = auth.user;

    if (p === "/ocs/v2.php/cloud/user") {
      const u = users[user];
      return ocs(res, { id: user, displayname: u.displayname, email: u.email, groups: u.groups, quota: { used: 1234, free: 10_000, total: 11_234, quota: 11_234 } });
    }
    if (p === "/ocs/v2.php/core/apppassword" && req.method === "DELETE") {
      state.revoked.push(auth.token);
      state.appPasswords.delete(auth.token);
      state.bearer.delete(auth.token);
      return ocs(res, []);
    }
    if (p === "/ocs/v2.php/search/providers") return ocs(res, [{ id: "files", name: "Files" }, { id: "calendar", name: "Calendar" }]);
    const providerMatch = /^\/ocs\/v2\.php\/search\/providers\/(\w+)\/search$/.exec(p);
    if (providerMatch) {
      const term = url.searchParams.get("term") ?? "";
      const entries =
        providerMatch[1] === "files"
          ? [...state.files.entries()]
              .filter(([k]) => k.startsWith(`${user}:`) && k.toLowerCase().includes(term.toLowerCase()))
              .map(([k]) => ({ title: k.split("/").pop(), subline: k, resourceUrl: "/index.php/f/1" }))
          : [];
      return ocs(res, { name: providerMatch[1], isPaginated: false, entries });
    }
    if (p === "/index.php/core/preview") {
      const id = Number(url.searchParams.get("fileId"));
      const found = [...state.files.values()].find((n) => n.id === id);
      if (!found || !(found.mime.startsWith("image/") || found.mime === "application/pdf")) return json(res, 404, {});
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG);
    }

    // --- trash bin
    const trashPrefix = `/remote.php/dav/trashbin/${encodeURIComponent(user)}/trash`;
    if (p === trashPrefix && req.method === "PROPFIND") {
      let out = `<d:response><d:href>${trashPrefix}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      for (const [k, t] of state.trash) {
        if (!k.startsWith(`${user}:`)) continue;
        const id = k.slice(user.length + 1);
        out += `<d:response><d:href>${trashPrefix}/${encodeURIComponent(id)}</d:href><d:propstat><d:prop>
<nc:trashbin-filename>${xmlEscape(t.path.split("/").pop())}</nc:trashbin-filename><nc:trashbin-original-location>${xmlEscape(t.path)}</nc:trashbin-original-location>
<nc:trashbin-deletion-time>${Math.floor(t.deletedAt / 1000)}</nc:trashbin-deletion-time><d:getcontentlength>${t.node.data.length}</d:getcontentlength>
<d:getcontenttype>${t.node.mime}</d:getcontenttype><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      }
      res.writeHead(207, { "Content-Type": "application/xml" });
      return res.end(multistatus(out));
    }
    if (p.startsWith(`${trashPrefix}/`) && req.method === "MOVE") {
      const id = decodeURIComponent(p.slice(trashPrefix.length + 1));
      const t = state.trash.get(key(user, id));
      if (!t) return json(res, 404, {});
      state.trash.delete(key(user, id));
      state.files.set(key(user, t.path), t.node);
      for (const [sub, n] of t.children ?? []) state.files.set(key(user, sub), n);
      res.writeHead(201);
      return res.end();
    }

    // --- SEARCH
    if (p === "/remote.php/dav/" && req.method === "SEARCH") {
      const xml = body.toString();
      const scope = /<d:href>([^<]*)<\/d:href>/.exec(xml)[1].replace(/&amp;/g, "&");
      const scopeMatch = /^\/files\/([^/]+)\/?(.*)$/.exec(scope);
      if (!scopeMatch || scopeMatch[1] !== user) return json(res, 400, {});
      const scopePath = scopeMatch[2].replace(/\/+$/, "");
      const where = /<d:where>([\s\S]*)<\/d:where>/.exec(xml)[1];
      const limit = Number(/<d:nresults>(\d+)<\/d:nresults>/.exec(xml)?.[1] ?? 100);
      const offset = Number(/<ns:firstresult>(\d+)<\/ns:firstresult>/.exec(xml)?.[1] ?? 0);
      const descending = /<d:descending\/>/.test(xml);
      const orderProp = /<d:order><d:prop><(?:\w+:)?([\w-]+)\/>/.exec(xml)?.[1] ?? "getlastmodified";
      let hits;
      try {
        hits = descendants(user, scopePath)
          .map((path) => [path, state.files.get(key(user, path))])
          .filter(([path, n]) => evaluate(where, path, n));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/xml" });
        return res.end(`<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>${xmlEscape(error.message)}</s:message></d:error>`);
      }
      const sortValue = ([path, n]) => (orderProp === "displayname" ? path.split("/").pop() : orderProp === "size" ? n.data.length : n.mtime);
      hits.sort((a, b) => (sortValue(a) < sortValue(b) ? -1 : sortValue(a) > sortValue(b) ? 1 : 0) * (descending ? -1 : 1));
      res.writeHead(207, { "Content-Type": "application/xml" });
      return res.end(multistatus(hits.slice(offset, offset + limit).map(([path, n]) => propXml(user, path, n)).join("")));
    }

    // --- files
    const filesPrefix = `/remote.php/dav/files/${encodeURIComponent(user)}`;
    if (p === filesPrefix || p.startsWith(`${filesPrefix}/`)) {
      const path = decodeURIComponent(p.slice(filesPrefix.length)).replace(/^\/+|\/+$/g, "");
      const n = state.files.get(key(user, path));
      const destPath = () => {
        const dest = new URL(req.headers.destination);
        return decodeURIComponent(dest.pathname.slice(filesPrefix.length)).replace(/^\/+|\/+$/g, "");
      };
      switch (req.method) {
        case "PROPFIND": {
          if (!n) return json(res, 404, {});
          let out = propXml(user, path, n);
          if (req.headers.depth === "1" && n.type === "folder") out += children(user, path).map(([cp, cn]) => propXml(user, cp, cn)).join("");
          res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
          return res.end(multistatus(out));
        }
        case "GET": {
          if (!n || n.type !== "file") return json(res, 404, {});
          res.writeHead(200, { "Content-Type": n.mime, "Content-Length": n.data.length });
          return res.end(n.data);
        }
        case "PUT": {
          if (!state.files.has(key(user, parent(path)))) return json(res, 409, {});
          if (n && req.headers["if-none-match"] === "*") return json(res, 412, {});
          const existed = Boolean(n);
          const created = node("file", body, (req.headers["content-type"] ?? "").split(";")[0] || undefined);
          if (n) created.id = n.id;
          state.files.set(key(user, path), created);
          res.writeHead(existed ? 204 : 201);
          return res.end();
        }
        case "MKCOL": {
          if (n) return json(res, 405, {});
          if (!state.files.has(key(user, parent(path)))) return json(res, 409, {});
          state.files.set(key(user, path), node("folder"));
          res.writeHead(201);
          return res.end();
        }
        case "MOVE":
        case "COPY": {
          if (!n) return json(res, 404, {});
          const dest = destPath();
          if (!state.files.has(key(user, parent(dest)))) return json(res, 409, {});
          const exists = state.files.has(key(user, dest));
          if (exists && req.headers.overwrite === "F") return json(res, 412, {});
          const moved = [path, ...descendants(user, path)];
          for (const src of moved) {
            const target = dest + src.slice(path.length);
            const sn = state.files.get(key(user, src));
            state.files.set(key(user, target), req.method === "COPY" ? { ...sn, id: nextId++ } : sn);
            if (req.method === "MOVE") state.files.delete(key(user, src));
          }
          res.writeHead(exists ? 204 : 201);
          return res.end();
        }
        case "DELETE": {
          if (!n) return json(res, 404, {});
          const subs = descendants(user, path).map((sp) => [sp, state.files.get(key(user, sp))]);
          for (const [sp] of subs) state.files.delete(key(user, sp));
          state.files.delete(key(user, path));
          state.trash.set(key(user, `${path.split("/").pop()}.d${Math.floor(Date.now() / 1000)}`), { node: n, path, deletedAt: Date.now(), children: subs });
          res.writeHead(204);
          return res.end();
        }
      }
    }
    json(res, 404, { message: `fake: no route ${req.method} ${p}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    state,
    users,
    addFile,
    /** Creates an app password for a user, as if made in Settings -> Security. */
    appPassword(user) {
      const password = `app-${randomBytes(10).toString("hex")}`;
      state.appPasswords.set(password, user);
      return password;
    },
    get(user, path) {
      return state.files.get(key(user, path));
    },
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
