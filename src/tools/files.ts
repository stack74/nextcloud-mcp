/** Read-only file tools: list, inspect, search, read, preview, download. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHARACTER_LIMIT, MAX_INLINE_BYTES, MAX_READ_BYTES } from "../constants.js";
import { type NextcloudClient, NextcloudApiError } from "../services/client.js";
import { ExtractError, extractKind, extractText } from "../services/extract.js";
import {
  RESPONSE_FORMATS,
  type ResponseFormat,
  type Record_,
  type ToolResult,
  buildResult,
  compactEntry,
  fileTable,
  formatBytes,
  formatDate,
  textResult,
} from "../services/format.js";
import { displayPath, normalizePath } from "../services/paths.js";
import { FOLDER_MIME, type FileEntry, MIME_GROUPS, type SearchCondition, mimeConditions, propfind, search, stat } from "../services/webdav.js";
import { type Args, isHosted, registerRead } from "./registry.js";
import { downloadNote, downloadShape, readCapped, saveToLocal } from "./transfer.js";

export const formatSchema = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe("'markdown' for readable output, 'json' for structured data");

export const pathSchema = (what: string) =>
  z.string().min(1).describe(`${what}, relative to the user's Nextcloud root, e.g. '/Documents/Offers/offer-4711.pdf'`);

/** Web UI link that opens the file or folder in Nextcloud. */
export const webUrl = (client: NextcloudClient, entry: FileEntry): string | null =>
  entry.file_id !== null ? `${client.baseUrl}/index.php/f/${entry.file_id}` : null;

async function requireEntry(client: NextcloudClient, path: string): Promise<FileEntry> {
  const entry = await stat(client, path);
  if (!entry) {
    throw new NextcloudApiError(404, "PROPFIND", displayPath(path), `${displayPath(path)} does not exist`);
  }
  return entry;
}

// --- file type groups used by search -----------------------------------------

const TYPE_FILTERS: Record<string, SearchCondition[]> = {
  folder: [{ op: "eq", prop: "d:getcontenttype", value: FOLDER_MIME }],
  image: mimeConditions(MIME_GROUPS.image),
  pdf: mimeConditions(MIME_GROUPS.pdf),
  document: mimeConditions(MIME_GROUPS.document),
  spreadsheet: mimeConditions(MIME_GROUPS.spreadsheet),
  presentation: mimeConditions(MIME_GROUPS.presentation),
  text: mimeConditions(MIME_GROUPS.text),
  audio: mimeConditions(MIME_GROUPS.audio),
  video: mimeConditions(MIME_GROUPS.video),
};

const FILE_TYPES = ["any", ...Object.keys(TYPE_FILTERS)] as [string, ...string[]];

/** Name filter: words AND-ed, each matched anywhere in the name; '*' is a wildcard. */
function nameConditions(query: string | undefined): SearchCondition[] {
  if (!query?.trim()) return [];
  // No LIKE escaping: whether "\_" works depends on the database (not on SQLite).
  // An unescaped "_" also matches a literal underscore, so results only get wider.
  if (query.includes("*")) {
    return [{ op: "like", prop: "d:displayname", value: query.trim().replace(/\*/g, "%") }];
  }
  return query
    .trim()
    .split(/\s+/)
    .map((word) => ({ op: "like" as const, prop: "d:displayname", value: `%${word}%` }));
}

/** "2026-01-31" or ISO -> unix seconds. */
function toTimestamp(value: string, name: string): number {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw new Error(`'${name}' is not a date: ${value}. Use YYYY-MM-DD.`);
  return Math.floor(ms / 1000);
}

// --- reading content -----------------------------------------------------------

const TEXT_MIME = /^(text\/|application\/(json|ld\+json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|x-sh|x-shellscript|sql|x-php|toml|x-ndjson|x-subrip|rtf|x-tex|x-httpd-php)|image\/svg\+xml)/;
const TEXT_EXTENSIONS = new Set(
  "txt md markdown csv tsv json jsonl ndjson xml yml yaml log ini conf cfg env sh bash zsh js mjs cjs ts tsx jsx py rb php java kt go rs c h cpp hpp cs swift html htm css scss less sql toml vcf ics srt vtt tex rtf svg properties gitignore dockerfile".split(
    " ",
  ),
);

function looksLikeText(name: string, mime: string | null): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (mime !== null && TEXT_MIME.test(mime)) || (ext !== undefined && TEXT_EXTENSIONS.has(ext));
}

