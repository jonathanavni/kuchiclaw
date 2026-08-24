import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollOnce,
  quarantineLooseRootRequests,
  registerSender,
  startPolling,
  stopPolling,
} from "./ipc.js";
import { IPC_POLL_MS, MAX_REQUEST_BYTES } from "./config.js";

interface Roots { root: string; ipc: string; errors: string }
let roots: Roots;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-ipc-"));
  roots = { root, ipc: path.join(root, "ipc"), errors: path.join(root, "errors") };
  fs.mkdirSync(roots.ipc);
  registerSender(async () => {});
});

afterEach(() => {
  stopPolling();
  vi.useRealTimers();
  fs.rmSync(roots.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function namespace(group = "tg-123"): string {
  const dir = path.join(roots.ipc, group);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function request(text = "hello", chatId = "123"): string {
  return JSON.stringify({ op: "message", chatId, text });
}

describe("IPC filesystem containment", () => {
  it("skips a main namespace when MAIN_CHAT_ID is unset", async () => {
    const dir = namespace("main");
    const file = path.join(dir, "request.json");
    fs.writeFileSync(file, request());
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("quarantines loose root JSON without processing it", () => {
    const loose = path.join(roots.ipc, "legacy.json");
    fs.writeFileSync(loose, request());
    const sender = vi.fn();
    registerSender(sender);
    quarantineLooseRootRequests(roots.ipc, roots.errors);
    expect(sender).not.toHaveBeenCalled();
    expect(fs.existsSync(loose)).toBe(false);
    expect(fs.readdirSync(roots.errors)[0]).toContain("root-legacy.json");
  });

  it("skips a symlinked namespace without touching its target", async () => {
    const target = path.join(roots.root, "target");
    fs.mkdirSync(target);
    const planted = path.join(target, "request.json");
    fs.writeFileSync(planted, request());
    fs.symlinkSync(target, path.join(roots.ipc, "tg-123"));
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    expect(fs.readFileSync(planted, "utf8")).toBe(request());
  });

  it("quarantines a symlinked request and leaves its target untouched", async () => {
    const dir = namespace();
    const target = path.join(roots.root, "target.json");
    fs.writeFileSync(target, request());
    fs.symlinkSync(target, path.join(dir, "link.json"));
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    expect(fs.readFileSync(target, "utf8")).toBe(request());
    expect(fs.readdirSync(roots.errors).some((name) => name.includes("tg-123-link.json"))).toBe(true);
  });

  it("opens a FIFO nonblocking and quarantines it", async () => {
    const fifo = path.join(namespace(), "pipe.json");
    execFileSync("mkfifo", [fifo]);
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    expect(fs.existsSync(fifo)).toBe(false);
    expect(fs.readdirSync(roots.errors)).toHaveLength(1);
  });

  it("quarantines hardlinked requests", async () => {
    const original = path.join(roots.root, "original.json");
    fs.writeFileSync(original, request());
    fs.linkSync(original, path.join(namespace(), "hardlink.json"));
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    expect(fs.readFileSync(original, "utf8")).toBe(request());
    expect(fs.readdirSync(roots.errors)).toHaveLength(1);
  });

  it("detects growth after fstat with the MAX+1 bounded read", async () => {
    const file = path.join(namespace(), "growing.json");
    fs.writeFileSync(file, request());
    const originalRead = fs.readSync.bind(fs);
    let appended = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!appended) {
        appended = true;
        fs.appendFileSync(file, "x".repeat(MAX_REQUEST_BYTES + 1));
      }
      return originalRead(...args);
    });
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    expect(fs.readdirSync(roots.errors)).toHaveLength(1);
  });

  it("retries fresh partial JSON, then quarantines after the deadline", async () => {
    const file = path.join(namespace(), "partial.json");
    fs.writeFileSync(file, '{"op":"message"');
    const firstSeen = new Map<string, number>();
    let time = 1_000;
    const options = { ipcDir: roots.ipc, errorsDir: roots.errors, firstSeen, now: () => time };
    await pollOnce(options);
    expect(fs.existsSync(file)).toBe(true);
    time += 10_001;
    await pollOnce(options);
    expect(fs.existsSync(file)).toBe(false);
    expect(firstSeen.size).toBe(0);
  });

  it("drops firstSeen state when a partial file disappears", async () => {
    const file = path.join(namespace(), "partial.json");
    fs.writeFileSync(file, "{");
    const firstSeen = new Map<string, number>();
    const options = { ipcDir: roots.ipc, errorsDir: roots.errors, firstSeen };
    await pollOnce(options);
    expect(firstSeen.size).toBe(1);
    fs.unlinkSync(file);
    await pollOnce(options);
    expect(firstSeen.size).toBe(0);
  });
});

describe("IPC polling bounds", () => {
  it("caps each namespace independently and uses sorted order", async () => {
    const first = namespace("tg-1");
    const second = namespace("tg-2");
    for (let i = 0; i < 100; i += 1) {
      fs.writeFileSync(path.join(first, `request-${i}.json`), request(String(i), "1"));
    }
    fs.writeFileSync(path.join(second, "request.json"), request("other", "2"));
    const sent: string[] = [];
    registerSender(async (_chatId, text) => { sent.push(text); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pollOnce({ ipcDir: roots.ipc, errorsDir: roots.errors });
    const expected = Array.from({ length: 100 }, (_, i) => `request-${i}.json`)
      .sort().slice(0, 64).map((name) => name.match(/\d+/)![0]);
    expect(sent.slice(0, 64)).toEqual(expected);
    expect(sent).toContain("other");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"tg-1"'));
  });

  it("does not re-arm while a slow send is still running", async () => {
    vi.useFakeTimers();
    const file = path.join(namespace(), "slow.json");
    fs.writeFileSync(file, request());
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sender = vi.fn(async () => blocked);
    registerSender(sender);
    startPolling({ ipcDir: roots.ipc, errorsDir: roots.errors });

    await vi.advanceTimersByTimeAsync(IPC_POLL_MS);
    expect(sender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(IPC_POLL_MS * 3);
    expect(sender).toHaveBeenCalledTimes(1);
    release();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});
