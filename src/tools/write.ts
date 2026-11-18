/**
 * Tools that change files: create folders, write and upload files, move, copy,
 * delete (to the trash bin) and restore. Registered only when writes are enabled.
 *
 * Nothing is overwritten unless the caller passes overwrite=true: uploads send
 * `If-None-Match: *`, MOVE/COPY send `Overwrite: F`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type NextcloudClient, NextcloudApiError } from "../services/client.js";
import { type ToolResult, formatBytes, textResult } from "../services/format.js";
import { baseName, displayPath, joinPath, normalizePath, parentPath } from "../services/paths.js";
import { stat } from "../services/webdav.js";
import { pathSchema, webUrl } from "./files.js";
import { type Args, registerWrite } from "./registry.js";
import { mimeFor, readUpload, uploadShape } from "./transfer.js";

const overwriteSchema = z
  .boolean()
  .default(false)
  .describe("Replace an existing file at the target. Default false: fail instead of overwriting.");

/** Creates `path` and any missing parent folders. Returns the folders actually created. */
async function ensureFolder(client: NextcloudClient, path: string): Promise<string[]> {
  if (path === "") return [];
  const response = await client.send(await client.filesPath(path), { method: "MKCOL", allowStatus: [405, 409] });
  await response.body?.cancel();
  if (response.status === 201) return [path];
  if (response.status === 405) {
    // Something exists there already: fine if it is a folder.
    const existing = await stat(client, path);
    if (existing?.type === "folder") return [];
    throw new NextcloudApiError(405, "MKCOL", displayPath(path), `${displayPath(path)} exists and is a file, not a folder`);
  }
  // 409: the parent is missing.
  const created = await ensureFolder(client, parentPath(path));
  const retry = await client.send(await client.filesPath(path), { method: "MKCOL", allowStatus: [405] });
  await retry.body?.cancel();
  return retry.status === 201 ? [...created, path] : created;
}

/** PUTs a file, creating missing parent folders. Returns whether it replaced an existing file. */
async function putFile(
  client: NextcloudClient,
  path: string,
  data: Uint8Array | string,
  contentType: string,
  overwrite: boolean,
): Promise<{ replaced: boolean; createdFolders: string[] }> {
  const send = async (): Promise<Response> =>
    client.send(await client.filesPath(path), {
      method: "PUT",
      headers: { "Content-Type": contentType, ...(overwrite ? {} : { "If-None-Match": "*" }) },
      body: data,
      transfer: true,
      allowStatus: [409],
    });
  let response = await send();
  let createdFolders: string[] = [];
  if (response.status === 409) {
    await response.body?.cancel();
    createdFolders = await ensureFolder(client, parentPath(path));
    response = await send();
    if (response.status === 409) throw new NextcloudApiError(409, "PUT", displayPath(path), "the parent folder could not be created");
  }
  await response.body?.cancel();
  return { replaced: response.status === 204, createdFolders };
}

/** "folder/" as destination means "into this folder, same name". */
function resolveDestination(source: string, rawDestination: string): string {
  const destination = normalizePath(rawDestination);
  return rawDestination.trim().endsWith("/") ? joinPath(destination, baseName(source)) : destination;
}

async function savedMessage(client: NextcloudClient, path: string, verb: string, extra: string[]): Promise<ToolResult> {
  const entry = await stat(client, path);
  const url = entry ? webUrl(client, entry) : null;
  const text = [`${verb} ${displayPath(path)}${entry ? ` (${formatBytes(entry.size)})` : ""}.`, ...extra, url ? `Open in Nextcloud: ${url}` : ""]
    .filter(Boolean)
    .join("\n");
  return { content: [{ type: "text", text }], structuredContent: { path: displayPath(path), size: entry?.size ?? null, file_id: entry?.file_id ?? null, web_url: url } };
}