/** Decodes bytes as text: UTF-8 when valid, else Windows-1252 (old Excel CSV exports). Undefined for binary data. */
export function decodeText(data: Buffer, assumeText: boolean): string | undefined {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) {
    // UTF-16 text has NUL bytes; recognise it by its byte order mark.
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return assumeText ? new TextDecoder("windows-1252").decode(data) : undefined;
  }
}

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

async function fetchPreview(client: NextcloudClient, entry: FileEntry, size: number): Promise<{ data: Buffer; mime: string } | undefined> {
  if (entry.file_id === null) return undefined;
  const query = new URLSearchParams({ fileId: String(entry.file_id), x: String(size), y: String(size), a: "1", forceIcon: "0", mimeFallback: "0" });
  const response = await client.send(`/index.php/core/preview?${query}`, { allowStatus: [404, 403], headers: { Accept: "image/*" } });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const mime = (response.headers.get("content-type") ?? "image/png").split(";")[0]!.trim();
  if (!mime.startsWith("image/")) {
    await response.body?.cancel();
    return undefined;
  }
  return { data: await readCapped(response, MAX_INLINE_BYTES, "The preview"), mime };
}

async function downloadBytes(client: NextcloudClient, path: string, max: number, label: string): Promise<Buffer> {
  const response = await client.send(await client.filesPath(path), { transfer: true });
  return readCapped(response, max, label);
}

function slice(text: string, offset: number, maxChars: number): { part: string; end: number; total: number } {
  const total = text.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + maxChars, total);
  return { part: text.slice(start, end), end, total };
}

// --- registration --------------------------------------------------------------

