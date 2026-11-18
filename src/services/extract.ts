/**
 * Plain-text extraction for the document formats people keep in Nextcloud, so
 * the model can read them instead of only seeing "binary file".
 *
 *  - PDF via unpdf (pdf.js, no native dependencies; loaded on first use)
 *  - Office Open XML (docx, xlsx, pptx) and OpenDocument (odt, ods, odp) are
 *    ZIP archives of XML: read with a small ZIP reader (node:zlib) and turned into
 *    text with a few targeted patterns. Formatting is dropped on purpose.
 */

import { inflateRawSync } from "node:zlib";

/** Upper bound for any single decompressed ZIP member (guards against zip bombs). */
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
/** Repeated empty spreadsheet cells/rows are capped so a styled empty sheet stays small. */
const MAX_REPEAT = 50;

export type ExtractKind = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";

const BY_EXTENSION: Record<string, ExtractKind> = {
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  dotx: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  pptx: "pptx",
  pptm: "pptx",
  odt: "odt",
  ott: "odt",
  ods: "ods",
  ots: "ods",
  odp: "odp",
  otp: "odp",
};

const BY_MIME: Record<string, ExtractKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};

export function extractKind(fileName: string, mime: string | null): ExtractKind | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return (mime ? BY_MIME[mime] : undefined) ?? (ext ? BY_EXTENSION[ext] : undefined);
}

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

// --- ZIP ----------------------------------------------------------------------