export function registerWriteTools(server: McpServer, client: NextcloudClient): void {
  registerWrite(
    server,
    {
      name: "nextcloud_create_folder",
      title: "Create folder",
      description: "Create a folder, including any missing parent folders. Succeeds without change if it already exists.",
      inputSchema: { path: pathSchema("Folder path to create") },
      idempotent: true,
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      if (path === "") return textResult("Error: the root folder always exists.", true);
      const created = await ensureFolder(client, path);
      return textResult(
        created.length === 0
          ? `${displayPath(path)} already exists.`
          : `Created ${created.map(displayPath).join(", ")}.`,
      );
    },
  );

  registerWrite(
    server,
    {
      name: "nextcloud_write_text_file",
      title: "Create or overwrite a text file",
      description:
        "Write text (Markdown, CSV, TXT, JSON, HTML, …) to a file, UTF-8 encoded. Missing parent folders are created.\n\n" +
        "Fails if the file exists unless overwrite=true. Overwriting keeps the old content as a Nextcloud version " +
        "(if the versions app is enabled). For binary files use nextcloud_upload_file.",
      inputSchema: {
        path: pathSchema("Target file path including the name, e.g. '/Reports/2026-11 summary.md'"),
        content: z.string().describe("The complete file content."),
        overwrite: overwriteSchema,
      },
      destructive: true,
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      if (path === "") return textResult("Error: 'path' must name a file.", true);
      const mime = mimeFor(path);
      const contentType = `${mime === "application/octet-stream" ? "text/plain" : mime}; charset=utf-8`;
      const { replaced, createdFolders } = await putFile(client, path, Buffer.from(args.content as string, "utf8"), contentType, args.overwrite === true);
      return savedMessage(client, path, replaced ? "Overwrote" : "Created", createdFolders.length ? [`Created folder(s): ${createdFolders.map(displayPath).join(", ")}.`] : []);
    },
  );

  registerWrite(
    server,
    {
      name: "nextcloud_upload_file",
      title: "Upload file",
      description:
        "Upload a file (any type) to Nextcloud. Missing parent folders are created.\n\n" +
        "'path' is the target including the file name; ending it with '/' uploads into that folder under the " +
        "source file's name (only with 'local_path'). Fails if the file exists unless overwrite=true.",
      inputSchema: {
        path: pathSchema("Target path, e.g. '/Invoices/2026/invoice-4711.pdf' or '/Invoices/2026/'"),
        ...uploadShape(server),
        overwrite: overwriteSchema,
      },
      destructive: true,
    },
    async (args: Args): Promise<ToolResult> => {
      const source = await readUpload(server, args);
      if (typeof source === "string") return textResult(source, true);
      let path = normalizePath(args.path as string);
      if ((args.path as string).trim().endsWith("/") || path === "") {
        if (!source.sourceName) return textResult("Error: 'path' must include the file name when uploading base64 content.", true);
        path = joinPath(path, source.sourceName);
      }
      const { replaced, createdFolders } = await putFile(client, path, source.data, mimeFor(path), args.overwrite === true);
      return savedMessage(client, path, replaced ? "Overwrote" : "Uploaded", createdFolders.length ? [`Created folder(s): ${createdFolders.map(displayPath).join(", ")}.`] : []);
    },
  );

  const transferTool = (kind: "move" | "copy"): void => {
    const method = kind === "move" ? "MOVE" : "COPY";
    registerWrite(
      server,
      {
        name: `nextcloud_${kind}`,
        title: kind === "move" ? "Move or rename" : "Copy",
        description:
          (kind === "move"
            ? "Move or rename a file or folder (folders move with their content). Shares and links stay attached.\n\n"
            : "Copy a file or folder (folders are copied with their content).\n\n") +
          "'destination' is the new full path; ending it with '/' means 'into this folder, same name'. " +
          "The destination's parent folder must exist (create it with nextcloud_create_folder). " +
          "Fails if the destination exists unless overwrite=true.",
        inputSchema: {
          source: pathSchema("Existing file or folder"),
          destination: pathSchema("New path, e.g. '/Archive/2025/report.pdf' or '/Archive/2025/'"),
          overwrite: overwriteSchema,
        },
        destructive: true,
      },
      async (args: Args): Promise<ToolResult> => {
        const source = normalizePath(args.source as string);
        if (source === "") return textResult(`Error: the root folder cannot be ${kind === "move" ? "moved" : "copied"}.`, true);
        const destination = resolveDestination(source, args.destination as string);
        if (destination === "") return textResult("Error: 'destination' must not be the root.", true);
        if (destination === source) return textResult("Error: source and destination are the same.", true);
        if (destination.startsWith(`${source}/`)) return textResult("Error: a folder cannot be moved or copied into itself.", true);
        const response = await client.send(await client.filesPath(source), {
          method,
          headers: { Destination: await client.filesUrl(destination), Overwrite: args.overwrite === true ? "T" : "F" },
        });
        await response.body?.cancel();
        const verb = kind === "move" ? "Moved" : "Copied";
        return savedMessage(client, destination, `${verb} ${displayPath(source)} to`, response.status === 204 ? ["(an existing item there was replaced)"] : []);
      },
    );
  };
  transferTool("move");
  transferTool("copy");

  registerWrite(
    server,
    {
      name: "nextcloud_delete",
      title: "Delete file or folder",
      description:
        "Delete a file or folder (folders with everything in them). With Nextcloud's trash bin enabled (default) the " +
        "item goes to the trash bin and can be restored with nextcloud_restore_from_trash; deleting an item someone " +
        "shared with the user only removes the share for this user.\n\n" +
        "Always confirm with the user before deleting, naming exactly what will be deleted.",
      inputSchema: { path: pathSchema("File or folder to delete") },
      destructive: true,
      idempotent: true,
    },
    async (args: Args): Promise<ToolResult> => {
      const path = normalizePath(args.path as string);
      if (path === "") return textResult("Error: refusing to delete the root folder.", true);
      const entry = await stat(client, path);
      if (!entry) return textResult(`${displayPath(path)} does not exist (already deleted?).`);
      const response = await client.send(await client.filesPath(path), { method: "DELETE" });
      await response.body?.cancel();
      const what = entry.type === "folder" ? `folder ${displayPath(path)} with its content (${formatBytes(entry.size)})` : `${displayPath(path)} (${formatBytes(entry.size)})`;
      return {
        content: [{ type: "text", text: `Deleted ${what}. It is in the trash bin unless trash is disabled on the server — nextcloud_list_trash shows it.` }],
        structuredContent: { deleted: displayPath(path), type: entry.type, size: entry.size },
      };
    },
  );

  registerWrite(
    server,
    {
      name: "nextcloud_restore_from_trash",
      title: "Restore from trash bin",
      description:
        "Restore a deleted item from the trash bin to its original location. Get 'trash_id' from nextcloud_list_trash. " +
        "If the original folder no longer exists, Nextcloud restores the item to the root.",
      inputSchema: { trash_id: z.string().min(1).describe("The trash_id from nextcloud_list_trash, e.g. 'report.pdf.d1731923456'.") },
    },
    async (args: Args): Promise<ToolResult> => {
      const id = (args.trash_id as string).trim();
      if (id.includes("/") || id === "." || id === "..") return textResult("Error: 'trash_id' is a single name from nextcloud_list_trash.", true);
      const user = encodeURIComponent(await client.userId());
      const item = encodeURIComponent(id);
      const response = await client.send(`/remote.php/dav/trashbin/${user}/trash/${item}`, {
        method: "MOVE",
        headers: { Destination: `${client.baseUrl}/remote.php/dav/trashbin/${user}/restore/${item}` },
      });
      await response.body?.cancel();
      return textResult(`Restored '${id}' from the trash bin to its original location.`);
    },
  );
}
