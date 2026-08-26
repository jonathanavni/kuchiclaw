// Core-loop integration test (P7-H): real SQLite (in-memory), real GroupQueue,
// real ipc.ts and task-scheduler — only the container run, auth, and group
// folder are faked. Pins the enqueue → run → persist → deliver ordering and the
// IPC → channel path that unit suites cover only in mocked isolation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

// Pin env-derived identity + fast retries; everything else stays real.
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    MAIN_CHAT_ID: "tg-999",
    AGENT_TIMEZONE: "UTC",
    BASE_RETRY_MS: 1,
    DELIVERY_BASE_MS: 1,
  };
});
vi.mock("./container-runner.js", () => ({ runContainer: vi.fn() }));
vi.mock("./group-folder.js", () => ({ ensureGroupFolder: vi.fn(() => ({})) }));
vi.mock("./oauth-refresh.js", () => ({ getRefreshToken: vi.fn(() => null) }));
vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return {
    ...actual,
    getSecrets: vi.fn(async () => ({ secrets: { KEY: "v" }, isApiKeyFallback: false, source: "keychain" })),
    getSkillSecrets: vi.fn(() => ({})),
  };
});

import { runContainer } from "./container-runner.js";
import {
  getRecentMessages,
  getTasksByGroup,
  insertMessage,
  resetDb,
} from "./db.js";
import { enqueue, resetQueueForTest } from "./group-queue.js";
import { execute, registerSender } from "./ipc.js";
import { resetSchedulerForTest, startScheduler } from "./task-scheduler.js";
import type { Channel } from "./channels/registry.js";

function recordingChannel(sendImpl?: (chatId: string, text: string) => Promise<void>) {
  const sends: Array<{ chatId: string; text: string }> = [];
  const channel = {
    sendMessage: vi.fn(async (chatId: string, text: string) => {
      if (sendImpl) await sendImpl(chatId, text);
      sends.push({ chatId, text });
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
  };
  return { channel: channel as unknown as Channel, sends, mock: channel };
}

function messageRows(group: string) {
  return getRecentMessages(group, 50)
    .slice()
    .reverse(); // chronological
}

beforeEach(() => {
  resetDb(new Database(":memory:"));
  resetQueueForTest();
  resetSchedulerForTest();
  registerSender(async () => { throw new Error("no sender registered for this test"); });
  vi.mocked(runContainer).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetSchedulerForTest();
  vi.restoreAllMocks();
});

describe("message round trip: enqueue → container → persist → deliver", () => {
  it("stores the reply, marks the user message done, then delivers", async () => {
    const messageId = insertMessage("tg-123", "user", "hello there");
    const persistedAtDelivery: Array<{ replyStored: boolean; userStatus: string | undefined }> = [];
    const { channel, sends } = recordingChannel(async () => {
      const rows = messageRows("tg-123");
      persistedAtDelivery.push({
        replyStored: rows.some((r) => r.role === "assistant" && r.content === "the reply"),
        userStatus: rows.find((r) => r.id === messageId)?.processing_status,
      });
    });
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "the reply" });

    await new Promise<void>((done) => {
      enqueue({
        group: "tg-123", chatId: "123", senderName: "tester", text: "hello there",
        secrets: {}, channel, attempt: 1, messageId,
        onComplete: () => done(), onError: () => done(),
      });
    });

    expect(sends).toEqual([{ chatId: "123", text: "the reply" }]);
    // The reply was already persisted and the user row already terminal when
    // the channel send happened — a delivery crash can't lose the result.
    expect(persistedAtDelivery).toEqual([{ replyStored: true, userStatus: "done" }]);
    // Same-second inserts make chronological ordering by timestamp unstable —
    // assert content, not order.
    const rows = messageRows("tg-123");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.role === "user")?.processing_status).toBe("done");
    expect(rows.find((r) => r.role === "assistant")?.content).toBe("the reply");
  });

  it("a total delivery failure never re-runs the container and keeps the result persisted", async () => {
    const messageId = insertMessage("tg-123", "user", "q");
    const { channel } = recordingChannel(async () => { throw new Error("network down"); });
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "kept" });

    await new Promise<void>((done) => {
      enqueue({
        group: "tg-123", chatId: "123", senderName: "tester", text: "q",
        secrets: {}, channel, attempt: 1, messageId,
        onComplete: () => done(), onError: () => done(),
      });
    });

    expect(runContainer).toHaveBeenCalledTimes(1);
    const rows = messageRows("tg-123");
    expect(rows.find((r) => r.role === "assistant")?.content).toBe("kept");
    expect(rows.find((r) => r.id === messageId)?.processing_status).toBe("done");
  });

  it("refuses a job whose chat id does not match its group, without running a container", async () => {
    const messageId = insertMessage("tg-123", "user", "spoof");
    const { channel, sends } = recordingChannel();

    const outcome = await new Promise<{ error?: string }>((done) => {
      enqueue({
        group: "tg-123", chatId: "124", senderName: "tester", text: "spoof",
        secrets: {}, channel, attempt: 1, messageId,
        onComplete: () => done({}), onError: (error) => done({ error }),
      });
    });

    expect(outcome.error).toMatch(/not authorized|denied|identity|chat/i);
    expect(runContainer).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(messageRows("tg-123").find((r) => r.id === messageId)?.processing_status).toBe("failed");
  });
});

describe("IPC → channel path", () => {
  it("delivers an authorized message op through the registered sender", async () => {
    const { channel, sends } = recordingChannel();
    registerSender((chatId, text) => channel.sendMessage(chatId, text));

    await execute({ op: "message", chatId: "123", text: "ipc says hi" }, "tg-123", false);
    expect(sends).toEqual([{ chatId: "123", text: "ipc says hi" }]);
  });

  it("refuses a cross-chat message op before any send", async () => {
    const { channel, sends } = recordingChannel();
    registerSender((chatId, text) => channel.sendMessage(chatId, text));

    await expect(execute({ op: "message", chatId: "124", text: "exfil" }, "tg-123", false))
      .rejects.toThrow();
    expect(sends).toEqual([]);
  });
});

describe("scheduled-task chain: IPC task_create → scheduler poll → container → delivery", () => {
  it("runs a due one-shot task end to end", async () => {
    const { channel, sends } = recordingChannel();
    registerSender((chatId, text) => channel.sendMessage(chatId, text));
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "task output" });

    // Agent creates a one-shot task via IPC (confirmation goes to the chat).
    await execute(
      { op: "task_create", chatId: "123", prompt: "do the thing", scheduleType: "once", scheduleValue: "2020-01-01T00:00:00Z" },
      "tg-123",
      false,
    );
    expect(getTasksByGroup("tg-123")).toHaveLength(1);
    expect(sends[0].text).toMatch(/Task \d+ created/);

    // Scheduler picks it up (due in the past) and the full loop runs.
    const delivered = new Promise<void>((done) => {
      const { channel: taskChannel } = recordingChannel(async (_chatId, text) => {
        if (text === "task output") done();
      });
      startScheduler({ secrets: {}, channel: taskChannel });
    });
    await delivered;

    expect(getTasksByGroup("tg-123")[0].status).toBe("completed");
    // The scheduler run persisted the assistant reply into group history.
    expect(messageRows("tg-123").some((r) => r.role === "assistant" && r.content === "task output")).toBe(true);
  });
});
