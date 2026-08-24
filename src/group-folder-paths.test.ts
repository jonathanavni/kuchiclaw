import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/kuchiclaw-groups-${process.pid}`;
  return { root, groups: `${root}/groups`, ipc: `${root}/ipc` };
});

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    GROUPS_DIR: roots.groups,
    IPC_DIR: roots.ipc,
    MAIN_CHAT_ID: "tg-999",
  };
});

import { ensureGroupFolder } from "./group-folder.js";

beforeEach(() => {
  fs.rmSync(roots.root, { recursive: true, force: true });
  fs.mkdirSync(roots.groups, { recursive: true });
  fs.mkdirSync(roots.ipc, { recursive: true });
});

afterEach(() => fs.rmSync(roots.root, { recursive: true, force: true }));

describe("per-group folder paths", () => {
  it("creates a distinct IPC namespace for the group", () => {
    const paths = ensureGroupFolder("tg-123");
    expect(paths.ipc).toBe(path.join(roots.ipc, "tg-123"));
    expect(fs.lstatSync(paths.ipc).isDirectory()).toBe(true);
  });

  it("refuses a symlinked IPC namespace before mounting it", () => {
    const target = path.join(roots.root, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "sentinel"), "untouched");
    fs.symlinkSync(target, path.join(roots.ipc, "tg-123"));
    expect(() => ensureGroupFolder("tg-123")).toThrow(/not a real directory/);
    expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("untouched");
  });

  it("refuses a symlinked group directory", () => {
    const target = path.join(roots.root, "group-target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(roots.groups, "tg-123"));
    expect(() => ensureGroupFolder("tg-123")).toThrow(/not a real directory/);
  });
});
