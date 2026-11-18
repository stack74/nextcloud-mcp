/**
 * WebDAV request bodies and response parsing for Nextcloud.
 *
 * PROPFIND lists a folder, SEARCH (RFC 5323 DASL, as implemented by Nextcloud)
 * finds files across folders. Both answer with a 207 multistatus document whose
 * hrefs are percent-encoded URL paths: /remote.php/dav/files/<user>/<path>.
 */

import { XMLParser } from "fast-xml-parser";
import type { NextcloudClient } from "./client.js";
import { baseName } from "./paths.js";

const NS = 'xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"';

/** Properties requested for every file entry. */
const FILE_PROPS = [
  "d:getlastmodified",
  "d:getcontentlength",
  "d:getcontenttype",
  "d:resourcetype",
  "d:getetag",
  "oc:fileid",
  "oc:size",
  "oc:permissions",
  "oc:favorite",
  "oc:owner-id",
  "oc:owner-display-name",
  "oc:share-types",
  "nc:has-preview",
  "nc:mount-type",
];

/** SEARCH only accepts the properties Nextcloud declares as selectable. */
const SEARCH_PROPS = [
  "d:getlastmodified",
  "d:getcontentlength",
  "d:getcontenttype",
  "d:resourcetype",
  "d:getetag",
  "oc:fileid",
  "oc:size",
  "oc:permissions",
  "oc:favorite",
  "oc:owner-id",
  "oc:owner-display-name",
  "nc:has-preview",
];

const TRASH_PROPS = [
  "nc:trashbin-filename",
  "nc:trashbin-original-location",
  "nc:trashbin-deletion-time",
  "d:getcontentlength",
  "d:getcontenttype",
  "d:resourcetype",
  "oc:size",
  "oc:fileid",
];

export const FOLDER_MIME = "httpd/unix-directory";

/**
 * MIME types for the file-type filters. Nextcloud's search accepts a type only
 * as an exact "type/subtype" or as "type/%" — a prefix such as
 * "application/vnd.openxmlformats-officedocument.%" fails with HTTP 500
 * (lib/private/Files/Cache/SearchBuilder.php), so office formats are listed one by one.
 */
const OOXML = "application/vnd.openxmlformats-officedocument";
const ODF = "application/vnd.oasis.opendocument";
export const MIME_GROUPS = {
  text: ["text/%", "application/json", "application/xml", "application/x-yaml"],
  pdf: ["application/pdf"],
  /** Formats whose text this server can extract (see extract.ts). */
  office: [
    `${OOXML}.wordprocessingml.document`,
    `${OOXML}.spreadsheetml.sheet`,
    `${OOXML}.presentationml.presentation`,
    `${ODF}.text`,
    `${ODF}.spreadsheet`,
    `${ODF}.presentation`,
  ],
  document: [
    `${OOXML}.wordprocessingml.document`,
    `${OOXML}.wordprocessingml.template`,
    "application/vnd.ms-word.document.macroEnabled.12",
    "application/msword",
    `${ODF}.text`,
    `${ODF}.text-template`,
    "application/rtf",
  ],
  spreadsheet: [
    `${OOXML}.spreadsheetml.sheet`,
    `${OOXML}.spreadsheetml.template`,
    "application/vnd.ms-excel",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    `${ODF}.spreadsheet`,
    `${ODF}.spreadsheet-template`,
    "text/csv",
  ],
  presentation: [
    `${OOXML}.presentationml.presentation`,
    `${OOXML}.presentationml.slideshow`,
    `${OOXML}.presentationml.template`,
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
    `${ODF}.presentation`,
    `${ODF}.presentation-template`,
  ],
  image: ["image/%"],
  audio: ["audio/%"],
  video: ["video/%"],
} as const;

/** One OR-able condition per MIME type: "type/%" as like, everything else as eq. */
export function mimeConditions(mimes: readonly string[]): SearchCondition[] {
  return mimes.map((value) =>
    value.endsWith("/%") ? { op: "like" as const, prop: "d:getcontenttype", value } : { op: "eq" as const, prop: "d:getcontenttype", value },
  );
}

const propList = (props: string[]): string => props.map((p) => `<${p}/>`).join("");

export function propfindBody(props: string[] = FILE_PROPS): string {
  return `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${NS}><d:prop>${propList(props)}</d:prop></d:propfind>`;
}

export const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** One condition of a SEARCH where clause. */
export type SearchCondition =
  | { op: "like" | "eq" | "gt" | "gte" | "lt" | "lte"; prop: string; value: string | number }
  | { op: "not"; condition: SearchCondition }
  | { op: "or" | "and"; conditions: SearchCondition[] };