interface ZipMember {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Reads the central directory of a ZIP archive. */
export function readZipDirectory(buf: Buffer): Map<string, ZipMember> {
  // End of central directory record: at the end, before an optional comment (≤ 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ExtractError("not a ZIP archive (or damaged)");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const members = new Map<string, ZipMember>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new ExtractError("damaged ZIP central directory");
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    members.set(name, { name, method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

export function readZipMember(buf: Buffer, member: ZipMember): Buffer {
  const at = member.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw new ExtractError(`damaged ZIP entry ${member.name}`);
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + member.compressedSize);
  if (member.method === 0) return data;
  if (member.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_MEMBER_BYTES });
    } catch (error) {
      throw new ExtractError(`cannot decompress ${member.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new ExtractError(`unsupported ZIP compression method ${member.method} in ${member.name}`);
}

function zipText(buf: Buffer, members: Map<string, ZipMember>, name: string): string | undefined {
  const member = members.get(name);
  return member ? readZipMember(buf, member).toString("utf8") : undefined;
}

// --- XML helpers ----------------------------------------------------------------

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const e = entity.toLowerCase();
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag)?.[1];

/** Collapses runs of blank lines and trailing spaces. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Office Open XML ----------------------------------------------------------

/** Text of a WordprocessingML or DrawingML part: runs, tabs, breaks, paragraphs, table cells. */
function ooxmlText(xml: string, ns: "w" | "a"): string {
  const pattern =
    ns === "w"
      ? /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g
      : /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:tab\/>|<a:br\b[^>]*\/>|<\/a:p>|<\/a:tc>|<\/a:tr>/g;
  let out = "";
  for (const match of xml.matchAll(pattern)) {
    const token = match[0];
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else if (token.endsWith(":tab/>")) out += "\t";
    else if (token.includes(":br")) out += "\n";
    else if (token.endsWith(":p>")) out += "\n";
    else if (token.endsWith(":tc>")) out += " | ";
    else if (token.endsWith(":tr>")) out += "\n";
  }
  return tidy(out);
}

function docxText(buf: Buffer): string {
  const members = readZipDirectory(buf);
  const body = zipText(buf, members, "word/document.xml");
  if (body === undefined) throw new ExtractError("word/document.xml missing — not a Word document");
  return ooxmlText(body, "w");
}

function pptxText(buf: Buffer): string {
  const members = readZipDirectory(buf);
  const slides = [...members.keys()]
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  if (slides.length === 0) throw new ExtractError("no slides found — not a PowerPoint presentation");
  return slides
    .map((s) => `## Slide ${s.n}\n\n${ooxmlText(zipText(buf, members, s.name) ?? "", "a")}`)
    .join("\n\n");
}

/** "AB" -> 27 (1-based). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

const cellValue = (value: string): string => value.replace(/[\t\r\n]+/g, " ");

function xlsxText(buf: Buffer): string {
  const members = readZipDirectory(buf);
  const shared: string[] = [];
  const sharedXml = zipText(buf, members, "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // Rich text has several <t>; phonetic hints (<rPh>) are not part of the value.
      const body = (si[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
      shared.push([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeEntities(m[1] ?? "")).join(""));
    }
  }

  const workbook = zipText(buf, members, "xl/workbook.xml") ?? "";
  const rels = zipText(buf, members, "xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(rel[0], "Id");
    const target = attr(rel[0], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decodeEntities(attr(m[0], "name") ?? "Sheet"),
    path: targets.get(attr(m[0], "r:id") ?? "") ?? "",
  }));
  if (sheets.length === 0) throw new ExtractError("no worksheets found — not an Excel workbook");

  const parts: string[] = [];
  for (const sheet of sheets) {
    const xml = zipText(buf, members, sheet.path);
    if (xml === undefined) continue;
    const lines: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = ` ${c[1] ?? ""}`;
        const inner = c[2] ?? "";
        const type = attr(attrs, "t");
        const ref = attr(attrs, "r");
        let value = "";
        if (type === "inlineStr") {
          value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeEntities(m[1] ?? "")).join("");
        } else {
          const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
          if (v !== undefined) {
            if (type === "s") value = shared[Number(v)] ?? "";
            else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
            else value = decodeEntities(v);
          }
        }
        const index = ref ? columnIndex(ref) - 1 : cells.length;
        while (cells.length < index) cells.push("");
        cells[index] = cellValue(value);
      }
      // Styled but empty cells at the end of a row only add tabs.
      while (cells.length > 0 && !cells[cells.length - 1]) cells.pop();
      if (cells.length > 0) lines.push(cells.map((v) => v ?? "").join("\t"));
    }
    parts.push(`## Sheet: ${sheet.name}\n\n${lines.join("\n") || "(empty)"}`);
  }
  return parts.join("\n\n");
}

// --- OpenDocument -------------------------------------------------------------

/** Text of an ODF fragment: spaces, tabs, line breaks, paragraphs. */
function odfInline(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_m, n: string | undefined) => " ".repeat(Math.min(Number(n ?? 1), 100)))
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<\/text:(p|h)>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

function odfContent(buf: Buffer): string {
  const members = readZipDirectory(buf);
  const content = zipText(buf, members, "content.xml");
  if (content === undefined) throw new ExtractError("content.xml missing — not an OpenDocument file");
  return content.replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, "");
}

function odtText(buf: Buffer): string {
  const content = odfContent(buf);
  const body = /<office:text\b[^>]*>([\s\S]*)<\/office:text>/.exec(content)?.[1] ?? content;
  // Table cells on one line, separated like in docx.
  return tidy(odfInline(body.replace(/<\/table:table-cell>/g, " | ").replace(/<\/table:table-row>/g, "\n")));
}

function odsText(buf: Buffer): string {
  const content = odfContent(buf);
  const parts: string[] = [];
  for (const table of content.matchAll(/<table:table(?=[\s>])([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = decodeEntities(attr(` ${table[1] ?? ""}`, "table:name") ?? "Sheet");
    const lines: string[] = [];
    for (const row of (table[2] ?? "").matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const cells: string[] = [];
      for (const cell of (row[2] ?? "").matchAll(
        /<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g,
      )) {
        const repeat = Math.min(Number(attr(` ${cell[1] ?? ""}`, "table:number-columns-repeated") ?? 1), MAX_REPEAT);
        const value = cellValue(tidy(odfInline(cell[2] ?? "")));
        for (let i = 0; i < repeat; i++) cells.push(value);
      }
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) lines.push(cells.join("\t"));
    }
    parts.push(`## Sheet: ${name}\n\n${lines.join("\n") || "(empty)"}`);
  }
  if (parts.length === 0) throw new ExtractError("no tables found — not a spreadsheet");
  return parts.join("\n\n");
}

function odpText(buf: Buffer): string {
  const content = odfContent(buf);
  const pages = [...content.matchAll(/<draw:page(?=[\s>])([^>]*)>([\s\S]*?)<\/draw:page>/g)];
  if (pages.length === 0) return tidy(odfInline(content));
  return pages
    .map((page, i) => {
      // Speaker notes live in <presentation:notes>; keep only the slide itself.
      const slide = (page[2] ?? "").replace(/<presentation:notes\b[\s\S]*?<\/presentation:notes>/g, "");
      return `## Slide ${i + 1}\n\n${tidy(odfInline(slide))}`;
    })
    .join("\n\n");
}

// --- PDF ----------------------------------------------------------------------

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new ExtractError("the PDF is password-protected");
    throw new ExtractError(`cannot open the PDF: ${message}`);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((page, i) => `## Page ${i + 1}\n\n${tidy(page)}`);
  return { text: pages.join("\n\n"), pages: totalPages };
}

// --- entry point ----------------------------------------------------------------

export interface Extracted {
  text: string;
  kind: ExtractKind;
  /** PDF page count. */
  pages?: number;
}

export async function extractText(buf: Buffer, kind: ExtractKind): Promise<Extracted> {
  switch (kind) {
    case "pdf": {
      const { text, pages } = await pdfText(buf);
      return { text, kind, pages };
    }
    case "docx":
      return { text: docxText(buf), kind };
    case "xlsx":
      return { text: xlsxText(buf), kind };
    case "pptx":
      return { text: pptxText(buf), kind };
    case "odt":
      return { text: odtText(buf), kind };
    case "ods":
      return { text: odsText(buf), kind };
    case "odp":
      return { text: odpText(buf), kind };
  }
}
