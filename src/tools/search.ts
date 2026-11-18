/** Searching inside files and Nextcloud's unified search. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_READ_BYTES } from "../constants.js";
import type { NextcloudClient } from "../services/client.js";
import { extractKind, extractText } from "../services/extract.js";
import { type ResponseFormat, type ToolResult, buildResult } from "../services/format.js";
import { displayPath, normalizePath } from "../services/paths.js";
import { type FileEntry, MIME_GROUPS, type SearchCondition, mimeConditions, search } from "../services/webdav.js";
import { decodeText, formatSchema, webUrl } from "./files.js";
import { readCapped } from "./transfer.js";
import { type Args, registerRead } from "./registry.js";

/** File types whose content this server can read. */
const TEXT_ONLY: SearchCondition[] = mimeConditions(MIME_GROUPS.text);
const READABLE_TYPES: SearchCondition[] = [...TEXT_ONLY, ...mimeConditions([...MIME_GROUPS.pdf, ...MIME_GROUPS.office])];

const CONCURRENCY = 4;

interface Match {
  line: number;
  text: string;
}

function findMatches(text: string, needle: string, caseSensitive: boolean, max: number): { matches: Match[]; count: number } {
  const lines = text.split(/\r?\n/);
  const want = caseSensitive ? needle : needle.toLocaleLowerCase("de");
  const matches: Match[] = [];
  let count = 0;
  lines.forEach((raw, index) => {
    const hay = caseSensitive ? raw : raw.toLocaleLowerCase("de");
    const at = hay.indexOf(want);
    if (at === -1) return;
    count++;
    if (matches.length >= max) return;
    // Keep long lines (e.g. whole PDF paragraphs) readable: a window around the hit.
    const from = Math.max(0, at - 100);
    const to = Math.min(raw.length, at + want.length + 100);
    const snippet = `${from > 0 ? "…" : ""}${raw.slice(from, to).trim()}${to < raw.length ? "…" : ""}`;
    matches.push({ line: index + 1, text: snippet });
  });
  return { matches, count };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

interface Provider {
  id: string;
  name: string;
}

interface UnifiedEntry {
  title?: string;
  subline?: string;
  resourceUrl?: string;
  attributes?: Record<string, unknown>;
}

export function registerSearchTools(server: McpServer, client: NextcloudClient): void {
  registerRead(
    server,
    {
      name: "nextcloud_search_file_contents",
      title: "Search text inside files",
      description:
        "Search for a word or phrase INSIDE files below a folder and return the matching lines.\n\n" +
        "Reads the most recently changed readable files (text, CSV, Markdown, PDF, Word, Excel, PowerPoint, " +
        "OpenDocument) one by one, so it is bounded by 'max_files' — narrow 'path' to the right folder for " +
        "best results. Scanned PDFs without a text layer cannot be searched.\n\n" +
        "To find files by NAME use nextcloud_search_files (much faster). If the server has a full-text index, " +
        "nextcloud_unified_search may also find content across all files.",
      inputSchema: {
        query: z.string().min(2).describe("Word or phrase to find (plain text, not a regex)."),
        path: z.string().default("/").describe("Folder to search below. The narrower, the better."),
        documents: z
          .boolean()
          .default(true)
          .describe("Also search PDF and office documents (slower). false = only plain text files."),
        modified_after: z.string().optional().describe("Only files changed on/after this date (YYYY-MM-DD)."),
        max_files: z.number().int().min(1).max(200).default(40).describe("How many files to read at most (newest first)."),
        max_matches_per_file: z.number().int().min(1).max(50).default(5),
        case_sensitive: z.boolean().default(false),
        response_format: formatSchema,
      },
    },
    async (args: Args): Promise<ToolResult> => {
      const scope = normalizePath(args.path as string);
      const query = (args.query as string).trim();
      const conditions: SearchCondition[] = [
        { op: "or", conditions: args.documents === false ? TEXT_ONLY : READABLE_TYPES },
        { op: "lte", prop: "oc:size", value: MAX_READ_BYTES },
      ];
      if (args.modified_after) {
        const ms = Date.parse(`${args.modified_after as string}T00:00:00Z`);
        if (Number.isNaN(ms)) return { content: [{ type: "text", text: "Error: 'modified_after' must be YYYY-MM-DD." }], isError: true };
        conditions.push({ op: "gte", prop: "d:getlastmodified", value: Math.floor(ms / 1000) });
      }
      const maxFiles = args.max_files as number;
      // One more than needed tells us whether the limit cut the candidates off.
      const candidates = await search(client, {
        scope,
        conditions,
        orderBy: [{ prop: "d:getlastmodified", descending: true }],
        limit: maxFiles + 1,
        offset: 0,
      });
      const capped = candidates.length > maxFiles;
      const files = candidates.slice(0, maxFiles);

      const skipped: string[] = [];
      const scanned = await mapLimit(files, CONCURRENCY, async (entry: FileEntry) => {
        try {
          const response = await client.send(await client.filesPath(entry.path), { transfer: true });
          const data = await readCapped(response, MAX_READ_BYTES, displayPath(entry.path));
          const kind = extractKind(entry.name, entry.mime);
          const text = kind ? (await extractText(data, kind)).text : decodeText(data, true);
          if (text === undefined) return undefined;
          const { matches, count } = findMatches(text, query, args.case_sensitive === true, args.max_matches_per_file as number);
          return count > 0 ? { entry, matches, count } : undefined;
        } catch (error) {
          skipped.push(`${displayPath(entry.path)} (${error instanceof Error ? error.message : String(error)})`);
          return undefined;
        }
      });
      const hits = scanned.filter((h): h is NonNullable<typeof h> => h !== undefined);

      const data = {
        query,
        scope: displayPath(scope),
        files_read: files.length,
        more_files_not_read: capped,
        files_with_matches: hits.length,
        ...(skipped.length ? { unreadable: skipped } : {}),
        items: hits.map((h) => ({
          path: displayPath(h.entry.path),
          modified: h.entry.modified,
          match_count: h.count,
          matches: h.matches,
          web_url: webUrl(client, h.entry),
        })),
      };
      return buildResult(data, args.response_format as ResponseFormat, (d) => {
        const lines = [
          `# '${query}' in ${hits.length} of ${files.length} files read below ${displayPath(scope)}`,
          "",
        ];
        for (const item of d.items as typeof data.items) {
          lines.push(`## ${item.path} — ${item.match_count} match${item.match_count === 1 ? "" : "es"}`);
          for (const m of item.matches) lines.push(`- line ${m.line}: ${m.text}`);
          lines.push("");
        }
        if (hits.length === 0) lines.push("No matches.");
        if (capped) {
          lines.push(
            `> Only the ${files.length} most recently changed readable files were searched. ` +
              "Narrow 'path', set 'modified_after', or raise 'max_files' to search further.",
          );
        }
        if (skipped.length) lines.push(`> ${skipped.length} file(s) could not be read: ${skipped.slice(0, 5).join("; ")}`);
        return lines.join("\n");
      }, "files");
    },
  );

  let providers: Promise<Provider[]> | undefined;
  const loadProviders = (): Promise<Provider[]> => {
    providers ??= client.ocs<{ id: string; name: string }[]>("/search/providers").then((list) =>
      (Array.isArray(list) ? list : []).map((p) => ({ id: String(p.id), name: String(p.name) })),
    );
    providers.catch(() => {
      providers = undefined;
    });
    return providers;
  };

  registerRead(
    server,
    {
      name: "nextcloud_unified_search",
      title: "Nextcloud unified search",
      description:
        "Nextcloud's own search box: one term across the installed apps — file names, and depending on the server " +
        "also calendar events, contacts, Talk messages, Deck cards, notes, mail, and file CONTENTS when the " +
        "full-text search app is installed (provider 'fulltextsearch').\n\n" +
        "Without 'providers' all apps are searched and the result lists the provider IDs; pass 'providers' " +
        "(e.g. ['files']) to narrow a follow-up search.",
      inputSchema: {
        term: z.string().min(1).describe("Search term."),
        providers: z.array(z.string()).optional().describe("Provider IDs to search, e.g. ['files', 'calendar']. Default: all."),
        limit: z.number().int().min(1).max(25).default(5).describe("Results per provider (default 5)."),
        response_format: formatSchema,
      },
    },
    async (args: Args): Promise<ToolResult> => {
      const all = await loadProviders();
      const wanted = args.providers as string[] | undefined;
      const unknown = wanted?.filter((id) => !all.some((p) => p.id === id)) ?? [];
      const selected = wanted?.length ? all.filter((p) => wanted.includes(p.id)) : all;
      const term = args.term as string;

      const groups = await mapLimit(selected, 6, async (provider) => {
        try {
          const data = await client.ocs<{ name?: string; entries?: UnifiedEntry[] }>(
            `/search/providers/${encodeURIComponent(provider.id)}/search`,
            { query: { term, limit: args.limit as number } },
          );
          const entries = (data?.entries ?? []).map((e) => ({
            title: e.title ?? "",
            ...(e.subline ? { subline: e.subline } : {}),
            ...(e.resourceUrl ? { url: e.resourceUrl.startsWith("/") ? `${new URL(client.baseUrl).origin}${e.resourceUrl}` : e.resourceUrl } : {}),
          }));
          return { provider: provider.id, name: data?.name ?? provider.name, entries };
        } catch (error) {
          return { provider: provider.id, name: provider.name, entries: [], error: error instanceof Error ? error.message : String(error) };
        }
      });
      const withResults = groups.filter((g) => g.entries.length > 0);

      const data = {
        term,
        providers_searched: selected.map((p) => p.id),
        ...(unknown.length ? { unknown_providers: unknown, available_providers: all.map((p) => p.id) } : {}),
        items: withResults,
      };
      return buildResult(data, args.response_format as ResponseFormat, (d) => {
        const lines = [`# Unified search for '${term}'`, ""];
        for (const g of d.items as typeof withResults) {
          lines.push(`## ${g.name} (\`${g.provider}\`)`);
          for (const e of g.entries) lines.push(`- **${e.title}**${e.subline ? ` — ${e.subline}` : ""}${e.url ? ` <${e.url}>` : ""}`);
          lines.push("");
        }
        if (withResults.length === 0) lines.push("No results.");
        if (unknown.length) lines.push(`Unknown provider IDs: ${unknown.join(", ")}. Available: ${all.map((p) => p.id).join(", ")}.`);
        else lines.push(`Searched: ${selected.map((p) => p.id).join(", ")}.`);
        const failed = groups.filter((g) => "error" in g);
        if (failed.length) lines.push(`Failed: ${failed.map((g) => g.provider).join(", ")}.`);
        return lines.join("\n");
      }, "provider groups");
    },
  );
}

