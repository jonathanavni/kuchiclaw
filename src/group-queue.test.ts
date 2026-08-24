import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runContainer: vi.fn(),
  ensureGroupFolder: vi.fn(),
  getSecrets: vi.fn(),
  getRefreshToken: vi.fn(),
  insertMessage: vi.fn(),
  getRecentMessages: vi.fn(() => []),
  formatHistory: vi.fn(() => ""),
  updateMessageStatus: vi.fn(),
}));

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, MAIN_CHAT_ID: "tg-999" };
});
vi.mock("./container-runner.js", () => ({ runContainer: mocks.runContainer }));
vi.mock("./group-folder.js", () => ({ ensureGroupFolder: mocks.ensureGroupFolder }));
vi.mock("./auth.js", () => ({ getSecrets: mocks.getSecrets }));
vi.mock("./oauth-refresh.js", () => ({ getRefreshToken: mocks.getRefreshToken }));
vi.mock("./db.js", () => ({
  insertMessage: mocks.insertMessage,
  getRecentMessages: mocks.getRecentMessages,
  formatHistory: mocks.formatHistory,
  updateMessageStatus: mocks.updateMessageStatus,
}));

import { enqueue } from "./group-queue.js";
import type { Channel } from "./channels/registry.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSecrets.mockResolvedValue({ secrets: {}, isApiKeyFallback: false, source: "env-token" });
});

describe("queue identity ingress", () => {
  it("refuses invalid identities before status, container, retry, or reply paths", async () => {
    const channel = { sendMessage: vi.fn() } as unknown as Channel;
    const errors = [vi.fn(), vi.fn(), vi.fn()];
    mocks.runContainer
      .mockResolvedValueOnce({ status: "success", result: "unreachable" })
      .mockResolvedValueOnce({ status: "error", error: "unreachable" })
      .mockRejectedValueOnce(new Error("unreachable"));

    for (let index = 0; index < 3; index += 1) {
      enqueue({
        group: "tg-123",
        chatId: "456",
        senderName: `shape-${index}`,
        text: "must not run",
        secrets: {},
        channel,
        attempt: index === 2 ? 3 : 1,
        messageId: index + 1,
        onError: errors[index],
      });
    }

    await vi.waitFor(() => expect(errors.every((callback) => callback.mock.calls.length === 1)).toBe(true));
    expect(mocks.updateMessageStatus.mock.calls).toEqual([
      [1, "failed"], [2, "failed"], [3, "failed"],
    ]);
    expect(mocks.ensureGroupFolder).not.toHaveBeenCalled();
    expect(mocks.getSecrets).not.toHaveBeenCalled();
    expect(mocks.runContainer).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});
