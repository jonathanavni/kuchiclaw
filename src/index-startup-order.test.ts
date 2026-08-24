import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  getSecrets: vi.fn(),
  channelConstructed: vi.fn(),
  channelConnect: vi.fn(),
  enqueue: vi.fn(),
  ensureGroupFolder: vi.fn(),
  quarantineRoot: vi.fn(),
  registerSender: vi.fn(),
  startPolling: vi.fn(),
  startScheduler: vi.fn(),
}));

vi.mock("./auth.js", () => ({ getSecrets: effects.getSecrets }));
vi.mock("./channels/telegram.js", () => ({
  TelegramChannel: class {
    constructor() { effects.channelConstructed(); }
    connect() { effects.channelConnect(); }
  },
}));
vi.mock("./group-folder.js", () => ({ ensureGroupFolder: effects.ensureGroupFolder }));
vi.mock("./group-queue.js", () => ({ enqueue: effects.enqueue, shutdown: vi.fn() }));
vi.mock("./ipc.js", () => ({
  quarantineLooseRootRequests: effects.quarantineRoot,
  registerSender: effects.registerSender,
  startPolling: effects.startPolling,
  stopPolling: vi.fn(),
}));
vi.mock("./task-scheduler.js", () => ({
  startScheduler: effects.startScheduler,
  stopScheduler: vi.fn(),
}));

import { main } from "./index.js";

describe("startup gate ordering", () => {
  it("refuses legacy state before recovery, folders, channel setup, or polling", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-order-"));
    const ipcDir = path.join(root, "ipc");
    fs.mkdirSync(ipcDir);
    fs.writeFileSync(path.join(ipcDir, "legacy.json"), "{}");

    await expect(main({
      ipcDir,
      markerPath: path.join(root, "ipc-layout-v2"),
      inspectDb: () => ({ exists: true, userVersion: 1, scheduledTaskCount: 1 }),
      initializeEpoch: vi.fn(),
    })).rejects.toThrow(/cutover/);

    expect(effects.getSecrets).not.toHaveBeenCalled();
    expect(effects.channelConstructed).not.toHaveBeenCalled();
    expect(effects.channelConnect).not.toHaveBeenCalled();
    expect(effects.enqueue).not.toHaveBeenCalled();
    expect(effects.ensureGroupFolder).not.toHaveBeenCalled();
    expect(effects.quarantineRoot).not.toHaveBeenCalled();
    expect(effects.registerSender).not.toHaveBeenCalled();
    expect(effects.startPolling).not.toHaveBeenCalled();
    expect(effects.startScheduler).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
