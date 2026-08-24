import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("./group-queue.js", () => ({ enqueue, shutdown: vi.fn() }));

import { getDb, getRecentMessages, resetDb } from "./db.js";
import { recoverOrphanedMessages } from "./index.js";
import type { Channel } from "./channels/registry.js";

beforeEach(() => {
  resetDb(new Database(":memory:"));
  enqueue.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("crash recovery identity validation", () => {
  it("marks a mismatched orphan failed without re-enqueueing", () => {
    getDb().prepare(`
      INSERT INTO messages
        (group_folder, role, content, timestamp, processing_status, chat_id, sender_name)
      VALUES (?, 'user', 'orphan', datetime('now', '-30 seconds'), 'processing', ?, 'Alice')
    `).run("tg-123", "456");

    recoverOrphanedMessages({ secrets: {}, channel: {} as Channel });

    expect(enqueue).not.toHaveBeenCalled();
    expect(getRecentMessages("tg-123")[0].processing_status).toBe("failed");
  });
});
