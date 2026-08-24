import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const enqueue = vi.hoisted(() => vi.fn());
const isMessageInFlight = vi.hoisted(() => vi.fn(() => false));
vi.mock("./group-queue.js", () => ({ enqueue, shutdown: vi.fn(), isMessageInFlight }));

import { getDb, getRecentMessages, getStuckProcessingMessages, incrementRecoveryCount, resetDb } from "./db.js";
import { recoverOrphanedMessages, startStuckSweep, stopStuckSweep } from "./index.js";
import type { Channel } from "./channels/registry.js";

const deps = () => ({ secrets: {}, channel: {} as Channel });

function seedMessage(opts: {
  group?: string; chatId?: string; status?: string; ageSec?: number; recovery?: number;
}): number {
  const { group = "tg-123", chatId = "123", status = "processing", ageSec = 30, recovery = 0 } = opts;
  const row = getDb().prepare(`
    INSERT INTO messages
      (group_folder, role, content, timestamp, processing_status, chat_id, sender_name, recovery_count)
    VALUES (?, 'user', 'orphan', datetime('now', '-' || ? || ' seconds'), ?, ?, 'Alice', ?)
    RETURNING id
  `).get(group, ageSec, status, chatId, recovery) as { id: number };
  return row.id;
}

beforeEach(() => {
  resetDb(new Database(":memory:"));
  enqueue.mockClear();
  isMessageInFlight.mockReset();
  isMessageInFlight.mockReturnValue(false);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("crash recovery identity validation", () => {
  it("marks a mismatched orphan failed without re-enqueueing", () => {
    getDb().prepare(`
      INSERT INTO messages
        (group_folder, role, content, timestamp, processing_status, chat_id, sender_name)
      VALUES (?, 'user', 'orphan', datetime('now', '-30 seconds'), 'processing', ?, 'Alice')
    `).run("tg-123", "456");

    recoverOrphanedMessages(deps());

    expect(enqueue).not.toHaveBeenCalled();
    expect(getRecentMessages("tg-123")[0].processing_status).toBe("failed");
  });
});

describe("recovery replay cap", () => {
  it("re-enqueues a valid orphan and bumps its recovery_count", () => {
    const id = seedMessage({ recovery: 1 });
    recoverOrphanedMessages(deps());
    expect(enqueue).toHaveBeenCalledTimes(1);
    const row = getDb().prepare("SELECT recovery_count FROM messages WHERE id = ?").get(id) as { recovery_count: number };
    expect(row.recovery_count).toBe(2);
  });

  it("fails a message permanently once it exhausts MAX_RECOVERY_ATTEMPTS", () => {
    seedMessage({ recovery: 3 }); // MAX_RECOVERY_ATTEMPTS
    recoverOrphanedMessages(deps());
    expect(enqueue).not.toHaveBeenCalled();
    expect(getRecentMessages("tg-123")[0].processing_status).toBe("failed");
  });
});

describe("getStuckProcessingMessages", () => {
  it("returns only old 'processing' user messages", () => {
    seedMessage({ ageSec: 20 * 60, status: "processing" });      // old, stuck
    seedMessage({ ageSec: 60, status: "processing" });           // fresh — a live job may own it
    seedMessage({ ageSec: 20 * 60, status: "done" });            // finished
    const stuck = getStuckProcessingMessages(15 * 60);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].timestamp).toBeDefined();
  });
});

describe("incrementRecoveryCount", () => {
  it("increments and returns the new count", () => {
    const id = seedMessage({ recovery: 0 });
    expect(incrementRecoveryCount(id)).toBe(1);
    expect(incrementRecoveryCount(id)).toBe(2);
  });
});

describe("runtime stuck sweep", () => {
  it("re-enqueues stuck 'processing' messages on its interval", () => {
    vi.useFakeTimers();
    seedMessage({ ageSec: 20 * 60, status: "processing" });
    startStuckSweep(deps());
    vi.advanceTimersByTime(5 * 60_000);
    stopStuckSweep();
    vi.useRealTimers();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does NOT sweep an old 'processing' message a live job is still handling", () => {
    // Old creation time but currently in-flight (deep-backlog job that just
    // started) — must not be re-executed alongside its running container.
    vi.useFakeTimers();
    seedMessage({ ageSec: 20 * 60, status: "processing" });
    isMessageInFlight.mockReturnValue(true);
    startStuckSweep(deps());
    vi.advanceTimersByTime(5 * 60_000);
    stopStuckSweep();
    vi.useRealTimers();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
