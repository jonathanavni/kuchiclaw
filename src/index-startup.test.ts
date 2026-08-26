import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceStartupGate } from "./index.js";

let root: string;
let ipcDir: string;
let markerPath: string;
let initPendingPath: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-startup-"));
  ipcDir = path.join(root, "ipc");
  markerPath = path.join(root, "ipc-layout-v2");
  initPendingPath = path.join(root, "init-pending");
  dbPath = path.join(root, "kuchiclaw.db");
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
    initPendingPath,
    dbPath,
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

  it("refuses to start with an empty sender allowlist", () => {
    fs.writeFileSync(markerPath, "");
    expect(() => enforceStartupGate(options({
      allowedSenderIds: [],
      inspectDb: () => ({ exists: true, userVersion: 2, scheduledTaskCount: 4 }),
    }))).toThrow(/ALLOWED_SENDER_IDS is required/);
  });

  it("allows explicit allow-all with a prominent warning", () => {
    fs.writeFileSync(markerPath, "");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    enforceStartupGate(options({
      allowedSenderIds: ["*"],
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

  it.each([false, true])(
    "preserves a markerless empty user_version=0 DB without a sentinel (ipc root: %s)",
    (withIpcRoot) => {
      fs.writeFileSync(dbPath, "legacy-empty-db");
      if (withIpcRoot) fs.mkdirSync(ipcDir);
      const initializeEpoch = vi.fn();

      expect(() => enforceStartupGate(options({
        inspectDb: () => ({ exists: true, userVersion: 0, scheduledTaskCount: 0 }),
        initializeEpoch,
      }))).toThrow(/cutover/);

      expect(initializeEpoch).not.toHaveBeenCalled();
      expect(fs.readFileSync(dbPath, "utf8")).toBe("legacy-empty-db");
      expect(fs.existsSync(initPendingPath)).toBe(false);
    },
  );

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
    expect(fs.existsSync(initPendingPath)).toBe(false);
  });

  it("recovers a sentinel-proven aborted init and removes DB sidecars", () => {
    fs.writeFileSync(initPendingPath, "");
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      fs.writeFileSync(filePath, "aborted");
    }
    let initialized = false;
    const initializeEpoch = vi.fn(() => {
      expect(fs.existsSync(dbPath)).toBe(false);
      initialized = true;
      fs.writeFileSync(dbPath, "fresh");
    });

    enforceStartupGate(options({
      inspectDb: () => ({
        exists: fs.existsSync(dbPath),
        userVersion: initialized ? 2 : 0,
        scheduledTaskCount: 0,
      }),
      initializeEpoch,
    }));

    expect(initializeEpoch).toHaveBeenCalledOnce();
    expect(fs.readFileSync(dbPath, "utf8")).toBe("fresh");
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(initPendingPath)).toBe(false);
  });

  it.each(["after-sentinel", "after-db"] as const)(
    "recovers on the next start after crash injection %s",
    (crashPoint) => {
      let attempt = 0;
      let version = 0;
      const initializeEpoch = vi.fn(() => {
        attempt++;
        if (crashPoint === "after-db" || attempt > 1) {
          fs.writeFileSync(dbPath, `db-${attempt}`);
          version = 2;
        }
        if (attempt === 1) throw new Error(`injected ${crashPoint}`);
      });
      const gateOptions = options({
        inspectDb: () => ({
          exists: fs.existsSync(dbPath),
          userVersion: version,
          scheduledTaskCount: 0,
        }),
        initializeEpoch,
      });

      expect(() => enforceStartupGate(gateOptions)).toThrow(`injected ${crashPoint}`);
      expect(fs.existsSync(initPendingPath)).toBe(true);
      version = 0;

      enforceStartupGate(gateOptions);

      expect(initializeEpoch).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.existsSync(initPendingPath)).toBe(false);
    },
  );

  it("cleans a leftover sentinel after a crash between marker creation and cleanup", () => {
    let version = 0;
    const initializeEpoch = vi.fn(() => {
      fs.writeFileSync(dbPath, "fresh");
      version = 2;
    });
    const gateOptions = options({
      inspectDb: () => ({
        exists: fs.existsSync(dbPath),
        userVersion: version,
        scheduledTaskCount: 0,
      }),
      initializeEpoch,
    });
    const realUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce((filePath) => {
      expect(filePath).toBe(initPendingPath);
      throw new Error("injected after-marker");
    });

    expect(() => enforceStartupGate(gateOptions)).toThrow("injected after-marker");
    unlink.mockImplementation(realUnlink);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(initPendingPath)).toBe(true);

    enforceStartupGate(gateOptions);

    expect(initializeEpoch).toHaveBeenCalledOnce();
    expect(fs.existsSync(initPendingPath)).toBe(false);
  });
});
