/**
 * Moving file bytes between the caller and Nextcloud.
 *
 * Local (stdio) mode: the server runs on the caller's machine, so downloads are
 * streamed to a path the caller names and uploads can read a local file.
 *
 * Hosted mode: the server is shared. Caller-chosen paths would let anyone read
 * or overwrite files on the server (including its token database), so no file
 * paths are offered: downloads come back inside the tool result and uploads
 * arrive as base64.
 */

import { createWriteStream } from "node:fs";
import { rename, rm, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { MAX_INLINE_BYTES, MAX_UPLOAD_BYTES } from "../constants.js";
import { formatBytes } from "../services/format.js";
import { type Args, isHosted } from "./registry.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
};

export function mimeFor(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Reads a response body into memory, failing once it exceeds `max` bytes. */
export async function readCapped(response: Response, max: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel();
    throw new Error(`${label} is ${formatBytes(declared)}; the limit here is ${formatBytes(max)}.`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`${label} is larger than ${formatBytes(max)}, the limit here.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The output argument of the download tool: a local path in stdio mode, nothing when hosted. */
export function downloadShape(server: McpServer): ZodRawShape {
  if (isHosted(server)) return {};
  return {
    output_path: z
      .string()
      .min(1)
      .describe(
        "Absolute local path to save to, e.g. '/Users/me/Downloads/report.pdf'. " +
          "If it is an existing folder, the file keeps its Nextcloud name inside it.",
      ),
  };
}

export function downloadNote(server: McpServer): string {
  return isHosted(server)
    ? `The file is returned inside the result (images as an image, other files as an embedded resource), up to ${formatBytes(MAX_INLINE_BYTES)}.`
    : "The file is streamed to 'output_path' on this computer; its content is NOT loaded into the conversation, " +
        "so this works for large files. Returns the saved path and size.";
}

/** Stdio mode: streams a response body to a local file (via a .part file, renamed when complete). */
export async function saveToLocal(response: Response, outputPath: string, fileName: string): Promise<{ savedTo: string; bytes: number }> {
  if (!path.isAbsolute(outputPath)) throw new Error(`'output_path' must be absolute, got ${outputPath}`);
  let target = outputPath;
  try {
    if ((await fsStat(outputPath)).isDirectory()) target = path.join(outputPath, fileName);
  } catch {
    // does not exist yet: a file path
  }
  const part = `${target}.part`;
  try {
    if (!response.body) throw new Error("empty response body");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part));
    await rename(part, target);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return { savedTo: target, bytes: (await fsStat(target)).size };
}

/** Input arguments of the upload tool: a local path and/or base64, depending on mode. */
export function uploadShape(server: McpServer): ZodRawShape {
  const base64 = {
    content_base64: z
      .string()
      .min(1)
      .optional()
      .describe("The file content, base64-encoded (a data: URL prefix is accepted)."),
  };
  if (isHosted(server)) return base64;
  return {
    local_path: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute path of a file on this computer to upload. Alternative to content_base64."),
    ...base64,
  };
}

export interface UploadSource {
  data: Buffer;
  /** File name of the local source, when there is one. */
  sourceName?: string;
}

/** Resolves the upload arguments into bytes, or an error message for the caller. */
export async function readUpload(server: McpServer, args: Args): Promise<UploadSource | string> {
  let data: Buffer;
  let sourceName: string | undefined;
  if (typeof args.content_base64 === "string") {
    const cleaned = args.content_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(cleaned)) return "Error: 'content_base64' is not valid base64.";
    data = Buffer.from(cleaned, "base64");
  } else if (!isHosted(server) && typeof args.local_path === "string") {
    const localPath = args.local_path;
    if (!path.isAbsolute(localPath)) return `Error: 'local_path' must be absolute, got ${localPath}`;
    try {
      const info = await fsStat(localPath);
      if (!info.isFile()) return `Error: ${localPath} is not a file.`;
      if (info.size > MAX_UPLOAD_BYTES) {
        return `Error: ${localPath} is ${formatBytes(info.size)}; the upload limit is ${formatBytes(MAX_UPLOAD_BYTES)} (NEXTCLOUD_MAX_UPLOAD_MB).`;
      }
      const { readFile } = await import("node:fs/promises");
      data = await readFile(localPath);
    } catch (error) {
      return `Error: cannot read ${localPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
    sourceName = path.basename(localPath);
  } else {
    return isHosted(server)
      ? "Error: pass the file as 'content_base64'. For plain text use nextcloud_write_text_file instead."
      : "Error: pass 'local_path' or 'content_base64'. For plain text use nextcloud_write_text_file instead.";
  }
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    return `Error: the file is ${formatBytes(data.byteLength)}; the upload limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  }
  return { data, ...(sourceName ? { sourceName } : {}) };
}
