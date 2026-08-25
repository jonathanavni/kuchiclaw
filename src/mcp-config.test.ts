import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mcpConfig = vi.hoisted(() => ({
  path: `/tmp/kuchiclaw-mcp-config-${process.pid}.json`,
}));
vi.mock("./config.js", () => ({ MCP_SERVERS_PATH: mcpConfig.path }));

import { loadMcpServers } from "./mcp-config.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(mcpConfig.path, { force: true });
  vi.restoreAllMocks();
});

describe("MCP environment tripwire", () => {
  it("names env-bearing servers and keys without logging values", () => {
    fs.writeFileSync(mcpConfig.path, JSON.stringify({
      mail: {
        command: "mail-mcp",
        env: { MAIL_TOKEN: "secret-never-log", MAIL_ACCOUNT: "private-never-log" },
      },
      plain: { command: "plain-mcp" },
    }));

    expect(loadMcpServers()).toHaveProperty("mail");
    expect(console.warn).toHaveBeenCalledWith(
      '[Security] MCP server "mail" env keys (MAIL_TOKEN, MAIL_ACCOUNT) are visible to all groups',
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("secret-never-log");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private-never-log");
  });
});
