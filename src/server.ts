/**
 * Builds one McpServer with every tool registered.
 *
 * Shared by both transports: stdio builds one for the process, HTTP builds one
 * per request for the person behind that request's token.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION, WRITES_ENABLED } from "./constants.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import type { NextcloudClient } from "./services/client.js";
import { registerFileReadTools } from "./tools/files.js";
import { registerMetaTools } from "./tools/meta.js";
import { type ServerContext, setServerContext } from "./tools/registry.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWriteTools } from "./tools/write.js";

export interface CreateServerOptions {
  /** Defaults to NEXTCLOUD_ENABLE_WRITES. */
  writesEnabled?: boolean;
  /** Hosted (multi-user) mode: no local file paths in tools. */
  hosted?: boolean;
  /** Appended to the server instructions. */
  extraInstructions?: string;
  icons?: Icon[];
}

export function createNextcloudServer(
  client: NextcloudClient,
  options: CreateServerOptions = {},
): { server: McpServer; context: ServerContext } {
  const instructions = options.extraInstructions ? `${SERVER_INSTRUCTIONS}\n\n${options.extraInstructions}` : SERVER_INSTRUCTIONS;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, ...(options.icons?.length ? { icons: options.icons } : {}) },
    { instructions },
  );
  const context: ServerContext = {
    writesEnabled: options.writesEnabled ?? WRITES_ENABLED,
    hosted: options.hosted ?? false,
    stats: { read: 0, write: 0, skipped: 0 },
  };
  setServerContext(server, context);

  registerFileReadTools(server, client);
  registerSearchTools(server, client);
  registerMetaTools(server, client);
  registerWriteTools(server, client);

  return { server, context };
}