function renderCondition(c: SearchCondition): string {
  if (c.op === "not") return `<d:not>${renderCondition(c.condition)}</d:not>`;
  if ("conditions" in c) {
    if (c.conditions.length === 1) return renderCondition(c.conditions[0]!);
    return `<d:${c.op}>${c.conditions.map(renderCondition).join("")}</d:${c.op}>`;
  }
  return `<d:${c.op}><d:prop><${c.prop}/></d:prop><d:literal>${escapeXml(String(c.value))}</d:literal></d:${c.op}>`;
}

export interface SearchQuery {
  userId: string;
  /** Normalised folder path to search below ("" = all files). */
  scope: string;
  conditions: SearchCondition[];
  orderBy: { prop: string; descending: boolean }[];
  limit: number;
  offset: number;
}

export function searchBody(q: SearchQuery): string {
  // A relative scope href is used verbatim as a path by Nextcloud (SearchDAV's
  // PathHelper), so it must NOT be percent-encoded — only XML-escaped.
  const scopeHref = `/files/${q.userId}${q.scope ? `/${q.scope}` : ""}`;
  // Nextcloud needs at least one condition; this one matches everything.
  const where = q.conditions.length > 0 ? q.conditions : [{ op: "like", prop: "d:displayname", value: "%" } as SearchCondition];
  const order = q.orderBy
    .map((o) => `<d:order><d:prop><${o.prop}/></d:prop>${o.descending ? "<d:descending/>" : "<d:ascending/>"}</d:order>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<d:searchrequest ${NS} xmlns:ns="https://github.com/icewind1991/SearchDAV/ns"><d:basicsearch>` +
    `<d:select><d:prop>${propList(SEARCH_PROPS)}</d:prop></d:select>` +
    `<d:from><d:scope><d:href>${escapeXml(scopeHref)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>` +
    `<d:where>${renderCondition({ op: "and", conditions: where })}</d:where>` +
    `<d:orderby>${order}</d:orderby>` +
    `<d:limit><d:nresults>${q.limit}</d:nresults>${q.offset > 0 ? `<ns:firstresult>${q.offset}</ns:firstresult>` : ""}</d:limit>` +
    `</d:basicsearch></d:searchrequest>`
  );
}

/** A file or folder as the tools present it. */
export interface FileEntry {
  /** Normalised path relative to the user's root ("" for the root itself). */
  path: string;
  name: string;
  type: "file" | "folder";
  /** Bytes; for folders the total size of their content. */
  size: number | null;
  /** ISO 8601. */
  modified: string | null;
  mime: string | null;
  file_id: number | null;
  etag: string | null;
  /** Nextcloud permission letters, e.g. "RGDNVCK" (R share, G read, D delete, N rename, V move, C/K create, W write). */
  permissions: string | null;
  favorite: boolean;
  owner: string | null;
  /** Shared by or with the user (share-types present). */
  shared: boolean;
  has_preview: boolean;
  /** "shared" for files others shared with the user, "group" for group folders, … */
  mount_type: string | null;
}

export interface TrashEntry {
  /** Name inside the trash bin, e.g. "report.pdf.d1731923456" — pass it to restore. */
  trash_id: string;
  name: string;
  original_location: string;
  deleted_at: string | null;
  type: "file" | "folder";
  size: number | null;
  mime: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "response" || name === "propstat",
});

type Props = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "#text" in (value as object)) return text((value as { "#text": unknown })["#text"]);
  return null;
}