export function registerFileReadTools(server: McpServer, client: NextcloudClient): void {
  registerRead(
    server,
    {
      name: "nextcloud_list_files",
      title: "List folder",
      description:
        "List the files and subfolders of one folder (not recursive).\n\n" +
        "Returns name, type, size, last modified and flags (favorite, shared). Start at '/' to see the top level. " +
        "To find something whose location you do not know, use nextcloud_search_files instead of walking folders.",
      inputSchema: {
        path: z.string().default("/").describe("Folder path, e.g. '/' or '/Documents/2026'. Default: the root."),
        type: z.enum(["all", "files", "folders"]).default("all").describe("Only files, only folders, or both."),
        sort: z.enum(["name", "newest", "oldest", "largest"]).default("name").describe("Sort order; 'name' lists folders first."),
        limit: z.number().int().min(1).max(500).default(100).describe("Maximum entries to return (default 100)."),
        offset: z.number().int().min(0).default(0).describe("Skip this many entries, for paging."),
        response_format: formatSchema,
      },
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      const entries = await propfind(client, path, 1);
      const self = entries.find((e) => e.path === path);
      if (self && self.type === "file") {
        return textResult(`${displayPath(path)} is a file, not a folder. Use nextcloud_get_file_info or nextcloud_read_file.`, true);
      }
      let children = entries.filter((e) => e.path !== path);
      if (args.type === "files") children = children.filter((e) => e.type === "file");
      if (args.type === "folders") children = children.filter((e) => e.type === "folder");
      const time = (e: FileEntry): number => (e.modified ? Date.parse(e.modified) : 0);
      const sorters: Record<string, (a: FileEntry, b: FileEntry) => number> = {
        name: (a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.type === "folder" ? -1 : 1),
        newest: (a, b) => time(b) - time(a),
        oldest: (a, b) => time(a) - time(b),
        largest: (a, b) => (b.size ?? 0) - (a.size ?? 0),
      };
      children.sort(sorters[args.sort as string] ?? sorters.name);
      const offset = args.offset as number;
      const limit = args.limit as number;
      const page = children.slice(offset, offset + limit);
      const hasMore = offset + page.length < children.length;
      const data = {
        folder: displayPath(path),
        total: children.length,
        count: page.length,
        offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + page.length } : {}),
        ...(self ? { folder_size: self.size } : {}),
        items: page.map(compactEntry),
      };
      return buildResult(data, args.response_format as ResponseFormat, () => {
        if (page.length === 0) return `Folder ${displayPath(path)} is empty${args.type !== "all" ? ` (no ${String(args.type)})` : ""}.`;
        return [
          `# ${displayPath(path)} — ${page.length} of ${children.length} entries${self ? `, ${formatBytes(self.size)} in total` : ""}`,
          "",
          fileTable(page),
          hasMore ? `\nMore entries: call again with offset=${offset + page.length}.` : "",
        ].join("\n");
      }, "entries");
    },
  );

  registerRead(
    server,
    {
      name: "nextcloud_get_file_info",
      title: "File or folder details",
      description:
        "Details of one file or folder: size, type, last modified, owner, permissions, favorite/shared flags, " +
        "file ID and a link that opens it in the Nextcloud web interface.",
      inputSchema: { path: pathSchema("File or folder path"), response_format: formatSchema },
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      const entry = await requireEntry(client, path);
      const data: Record_ = { ...compactEntry(entry), web_url: webUrl(client, entry) };
      if (args.response_format === "json") return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
      const perms = entry.permissions ?? "";
      const can = [perms.includes("W") || perms.includes("C") ? "write" : "", perms.includes("D") ? "delete" : "", perms.includes("N") ? "rename" : "", perms.includes("R") ? "share" : ""]
        .filter(Boolean)
        .join(", ");
      const lines = [
        `# ${entry.type === "folder" ? "Folder" : "File"} ${displayPath(entry.path)}`,
        "",
        `- **Type**: ${entry.type === "folder" ? "folder" : (entry.mime ?? "file")}`,
        `- **Size**: ${formatBytes(entry.size)}`,
        `- **Modified**: ${formatDate(entry.modified)}`,
        entry.owner ? `- **Owner**: ${entry.owner}` : "",
        `- **Permissions**: ${can || "read only"}`,
        entry.favorite ? "- **Favorite**: yes" : "",
        entry.shared ? "- **Shared**: yes" : "",
        entry.mount_type ? `- **Mount**: ${entry.mount_type}` : "",
        entry.type === "file" ? `- **Preview available**: ${entry.has_preview ? "yes" : "no"}` : "",
        `- **File ID**: ${entry.file_id ?? "–"}`,
        webUrl(client, entry) ? `- **Open in Nextcloud**: ${webUrl(client, entry)}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: data };
    },
  );

  registerRead(
    server,
    {
      name: "nextcloud_search_files",
      title: "Search files by name, type and date",
      description:
        "Find files and folders anywhere below a folder, searched on the Nextcloud server — fast, one request.\n\n" +
        "- By name: 'query' matches parts of the file name; several words must all appear ('rechnung 2026'). " +
        "'*' is a wildcard ('*.pdf', 'Angebot*').\n" +
        "- By type: 'type' = image, pdf, document (Word/ODT), spreadsheet (Excel/ODS/CSV), presentation, text, audio, video or folder.\n" +
        "- By date: 'modified_after' / 'modified_before' (YYYY-MM-DD).\n" +
        "- Without 'query' this lists the most recently changed files — the answer to 'what was I working on'.\n\n" +
        "This searches names, not content. For words inside files use nextcloud_search_file_contents.",
      inputSchema: {
        query: z.string().optional().describe("Words or a '*' pattern to match in the file name. Case-insensitive."),
        path: z.string().default("/").describe("Only search below this folder. Default: everything."),
        type: z.enum(FILE_TYPES).default("any").describe("Restrict to one kind of file."),
        modified_after: z.string().optional().describe("Only items changed on/after this date (YYYY-MM-DD)."),
        modified_before: z.string().optional().describe("Only items changed before this date (YYYY-MM-DD)."),
        favorites_only: z.boolean().default(false).describe("Only items the user marked as favorite."),
        include_folders: z.boolean().default(true).describe("Include folders in the results (ignored when 'type' is set)."),
        sort: z.enum(["newest", "oldest", "name", "largest"]).default("newest"),
        limit: z.number().int().min(1).max(200).default(30),
        offset: z.number().int().min(0).default(0).describe("Skip this many results, for paging."),
        response_format: formatSchema,
      },
    },
    async (args: Args): Promise<ToolResult> => {
      const scope = normalizePath(args.path as string);
      const conditions: SearchCondition[] = [...nameConditions(args.query as string | undefined)];
      const type = args.type as string;
      if (type !== "any") {
        conditions.push({ op: "or", conditions: TYPE_FILTERS[type]! });
      } else if (args.include_folders === false || !(args.query as string | undefined)?.trim()) {
        // "recent files" makes no sense with folders in it
        conditions.push({ op: "not", condition: { op: "eq", prop: "d:getcontenttype", value: FOLDER_MIME } });
      }
      if (args.modified_after) conditions.push({ op: "gte", prop: "d:getlastmodified", value: toTimestamp(args.modified_after as string, "modified_after") });
      if (args.modified_before) conditions.push({ op: "lt", prop: "d:getlastmodified", value: toTimestamp(args.modified_before as string, "modified_before") });
      if (args.favorites_only) conditions.push({ op: "eq", prop: "oc:favorite", value: "yes" });

      const orderBy = {
        newest: [{ prop: "d:getlastmodified", descending: true }],
        oldest: [{ prop: "d:getlastmodified", descending: false }],
        name: [{ prop: "d:displayname", descending: false }],
        largest: [{ prop: "oc:size", descending: true }],
      }[args.sort as "newest"]!;

      const limit = args.limit as number;
      const offset = args.offset as number;
      const results = await search(client, { scope, conditions, orderBy, limit, offset });
      const hasMore = results.length >= limit;
      const data = {
        query: args.query ?? null,
        scope: displayPath(scope),
        count: results.length,
        offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + results.length } : {}),
        items: results.map((e) => ({ ...compactEntry(e), web_url: webUrl(client, e) })),
      };
      return buildResult(data, args.response_format as ResponseFormat, () => {
        if (results.length === 0) {
          return `Nothing found${args.query ? ` for '${String(args.query)}'` : ""} below ${displayPath(scope)}. ` +
            "Try fewer or shorter words, another type, or a wider folder.";
        }
        return [
          `# ${results.length} result${results.length === 1 ? "" : "s"}${args.query ? ` for '${String(args.query)}'` : ""} below ${displayPath(scope)}`,
          "",
          fileTable(results, { showPath: true }),
          hasMore ? `\nMore results: call again with offset=${offset + results.length}.` : "",
        ].join("\n");
      }, "results");
    },
  );

  registerRead(
    server,
    {
      name: "nextcloud_read_file",
      title: "Read file content",
      description:
        "Read what is in a file.\n\n" +
        "- Text files (txt, md, csv, json, xml, code, …): the text.\n" +
        "- PDF, Word (docx/odt), Excel (xlsx/ods) and PowerPoint (pptx/odp): the extracted text " +
        "(PDF per page, spreadsheets per sheet as tab-separated rows; formatting and images are dropped, " +
        "spreadsheet dates appear as numbers). Scanned PDFs without a text layer return little or nothing — " +
        "use nextcloud_get_preview to look at them.\n" +
        "- Images: the image itself (scaled down).\n\n" +
        `Long content comes in chunks of 'max_chars'; the result says which 'offset' to request next. Files above ${formatBytes(MAX_READ_BYTES)} are not read.`,
      inputSchema: {
        path: pathSchema("File path"),
        offset: z.number().int().min(0).default(0).describe("Character offset to start from, for reading long content in chunks."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(CHARACTER_LIMIT)
          .default(Math.min(20_000, CHARACTER_LIMIT))
          .describe("Maximum characters to return in this call."),
      },
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      const entry = await requireEntry(client, path);
      if (entry.type === "folder") return textResult(`${displayPath(path)} is a folder. Use nextcloud_list_files.`, true);
      const label = `${displayPath(path)} (${entry.mime ?? "unknown type"}, ${formatBytes(entry.size)})`;

      if (entry.mime && entry.mime.startsWith("image/") && entry.mime !== "image/svg+xml") {
        const preview = await fetchPreview(client, entry, 1600);
        if (preview) {
          return {
            content: [
              { type: "text", text: `Image ${label}, shown scaled to at most 1600 px.` },
              { type: "image", data: preview.data.toString("base64"), mimeType: preview.mime },
            ],
          };
        }
        if (IMAGE_MIME.test(entry.mime) && (entry.size ?? Infinity) <= 3.5 * 1024 * 1024) {
          const data = await downloadBytes(client, path, MAX_INLINE_BYTES, "The image");
          return {
            content: [
              { type: "text", text: `Image ${label}.` },
              { type: "image", data: data.toString("base64"), mimeType: entry.mime },
            ],
          };
        }
        return textResult(`${label} is an image, but Nextcloud has no preview for it and it is too large to show directly. Use nextcloud_download_file.`, true);
      }

      if ((entry.size ?? 0) > MAX_READ_BYTES) {
        return textResult(
          `${label} is too large to read here (limit ${formatBytes(MAX_READ_BYTES)}). ` +
            "Use nextcloud_get_preview for a look at the first page, or nextcloud_download_file.",
          true,
        );
      }

      const kind = extractKind(entry.name, entry.mime);
      let text: string;
      let note = "";
      if (kind) {
        const data = await downloadBytes(client, path, MAX_READ_BYTES, "The file");
        try {
          const extracted = await extractText(data, kind);
          text = extracted.text;
          note = extracted.pages !== undefined ? `, ${extracted.pages} page${extracted.pages === 1 ? "" : "s"}` : "";
          if (!text.replace(/## (Page|Slide|Sheet)[^\n]*\n?/g, "").trim()) {
            return textResult(
              `${label}: no text found${kind === "pdf" ? " — probably a scanned PDF without a text layer. Use nextcloud_get_preview to look at it" : ""}.`,
            );
          }
        } catch (error) {
          if (error instanceof ExtractError) {
            return textResult(`${label}: cannot extract the text (${error.message}). Try nextcloud_get_preview or nextcloud_download_file.`, true);
          }
          throw error;
        }
      } else {
        const assumeText = looksLikeText(entry.name, entry.mime);
        if (!assumeText && (entry.size ?? 0) > 2 * 1024 * 1024) {
          return textResult(`${label} is a binary file this tool cannot read. Use nextcloud_get_preview or nextcloud_download_file.`, true);
        }
        const data = await downloadBytes(client, path, MAX_READ_BYTES, "The file");
        const decoded = decodeText(data, assumeText);
        if (decoded === undefined) {
          return textResult(`${label} is a binary file this tool cannot read. Use nextcloud_get_preview or nextcloud_download_file.`, true);
        }
        text = decoded;
      }

      const { part, end, total } = slice(text, args.offset as number, args.max_chars as number);
      const start = Math.min(args.offset as number, total);
      const header =
        total <= (args.max_chars as number) && start === 0
          ? `# ${label}${note}\n\n`
          : `# ${label}${note} — characters ${start}–${end} of ${total}\n\n`;
      const footer = end < total ? `\n\n> More content: call again with offset=${end}.` : "";
      return {
        content: [{ type: "text", text: `${header}${part}${footer}` }],
        structuredContent: { path: displayPath(path), mime: entry.mime, offset: start, end, total_chars: total, has_more: end < total, ...(end < total ? { next_offset: end } : {}) },
      };
    },
  );

  registerRead(
    server,
    {
      name: "nextcloud_get_preview",
      title: "Preview image of a file",
      description:
        "A thumbnail image of a file as Nextcloud renders it: photos, PDFs (first page), office documents and " +
        "videos, depending on the preview providers the server has enabled. Use it to look at scanned documents, " +
        "layouts or pictures without downloading the full file.",
      inputSchema: {
        path: pathSchema("File path"),
        size: z.number().int().min(64).max(2048).default(1024).describe("Longest edge in pixels (64-2048, default 1024)."),
      },
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      const entry = await requireEntry(client, path);
      if (entry.type === "folder") return textResult(`${displayPath(path)} is a folder; folders have no preview.`, true);
      const preview = await fetchPreview(client, entry, args.size as number);
      if (!preview) {
        return textResult(
          `Nextcloud has no preview for ${displayPath(path)} (${entry.mime ?? "unknown type"}). ` +
            "For text, PDF and office files use nextcloud_read_file instead.",
          true,
        );
      }
      return {
        content: [
          { type: "text", text: `Preview of ${displayPath(path)} (${entry.mime ?? "?"}, ${formatBytes(entry.size)}).` },
          { type: "image", data: preview.data.toString("base64"), mimeType: preview.mime },
        ],
      };
    },
  );

  registerRead(
    server,
    {
      name: "nextcloud_download_file",
      title: "Download file",
      description: `Download a file from Nextcloud.\n\n${downloadNote(server)}\n\nTo just read a document's text, nextcloud_read_file is the better choice.`,
      inputSchema: { path: pathSchema("File path"), ...downloadShape(server) },
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      const entry = await requireEntry(client, path);
      if (entry.type === "folder") return textResult(`${displayPath(path)} is a folder; download the files in it one by one.`, true);
      const response = await client.send(await client.filesPath(path), { transfer: true });
      const mime = (entry.mime ?? response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();

      if (!isHosted(server)) {
        const { savedTo, bytes } = await saveToLocal(response, args.output_path as string, entry.name);
        return {
          content: [{ type: "text", text: `Saved ${displayPath(path)} to ${savedTo} (${formatBytes(bytes)}, ${mime}).` }],
          structuredContent: { path: displayPath(path), saved_to: savedTo, bytes, mime },
        };
      }

      const data = await readCapped(response, MAX_INLINE_BYTES, displayPath(path));
      const blob = data.toString("base64");
      const body =
        IMAGE_MIME.test(mime)
          ? ({ type: "image", data: blob, mimeType: mime } as const)
          : ({ type: "resource", resource: { uri: `nextcloud:///${encodeURI(path)}`, mimeType: mime, blob } } as const);
      return {
        content: [{ type: "text", text: `${displayPath(path)} (${formatBytes(data.byteLength)}, ${mime}).` }, body],
        structuredContent: { path: displayPath(path), bytes: data.byteLength, mime },
      };
    },
  );
}
