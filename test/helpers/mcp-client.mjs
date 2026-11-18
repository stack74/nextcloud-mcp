/**
 * Minimal MCP stdio client for tests.
 *
 * Spawns the built server, speaks JSON-RPC over its stdin/stdout, and exposes
 * initialize / tools/list / tools/call. Keeping this tiny avoids pulling the SDK's
 * client into the test path, so the tests exercise the real wire format.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = path.resolve(HERE, "../../dist/index.js");

/**
 * Starts the server and completes the MCP handshake.
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.env] extra environment variables
 * @param {string} [options.entry] server entry point (defaults to dist/index.js)
 * @param {boolean} [options.quiet] suppress the server's stderr
 */
export async function startServer(options = {}) {
  const { env = {}, entry = SERVER_ENTRY, quiet = true } = options;

  const child = spawn("node", [entry], {
    env: {
      ...process.env,
      // No credentials by default; tests pass NEXTCLOUD_URL and NEXTCLOUD_USER
      // + NEXTCLOUD_APP_PASSWORD for the fake Nextcloud they start.
      NEXTCLOUD_ALLOW_INSECURE_HTTP: "true",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.on("data", (d) => {
    stderr.push(d.toString());
    if (!quiet) process.stderr.write(`[server] ${d}`);
  });

  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`server wrote non-JSON to stdout (breaks MCP): ${line.slice(0, 200)}`);
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const initialize = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "nextcloud-mcp-tests", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    initialize: initialize.result,
    /** Lists the tools the server exposes. */
    async listTools() {
      const res = await send("tools/list", {});
      return res.result.tools;
    },
    /** Calls a tool. Returns { result } or { error } — never throws on tool errors. */
    async callTool(name, args = {}) {
      return send("tools/call", { name, arguments: args });
    },
    get stderr() {
      return stderr.join("");
    },
    stop() {
      child.kill();
    },
  };
}

