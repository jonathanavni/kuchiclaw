import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { getTasksByGroup, insertTask, resetDb } from "./db.js";
import { execute, registerSender } from "./ipc.js";

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, MAIN_CHAT_ID: "tg-999" };
});

beforeEach(() => {
  resetDb(new Database(":memory:"));
  registerSender(async () => {});
});

describe("IPC mount-derived authorization", () => {
  it("ignores a forged payload group and blocks the foreign destination", async () => {
    await expect(execute({
      op: "message",
      chatId: "999",
      group: "main",
      text: "claimed admin",
    }, "tg-123", false)).rejects.toThrow(/Authorization denied/);
  });

  it("uses the source namespace even when the payload claims main", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    registerSender(async (chatId, text) => { sent.push({ chatId, text }); });
    await execute({
      op: "message",
      chatId: "123",
      group: "main",
      text: "own chat",
    }, "tg-123", false);
    expect(sent).toEqual([{ chatId: "123", text: "own chat" }]);
  });

  it("allows main to message any canonical chat", async () => {
    const sent: string[] = [];
    registerSender(async (chatId) => { sent.push(chatId); });
    await execute({ op: "message", chatId: "123", text: "admin" }, "main", true);
    expect(sent).toEqual(["123"]);
  });

  it.each(["456", "01"])(
    "rejects task creation for unauthorized or noncanonical chat %s",
    async (chatId) => {
      await expect(execute({
        op: "task_create",
        chatId,
        prompt: "bad task",
        scheduleType: "once",
        scheduleValue: "2099-01-01T00:00:00Z",
      }, "tg-123", false)).rejects.toThrow(/Authorization denied/);
      expect(getTasksByGroup("tg-123")).toHaveLength(0);
    },
  );

  it("persists task identity from the source namespace", async () => {
    await execute({
      op: "task_create",
      chatId: "123",
      group: "main",
      prompt: "valid task",
      scheduleType: "once",
      scheduleValue: "2099-01-01T00:00:00Z",
    }, "tg-123", false);
    expect(getTasksByGroup("tg-123")).toHaveLength(1);
    expect(getTasksByGroup("main")).toHaveLength(0);
  });

  it("never lists another group's tasks based on the payload echo", async () => {
    insertTask("main", "999", "private", "once", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", "private");
    insertTask("tg-123", "123", "own", "once", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", "own");
    const replies: string[] = [];
    registerSender(async (_chatId, text) => { replies.push(text); });
    await execute({ op: "task_list", chatId: "123", group: "main" }, "tg-123", false);
    expect(replies[0]).toContain("own");
    expect(replies[0]).not.toContain("private");
  });

  it("blocks non-main task mutation across namespaces", async () => {
    const taskId = insertTask("main", "999", "private", "once", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z");
    await expect(execute({
      op: "task_cancel",
      chatId: "123",
      taskId,
    }, "tg-123", false)).rejects.toThrow(/cannot modify task/);
  });
});
