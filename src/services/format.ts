/** Shared response shaping: markdown/json rendering and character-limit truncation. */

import { CHARACTER_LIMIT } from "../constants.js";
import type { FileEntry } from "./webdav.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export type Record_ = Record<string, unknown>;

/** Content blocks a tool can return: text, an image, or an embedded file. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record_;
  isError?: boolean;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** "2026-11-18 21:04" in Europe/Berlin — compact and unambiguous enough for a table. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("sv-SE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
}

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown table of file entries. */
export function fileTable(entries: FileEntry[], options: { showPath?: boolean } = {}): string {
  const header = options.showPath
    ? "| Path | Type | Size | Modified |\n|---|---|---|---|"
    : "| Name | Type | Size | Modified |\n|---|---|---|---|";
  const rows = entries.map((e) => {
    const label = options.showPath ? `/${e.path}` : e.name;
    const kind = e.type === "folder" ? "folder" : (e.mime ?? "file");
    const flags = [e.favorite ? "★" : "", e.shared ? "shared" : "", e.mount_type === "shared" ? "shared with you" : ""]
      .filter(Boolean)
      .join(", ");
    return `| ${cell(label)}${e.type === "folder" ? "/" : ""}${flags ? ` (${flags})` : ""} | ${cell(kind)} | ${formatBytes(e.size)} | ${formatDate(e.modified)} |`;
  });
  return [header, ...rows].join("\n");
}

/** Compact JSON shape of an entry (drops nulls and false flags). */
export function compactEntry(e: FileEntry): Record_ {
  const out: Record_ = {};
  for (const [key, value] of Object.entries(e)) {
    if (value === null || value === false) continue;
    out[key] = key === "path" ? `/${String(value)}` : value;
  }
  return out;
}

/**
 * Builds a result from structured data and a markdown renderer. When the text
 * exceeds CHARACTER_LIMIT, `shrink` is asked for a smaller version (halving the
 * item count) until it fits.
 */
export function buildResult<T extends { items?: unknown[] }>(
  data: T & Record_,
  format: ResponseFormat,
  render: (data: T) => string,
  noun = "items",
): ToolResult {
  const toText = (d: T & Record_): string => (format === "json" ? JSON.stringify(d, null, 2) : render(d));
  let current = data;
  let text = toText(current);
  const items = data.items;
  if (text.length > CHARACTER_LIMIT && Array.isArray(items) && items.length > 1) {
    let kept = items.length;
    while (text.length > CHARACTER_LIMIT && kept > 1) {
      kept = Math.max(1, Math.floor(kept / 2));
      current = {
        ...data,
        items: items.slice(0, kept),
        truncated: true,
        truncation_message: `Output truncated from ${items.length} to ${kept} ${noun}. Use a smaller 'limit', narrow the filters, or page with 'offset'.`,
      };
      text = toText(current);
    }
  }
  if (text.length > CHARACTER_LIMIT) {
    text = `${text.slice(0, CHARACTER_LIMIT)}\n\n> Output truncated at ${CHARACTER_LIMIT} characters.`;
  }
  return { content: [{ type: "text", text }], structuredContent: current };
}
