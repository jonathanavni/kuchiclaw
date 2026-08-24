import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceStartupGate } from "./index.js";

let root: string;
let ipcDir: string;
let markerPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-startup-"));
  ipcDir = path.join(root, "ipc");
  markerPath = path.join(root, "ipc-layout-v2");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    mainChatId: "tg-999",
    allowedSenderIds: ["7"],
    ipcDir,
    markerPath,
    inspectDb: () => ({ exists: false, userVersion: 0, scheduledTaskCount: 0 }),
    initializeEpoch: vi.fn(),
    ...overrides,
  };
}

describe("IPC startup gate", () => {
  it.each(["whatsapp-99", "tg-01"])("refuses malformed MAIN_CHAT_ID %s", (mainChatId) => {
    const inspectDb = vi.fn();
    expect(() => enforceStartupGate(options({ mainChatId, inspectDb }))).toThrow(/Invalid MAIN_CHAT_ID/);
    expect(inspectDb).not.toHaveBeenCalled();
  });

  it("emits a prominent warning for an empty sender allowlist", () => {
    fs.writeFileSync(markerPath, "");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    enforceStartupGate(options({
      allowedSenderIds: [],
      inspectDb: () => ({ exists: true, userVersion: 2, scheduledTaskCount: 4 }),
    }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("[SECURITY] WARNING"));
  });

  it("refuses a markerless non-empty IPC root", () => {
    fs.mkdirSync(ipcDir);
    fs.writeFileSync(path.join(ipcDir, "legacy.json"), "{}");
    const initializeEpoch = vi.fn();
    expect(() => enforceStartupGate(options({ initializeEpoch }))).toThrow(/cutover/);
    expect(initializeEpoch).not.toHaveBeenCalled();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("does not trust an in-tree marker beside a planted main request", () => {
    const mainDir = path.join(ipcDir, "main");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, "ipc-layout-v2"), "");
    fs.writeFileSync(path.join(mainDir, "request.json"), "{}");
    expect(() => enforceStartupGate(options())).toThrow(/cutover/);
  });

  it("refuses an empty IPC root when legacy scheduled rows exist", () => {
    fs.mkdirSync(ipcDir);
    const initializeEpoch = vi.fn();
    expect(() => enforceStartupGate(options({
      inspectDb: () => ({ exists: true, userVersion: 1, scheduledTaskCount: 1 }),
      initializeEpoch,
    }))).toThrow(/cutover/);
    expect(initializeEpoch).not.toHaveBeenCalled();
  });

  it("refuses an existing DB with zero tasks and an empty IPC root", () => {
    fs.mkdirSync(ipcDir);
    const initializeEpoch = vi.fn();
    expect(() => enforceStartupGate(options({
      inspectDb: () => ({ exists: true, userVersion: 1, scheduledTaskCount: 0 }),
      initializeEpoch,
    }))).toThrow(/run deploy\/cutover-m12-p1\.sh/);
    expect(initializeEpoch).not.toHaveBeenCalled();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("requires the DB factor when the external marker exists", () => {
    fs.writeFileSync(markerPath, "");
    expect(() => enforceStartupGate(options({
      inspectDb: () => ({ exists: true, userVersion: 1, scheduledTaskCount: 0 }),
    }))).toThrow(/attestation mismatch/);
  });

  it("initializes both attestations when the DB and IPC root are absent", () => {
    const initializeEpoch = vi.fn();
    enforceStartupGate(options({ initializeEpoch }));
    expect(initializeEpoch).toHaveBeenCalledOnce();
    expect(fs.lstatSync(markerPath).isFile()).toBe(true);
  });
});
