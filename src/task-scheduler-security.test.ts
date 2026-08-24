import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("./group-queue.js", () => ({ enqueue }));

import { getTasksByGroup, insertTask, resetDb } from "./db.js";
import { startScheduler, stopScheduler } from "./task-scheduler.js";
import type { Channel } from "./channels/registry.js";

beforeEach(() => {
  resetDb(new Database(":memory:"));
  enqueue.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
});

describe("scheduler stored-row validation", () => {
  it.each([
    ["../ipc/main", "123"],
    ["wa-123", "123"],
    ["tg-123", "01"],
    ["tg-123", "124"],
    ["main", "999"],
  ])("pauses invalid row (%s, %s) before enqueue", (group, chatId) => {
    insertTask(group, chatId, "unsafe", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    startScheduler({ secrets: {}, channel: {} as Channel });
    expect(enqueue).not.toHaveBeenCalled();
    expect(getTasksByGroup(group)[0].status).toBe("paused");
  });

  it("enqueues a canonical Telegram row", () => {
    insertTask("tg-123", "123", "safe", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    startScheduler({ secrets: {}, channel: {} as Channel });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
