/**
 * Tool registration helpers.
 *
 * `registerRead` always registers. `registerWrite` only registers when writes
 * are enabled for the server, so a default install cannot change or delete
 * files and read-only sessions keep a lean tool list.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { formatError } from "../services/client.js";
import { InvalidPathError } from "../services/paths.js";
import { type ToolResult, textResult } from "../services/format.js";

export interface ToolSpec<Shape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** True for tools that delete or overwrite data. */
  destructive?: boolean;
  /** True when repeating the call has no additional effect. */
  idempotent?: boolean;
}

export interface RegistrationStats {
  read: number;
  write: number;
  skipped: number;
}

export interface ServerContext {
  writesEnabled: boolean;
  /**
   * Hosted (multi-user) mode. Tools must then never touch the server's file
   * system on a caller's behalf: no caller-chosen paths for downloads/uploads.
   */
  hosted: boolean;
  stats: RegistrationStats;
}

const contexts = new WeakMap<McpServer, ServerContext>();

/** Must be called before any tool is registered on `server`. */
export function setServerContext(server: McpServer, context: ServerContext): void {
  contexts.set(server, context);
}

export function serverContext(server: McpServer): ServerContext {
  const context = contexts.get(server);
  if (!context) throw new Error("setServerContext() must run before tools are registered");
  return context;
}

export function isHosted(server: McpServer): boolean {
  return serverContext(server).hosted;
}

/**
 * Validated tool arguments. The Zod schema passed as `inputSchema` is the real
 * validation boundary — the SDK rejects malformed calls before a handler runs.
 */
export type Args = Record<string, unknown>;
export type Handler = (args: Args) => Promise<ToolResult>;

/** Wraps a handler so no thrown error ever escapes as a protocol-level failure. */
function guard(handler: Handler): Handler {
  return async (args: Args): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof InvalidPathError) return textResult(`Error: ${error.message}`, true);
      return textResult(formatError(error), true);
    }
  };
}

export function registerRead<Shape extends ZodRawShape>(server: McpServer, spec: ToolSpec<Shape>, handler: Handler): void {
  const context = serverContext(server);
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(handler) as never,
  );
  context.stats.read++;
}

export function registerWrite<Shape extends ZodRawShape>(server: McpServer, spec: ToolSpec<Shape>, handler: Handler): void {
  const context = serverContext(server);
  if (!context.writesEnabled) {
    context.stats.skipped++;
    return;
  }
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: spec.destructive ?? false,
        idempotentHint: spec.idempotent ?? false,
        openWorldHint: false,
      },
    },
    guard(handler) as never,
  );
  context.stats.write++;
}
