import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ensureGroupFolder } from "./group-folder.js";

describe("ensureGroupFolder identity boundary", () => {
  it.each(["../ipc/main", "wa-123", "tg-01", "main"])(
    "rejects %s before any filesystem operation",
    (group) => {
      const lstat = vi.spyOn(fs, "lstatSync");
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const write = vi.spyOn(fs, "writeFileSync");
      expect(() => ensureGroupFolder(group)).toThrow(/Invalid group name/);
      expect(lstat).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      lstat.mockRestore();
      mkdir.mockRestore();
      write.mockRestore();
    },
  );
});
