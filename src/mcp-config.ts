import fs from "node:fs";
import { MCP_SERVERS_PATH } from "./config.js";
import type { McpServerConfig } from "./types.js";

/** Load MCP server configs from mcp-servers.json (if it exists). */
export function loadMcpServers(): Record<string, McpServerConfig> | undefined {
  if (!fs.existsSync(MCP_SERVERS_PATH)) return undefined;
  try {
    const raw = fs.readFileSync(MCP_SERVERS_PATH, "utf-8");
    const servers = JSON.parse(raw) as Record<string, McpServerConfig>;
    const count = Object.keys(servers).length;
    if (count > 0) {
      console.log(`[Orchestrator] Loaded ${count} MCP server(s) from mcp-servers.json`);
      return servers;
    }
  } catch (err) {
    console.warn(`[Orchestrator] Failed to load mcp-servers.json: ${err}`);
  }
  return undefined;
}
