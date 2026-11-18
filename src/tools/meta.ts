/** Account, server and trash bin tools. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION, TIMEOUT_MS, USER_AGENT } from "../constants.js";
import type { NextcloudClient } from "../services/client.js";
import { type ResponseFormat, type ToolResult, buildResult, formatBytes, formatDate } from "../services/format.js";
import { listTrash } from "../services/webdav.js";
import { formatSchema } from "./files.js";
import { type Args, registerRead, serverContext } from "./registry.js";

interface CloudUser {
  id?: string;
  displayname?: string;
  email?: string | null;
  groups?: string[];
  language?: string;
  locale?: string;
  quota?: { free?: number; used?: number; total?: number; relative?: number; quota?: number };
}

/** status.php needs no login; returns the version string or null. */
export async function serverVersion(baseUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/status.php`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, 10_000)),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { versionstring?: string };
    return body.versionstring ?? null;
  } catch {
    return null;
  }
}

export function registerMetaTools(server: McpServer, client: NextcloudClient): void {
  registerRead(
    server,
    {
      name: "nextcloud_whoami",
      title: "Current user and server",
      description:
        "Who is connected: Nextcloud user, display name, e-mail, groups, storage quota, plus the Nextcloud server " +
        "and whether this MCP server allows changes (upload, create, move, delete). Call this when unsure whether " +
        "a write tool should exist.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const [user, version] = await Promise.all([client.ocs<CloudUser>("/cloud/user"), serverVersion(client.baseUrl)]);
      const quota = user.quota ?? {};
      const unlimited = typeof quota.quota === "number" && quota.quota < 0;
      const writes = serverContext(server).writesEnabled;
      const data = {
        user_id: user.id,
        display_name: user.displayname,
        email: user.email ?? null,
        groups: user.groups ?? [],
        quota: { used: quota.used ?? null, total: unlimited ? null : (quota.total ?? null), free: unlimited ? null : (quota.free ?? null), unlimited },
        server: client.baseUrl,
        nextcloud_version: version,
        mcp_server: `${SERVER_NAME} ${SERVER_VERSION}`,
        writes_enabled: writes,
      };
      const text = [
        `# ${user.displayname ?? user.id} (\`${user.id}\`)`,
        "",
        user.email ? `- **E-mail**: ${user.email}` : "",
        `- **Groups**: ${(user.groups ?? []).join(", ") || "–"}`,
        `- **Storage**: ${formatBytes(quota.used)} used${unlimited ? " (no quota)" : ` of ${formatBytes(quota.total)} (${formatBytes(quota.free)} free)`}`,
        `- **Nextcloud**: ${client.baseUrl}${version ? ` (version ${version})` : ""}`,
        `- **Changes allowed**: ${writes ? "yes — upload, create, move, copy and delete tools are available" : "no — this server is read-only (writes are enabled by the server operator with NEXTCLOUD_ENABLE_WRITES=true)"}`,
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], structuredContent: data };
    },
  );

  registerRead(
    server,
    {
      name: "nextcloud_list_trash",
      title: "List trash bin",
      description:
        "List deleted files and folders in the user's trash bin, newest first, with their original location. " +
        "Restore one with nextcloud_restore_from_trash (needs write access) or in the Nextcloud web interface.",
      inputSchema: {
        query: z.string().optional().describe("Only items whose name contains this text (case-insensitive)."),
        limit: z.number().int().min(1).max(500).default(50),
        response_format: formatSchema,
      },
    },
    async (args: Args): Promise<ToolResult> => {
      let items = await listTrash(client);
      const query = (args.query as string | undefined)?.trim().toLowerCase();
      if (query) items = items.filter((i) => i.name.toLowerCase().includes(query) || i.original_location.toLowerCase().includes(query));
      items.sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""));
      const total = items.length;
      items = items.slice(0, args.limit as number);
      const data = { total, count: items.length, items };
      return buildResult(data, args.response_format as ResponseFormat, (d) => {
        if (total === 0) return query ? `Nothing in the trash bin matches '${query}'.` : "The trash bin is empty.";
        const rows = (d.items as typeof items).map(
          (i) => `| ${i.name}${i.type === "folder" ? "/" : ""} | ${i.original_location} | ${formatDate(i.deleted_at)} | ${formatBytes(i.size)} | \`${i.trash_id}\` |`,
        );
        return [
          `# Trash bin — ${d.items.length} of ${total}`,
          "",
          "| Name | Original location | Deleted | Size | trash_id |",
          "|---|---|---|---|---|",
          ...rows,
        ].join("\n");
      }, "items");
    },
  );
}