function num(value: unknown): number | null {
  const t = text(value);
  if (t === null || t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function isoDate(value: unknown): string | null {
  const t = text(value);
  if (!t) return null;
  const date = new Date(/^\d+$/.test(t) ? Number(t) * 1000 : t);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface RawResponse {
  href: string;
  props: Props;
}

/** Parses a multistatus body into href + the properties found with status 200. */
export function parseMultistatus(xml: string): RawResponse[] {
  const doc = parser.parse(xml) as { multistatus?: { response?: unknown[] } };
  const responses = doc.multistatus?.response ?? [];
  const out: RawResponse[] = [];
  for (const raw of responses) {
    const r = raw as { href?: unknown; propstat?: { status?: unknown; prop?: Props }[] };
    const href = text(r.href);
    if (!href) continue;
    const props: Props = {};
    for (const ps of r.propstat ?? []) {
      const status = text(ps.status) ?? "";
      // "HTTP/1.1 200 OK"; the 404 propstat lists properties the item does not have.
      if (!/\b200\b/.test(status)) continue;
      Object.assign(props, ps.prop ?? {});
    }
    out.push({ href, props });
  }
  return out;
}

/** Decodes an href and strips everything up to and including `marker` (e.g. "/remote.php/dav/files/<user>"). */
function relativeTo(href: string, marker: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href;
  }
  // hrefs may be absolute URLs on some setups.
  if (/^https?:\/\//.test(decoded)) decoded = new URL(decoded).pathname;
  const index = decoded.indexOf(marker);
  if (index === -1) return undefined;
  const rest = decoded.slice(index + marker.length);
  if (rest !== "" && !rest.startsWith("/")) return undefined;
  return rest.replace(/^\/+|\/+$/g, "");
}

function isCollection(props: Props): boolean {
  const rt = props.resourcetype;
  return typeof rt === "object" && rt !== null && "collection" in rt;
}

export function toFileEntry(raw: RawResponse, userId: string): FileEntry | undefined {
  const path = relativeTo(raw.href, `/remote.php/dav/files/${userId}`) ?? relativeTo(raw.href, `/files/${userId}`);
  if (path === undefined) return undefined;
  const p = raw.props;
  const folder = isCollection(p);
  const shareTypes = p["share-types"];
  const shared = typeof shareTypes === "object" && shareTypes !== null && Object.keys(shareTypes).length > 0;
  return {
    path,
    name: path === "" ? "/" : baseName(path),
    type: folder ? "folder" : "file",
    size: folder ? (num(p.size) ?? num(p.getcontentlength)) : (num(p.getcontentlength) ?? num(p.size)),
    modified: isoDate(p.getlastmodified),
    mime: folder ? FOLDER_MIME : text(p.getcontenttype),
    file_id: num(p.fileid),
    etag: text(p.getetag)?.replace(/"/g, "") ?? null,
    permissions: text(p.permissions),
    favorite: text(p.favorite) === "1",
    owner: text(p["owner-display-name"]) ?? text(p["owner-id"]),
    shared,
    has_preview: text(p["has-preview"]) === "true",
    mount_type: text(p["mount-type"]) || null,
  };
}

/** PROPFIND on a file or folder. depth 0 = the item itself, 1 = plus its children. */
export async function propfind(client: NextcloudClient, path: string, depth: 0 | 1): Promise<FileEntry[]> {
  const userId = await client.userId();
  const response = await client.send(await client.filesPath(path), {
    method: "PROPFIND",
    headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
    body: propfindBody(),
  });
  return parseMultistatus(await response.text())
    .map((r) => toFileEntry(r, userId))
    .filter((e): e is FileEntry => e !== undefined);
}

/** The item at `path`, or undefined when it does not exist. */
export async function stat(client: NextcloudClient, path: string): Promise<FileEntry | undefined> {
  const userId = await client.userId();
  const response = await client.send(await client.filesPath(path), {
    method: "PROPFIND",
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body: propfindBody(),
    allowStatus: [404],
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  return parseMultistatus(await response.text())
    .map((r) => toFileEntry(r, userId))
    .find((e) => e !== undefined);
}

export async function search(client: NextcloudClient, query: Omit<SearchQuery, "userId">): Promise<FileEntry[]> {
  const userId = await client.userId();
  const response = await client.send("/remote.php/dav/", {
    method: "SEARCH",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: searchBody({ ...query, userId }),
  });
  return parseMultistatus(await response.text())
    .map((r) => toFileEntry(r, userId))
    .filter((e): e is FileEntry => e !== undefined);
}

export async function listTrash(client: NextcloudClient): Promise<TrashEntry[]> {
  const userId = await client.userId();
  const response = await client.send(`/remote.php/dav/trashbin/${encodeURIComponent(userId)}/trash`, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: propfindBody(TRASH_PROPS),
  });
  const marker = `/remote.php/dav/trashbin/${userId}/trash`;
  const entries: TrashEntry[] = [];
  for (const raw of parseMultistatus(await response.text())) {
    const id = relativeTo(raw.href, marker);
    if (!id) continue; // the trash folder itself
    const p = raw.props;
    const folder = isCollection(p);
    entries.push({
      trash_id: id,
      name: text(p["trashbin-filename"]) ?? id,
      original_location: `/${(text(p["trashbin-original-location"]) ?? "").replace(/^\/+/, "")}`,
      deleted_at: isoDate(p["trashbin-deletion-time"]),
      type: folder ? "folder" : "file",
      size: folder ? num(p.size) : (num(p.getcontentlength) ?? num(p.size)),
      mime: folder ? FOLDER_MIME : text(p.getcontenttype),
    });
  }
  return entries;
}
