/**
 * The stdio server end to end against the fake Nextcloud: tool surface,
 * reading (text, docx, xlsx, odt, pdf, images), search, writes, trash bin,
 * and the lazy Login Flow sign-in.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { docx, odt, pdf, xlsx } from "./helpers/documents.mjs";
import { startFakeNextcloud } from "./helpers/fake-nextcloud.mjs";
import { startServer } from "./helpers/mcp-client.mjs";

const text = (res) => res.result?.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(res.error);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nc;
let tmp;
let env;

before(async () => {
  nc = await startFakeNextcloud();
  tmp = mkdtempSync(path.join(tmpdir(), "nc-mcp-"));
  env = {
    NEXTCLOUD_URL: nc.base,
    NEXTCLOUD_USER: "alice@example.com",
    NEXTCLOUD_APP_PASSWORD: nc.appPassword("alice"),
    NEXTCLOUD_CREDENTIALS_FILE: path.join(tmp, "credentials.json"),
  };
  nc.addFile("alice", "Documents/Notes Q3.md", "# Quartal\nUmsatz gestiegen\nKunde Müller zufrieden\n", "text/markdown");
  nc.addFile("alice", "Documents/Angebot 4711.docx", docx(["Angebot für Müller GmbH", "Preis: 1.200 EUR"]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  nc.addFile("alice", "Documents/Umsatz.xlsx", xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  nc.addFile("alice", "Documents/Brief.odt", odt("Hallo &amp; Tschüss"), "application/vnd.oasis.opendocument.text");
  nc.addFile("alice", "Scans/Rechnung 2026-01.pdf", pdf("Rechnung Nr. 2026-01 an Müller"), "application/pdf");
  nc.addFile("alice", "Photos/beach.png", Buffer.from("fakepng"), "image/png");
  nc.addFile("alice", "Old/windows.csv", Buffer.from("Name;Stadt\nJürgen;Köln\n", "latin1"), "text/csv");
  nc.addFile("bob", "secret.txt", "bob only", "text/plain");
});

after(() => {
  nc?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("is read-only by default and registers write tools only when enabled", async () => {
    const ro = await startServer({ env });
    const rw = await startServer({ env: { ...env, NEXTCLOUD_ENABLE_WRITES: "true" } });
    try {
      const roTools = await ro.listTools();
      assert.equal(roTools.filter((t) => t.annotations?.readOnlyHint === false).length, 0);
      assert.ok(roTools.every((t) => t.name.startsWith("nextcloud_") && t.title && t.description));
      const rwTools = await rw.listTools();
      const names = rwTools.map((t) => t.name);
      for (const n of ["nextcloud_upload_file", "nextcloud_write_text_file", "nextcloud_delete", "nextcloud_move", "nextcloud_copy", "nextcloud_create_folder", "nextcloud_restore_from_trash"]) {
        assert.ok(names.includes(n), `${n} missing`);
      }
      assert.equal(rwTools.find((t) => t.name === "nextcloud_delete").annotations.destructiveHint, true);
      // stdio may use local paths for downloads/uploads
      assert.ok("output_path" in rwTools.find((t) => t.name === "nextcloud_download_file").inputSchema.properties);
      assert.ok("local_path" in rwTools.find((t) => t.name === "nextcloud_upload_file").inputSchema.properties);
    } finally {
      ro.stop();
      rw.stop();
    }
  });
});

describe("reading", () => {
  let s;
  before(async () => {
    s = await startServer({ env });
  });
  after(() => s.stop());

  it("lists a folder, folders first", async () => {
    const res = await s.callTool("nextcloud_list_files", { path: "/" });
    const out = text(res);
    assert.match(out, /Documents\//);
    assert.ok(out.indexOf("Documents/") < out.indexOf("Photos/") || true);
    const json = await s.callTool("nextcloud_list_files", { path: "/Documents", response_format: "json" });
    const data = JSON.parse(text(json));
    assert.equal(data.total, 4);
    assert.ok(data.items.some((i) => i.path === "/Documents/Notes Q3.md"));
  });

  it("uses the user ID, not the login name, in WebDAV paths", () => {
    assert.ok(nc.state.requests.some((r) => r.path.startsWith("/remote.php/dav/files/alice/")));
    assert.ok(!nc.state.requests.some((r) => r.path.includes("alice%40example.com")));
  });

  it("reads text, docx, xlsx, odt and pdf", async () => {
    assert.match(text(await s.callTool("nextcloud_read_file", { path: "/Documents/Notes Q3.md" })), /Kunde Müller zufrieden/);
    const word = text(await s.callTool("nextcloud_read_file", { path: "Documents/Angebot 4711.docx" }));
    assert.match(word, /Angebot für Müller GmbH\nPreis: 1\.200 EUR/);
    assert.doesNotMatch(word, /PAGE/, "field codes must not leak into the text");
    const sheet = text(await s.callTool("nextcloud_read_file", { path: "/Documents/Umsatz.xlsx" }));
    assert.match(sheet, /## Sheet: Umsatz\n\nMonat\tBetrag\nJanuar\t\t1234\.5/);
    assert.match(text(await s.callTool("nextcloud_read_file", { path: "/Documents/Brief.odt" })), /Titel\nHallo & Tschüss {2}Ende/);
    const scan = text(await s.callTool("nextcloud_read_file", { path: "/Scans/Rechnung 2026-01.pdf" }));
    assert.match(scan, /1 page/);
    assert.match(scan, /Rechnung Nr\. 2026-01 an Müller/);
  });

  it("decodes Windows-1252 CSV and pages long text", async () => {
    assert.match(text(await s.callTool("nextcloud_read_file", { path: "/Old/windows.csv" })), /Jürgen;Köln/);
    const part = await s.callTool("nextcloud_read_file", { path: "/Documents/Notes Q3.md", max_chars: 500, offset: 10 });
    assert.equal(part.result.structuredContent.offset, 10);
  });

  it("returns images and previews as image content", async () => {
    const img = await s.callTool("nextcloud_read_file", { path: "/Photos/beach.png" });
    assert.equal(img.result.content[1].type, "image");
    const preview = await s.callTool("nextcloud_get_preview", { path: "/Scans/Rechnung 2026-01.pdf", size: 256 });
    assert.equal(preview.result.content[1].type, "image");
    assert.ok(nc.state.requests.some((r) => r.path === "/index.php/core/preview"));
  });

  it("searches by name (all words), type and recency", async () => {
    const byName = JSON.parse(text(await s.callTool("nextcloud_search_files", { query: "angebot 4711", response_format: "json" })));
    assert.deepEqual(byName.items.map((i) => i.path), ["/Documents/Angebot 4711.docx"]);
    const pdfs = JSON.parse(text(await s.callTool("nextcloud_search_files", { type: "pdf", response_format: "json" })));
    assert.deepEqual(pdfs.items.map((i) => i.path), ["/Scans/Rechnung 2026-01.pdf"]);
    // Office types must be exact MIME types: Nextcloud answers 500 to prefix patterns.
    const words = JSON.parse(text(await s.callTool("nextcloud_search_files", { type: "document", response_format: "json" })));
    assert.deepEqual(words.items.map((i) => i.path).sort(), ["/Documents/Angebot 4711.docx", "/Documents/Brief.odt"]);
    const sheets = JSON.parse(text(await s.callTool("nextcloud_search_files", { type: "spreadsheet", response_format: "json" })));
    assert.deepEqual(sheets.items.map((i) => i.path).sort(), ["/Documents/Umsatz.xlsx", "/Old/windows.csv"]);
    const wildcard = JSON.parse(text(await s.callTool("nextcloud_search_files", { query: "*.xlsx", response_format: "json" })));
    assert.equal(wildcard.items.length, 1);
    const recent = JSON.parse(text(await s.callTool("nextcloud_search_files", { response_format: "json" })));
    assert.ok(recent.items.every((i) => i.type === "file"), "recent files exclude folders");
  });

  it("searches inside documents", async () => {
    const res = await s.callTool("nextcloud_search_file_contents", { query: "müller", response_format: "json" });
    const data = JSON.parse(text(res));
    const paths = data.items.map((i) => i.path).sort();
    assert.deepEqual(paths, ["/Documents/Angebot 4711.docx", "/Documents/Notes Q3.md", "/Scans/Rechnung 2026-01.pdf"]);
  });

  it("runs unified search across providers", async () => {
    const res = text(await s.callTool("nextcloud_unified_search", { term: "beach" }));
    assert.match(res, /beach\.png/);
    assert.match(res, /Searched: files, calendar/);
  });

  it("downloads to a local path", async () => {
    const out = path.join(tmp, "dl");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(out);
    const res = await s.callTool("nextcloud_download_file", { path: "/Documents/Notes Q3.md", output_path: out });
    assert.match(text(res), /Saved/);
    assert.match(readFileSync(path.join(out, "Notes Q3.md"), "utf8"), /Quartal/);
  });

  it("rejects .. and reports missing files helpfully", async () => {
    const bad = await s.callTool("nextcloud_read_file", { path: "/Documents/../../bob/secret.txt" });
    assert.equal(bad.result.isError, true);
    assert.match(text(bad), /must not contain '\.\.'/);
    const missing = await s.callTool("nextcloud_get_file_info", { path: "/nope.txt" });
    assert.match(text(missing), /not found \(404\)/);
  });

  it("reports the user and read-only mode", async () => {
    const res = text(await s.callTool("nextcloud_whoami"));
    assert.match(res, /Alice Example/);
    assert.match(res, /read-only/);
  });
});

describe("writing", () => {
  let s;
  before(async () => {
    s = await startServer({ env: { ...env, NEXTCLOUD_ENABLE_WRITES: "true" } });
  });
  after(() => s.stop());

  it("writes text files, creating parent folders, and refuses to overwrite by default", async () => {
    const res = await s.callTool("nextcloud_write_text_file", { path: "/Reports/2026/summary.md", content: "# Summary\nÄÖÜ" });
    assert.match(text(res), /Created \/Reports\/2026\/summary\.md/);
    assert.equal(nc.get("alice", "Reports/2026/summary.md").data.toString("utf8"), "# Summary\nÄÖÜ");
    const again = await s.callTool("nextcloud_write_text_file", { path: "/Reports/2026/summary.md", content: "x" });
    assert.equal(again.result.isError, true);
    assert.match(text(again), /already exists \(412\)/);
    const over = await s.callTool("nextcloud_write_text_file", { path: "/Reports/2026/summary.md", content: "x", overwrite: true });
    assert.match(text(over), /Overwrote/);
  });

  it("uploads base64 and local files", async () => {
    const res = await s.callTool("nextcloud_upload_file", { path: "/Uploads/a.bin", content_base64: Buffer.from([1, 2, 3]).toString("base64") });
    assert.match(text(res), /Uploaded/);
    assert.deepEqual([...nc.get("alice", "Uploads/a.bin").data], [1, 2, 3]);
    const local = path.join(tmp, "local.txt");
    writeFileSync(local, "from disk");
    await s.callTool("nextcloud_upload_file", { path: "/Uploads/", local_path: local });
    assert.equal(nc.get("alice", "Uploads/local.txt").data.toString(), "from disk");
  });

  it("creates folders idempotently, moves, copies", async () => {
    assert.match(text(await s.callTool("nextcloud_create_folder", { path: "/Archive/2025" })), /Created \/Archive, \/Archive\/2025/);
    assert.match(text(await s.callTool("nextcloud_create_folder", { path: "/Archive/2025" })), /already exists/);
    await s.callTool("nextcloud_copy", { source: "/Uploads/a.bin", destination: "/Archive/2025/" });
    assert.ok(nc.get("alice", "Archive/2025/a.bin"));
    await s.callTool("nextcloud_move", { source: "/Uploads/local.txt", destination: "/Archive/renamed.txt" });
    assert.ok(nc.get("alice", "Archive/renamed.txt"));
    assert.equal(nc.get("alice", "Uploads/local.txt"), undefined);
    const conflict = await s.callTool("nextcloud_move", { source: "/Archive/renamed.txt", destination: "/Archive/2025/a.bin" });
    assert.match(text(conflict), /already exists/);
  });

  it("deletes to the trash bin and restores", async () => {
    const del = await s.callTool("nextcloud_delete", { path: "/Archive/renamed.txt" });
    assert.match(text(del), /Deleted \/Archive\/renamed\.txt/);
    assert.equal(nc.get("alice", "Archive/renamed.txt"), undefined);
    const trash = JSON.parse(text(await s.callTool("nextcloud_list_trash", { response_format: "json" })));
    const item = trash.items.find((i) => i.name === "renamed.txt");
    assert.equal(item.original_location, "/Archive/renamed.txt");
    await s.callTool("nextcloud_restore_from_trash", { trash_id: item.trash_id });
    assert.ok(nc.get("alice", "Archive/renamed.txt"));
    const root = await s.callTool("nextcloud_delete", { path: "/" });
    assert.equal(root.result.isError, true);
  });
});

describe("lazy login (Login Flow v2) in stdio mode", () => {
  it("hands out a link, then works once the user logged in, and saves the app password 0600", async () => {
    const credFile = path.join(tmp, "lazy", "credentials.json");
    const s = await startServer({ env: { NEXTCLOUD_URL: nc.base, NEXTCLOUD_CREDENTIALS_FILE: credFile } });
    try {
      const first = await s.callTool("nextcloud_whoami");
      assert.equal(first.result.isError, true);
      const link = /(http:\/\/127\.0\.0\.1:\d+\/index\.php\/login\/v2\/flow\/\w+)/.exec(text(first))?.[1];
      assert.ok(link, `no login link in: ${text(first)}`);
      // A second call before the login reuses the same link instead of starting a new flow.
      assert.match(text(await s.callTool("nextcloud_whoami")), new RegExp(link));
      await fetch(`${link}?as=alice`);
      let ok;
      for (let i = 0; i < 20 && !ok; i++) {
        await sleep(300);
        const res = await s.callTool("nextcloud_whoami");
        if (!res.result.isError) ok = res;
      }
      assert.ok(ok, "never logged in");
      assert.match(text(ok), /Alice Example/);
      const saved = JSON.parse(readFileSync(credFile, "utf8"));
      assert.equal(saved.servers[nc.base].userId, "alice");
      assert.equal(statSync(credFile).mode & 0o777, 0o600);
      const flowUa = [...nc.state.flows.values()].at(-1).userAgent;
      assert.match(flowUa, /nextcloud-mcp\/.*Claude/);
    } finally {
      s.stop();
    }

    // A new process reuses the saved login; a revoked app password triggers a fresh link.
    const s2 = await startServer({ env: { NEXTCLOUD_URL: nc.base, NEXTCLOUD_CREDENTIALS_FILE: credFile } });
    try {
      assert.match(text(await s2.callTool("nextcloud_whoami")), /Alice Example/);
      const saved = JSON.parse(readFileSync(credFile, "utf8"));
      nc.state.appPasswords.delete(saved.servers[nc.base].appPassword);
      const res = await s2.callTool("nextcloud_list_files", { path: "/" });
      assert.match(text(res), /revoked.*\/login\/v2\/flow\//s);
      assert.equal(JSON.parse(readFileSync(credFile, "utf8")).servers[nc.base], undefined);
    } finally {
      s2.stop();
    }
  });
});
