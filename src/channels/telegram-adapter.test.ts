// Hermetic adapter tests: a fake fetch (v2's TransportOptions.fetch seam)
// drives the REAL Bot — real middleware chain, real long-poll pump, real
// transport — so ctx mapping, command overlap, send params, and the polling
// lifecycle are exercised without network or Bot-class mocking (plan F7).
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramChannel } from "./telegram.js";
import type { IncomingMessage } from "./registry.js";

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return { ...actual, ALLOWED_SENDER_IDS: ["7"] };
});

type ApiCall = { method: string; body: Record<string, unknown> };

/** Minimal Telegram API fake. Updates pushed via push() are served to the next
 *  getUpdates long-poll; everything else answers with a plausible envelope. */
function fakeTelegram(
  onMethod?: (method: string, body: Record<string, unknown>) => { status: number; payload: object } | undefined,
) {
  const calls: ApiCall[] = [];
  const pending: object[][] = [];
  let nextUpdateId = 1;

  function nextBatch(signal?: AbortSignal): Promise<object[]> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      const poll = () => {
        if (signal?.aborted) return;
        if (pending.length > 0) resolve(pending.shift()!);
        else setTimeout(poll, 5);
      };
      poll();
    });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = new URL(String(input)).pathname.split("/").pop()!;
    // The v2 transport sends urlencoded params, each value a scalar or JSON.
    const body: Record<string, unknown> = {};
    if (init?.body) {
      const params = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init.body));
      for (const [k, v] of params) {
        try { body[k] = JSON.parse(v); } catch { body[k] = v; }
      }
    }
    calls.push({ method, body });
    const override = onMethod?.(method, body);
    if (override) return Response.json(override.payload, { status: override.status });
    switch (method) {
      case "getMe":
        return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "kuchi", username: "kuchi_bot" } });
      case "getUpdates":
        // timeout: 0 = the adapter's at-boot probe — answer immediately.
        // Offsetless getUpdates does NOT confirm updates: peek, never shift,
        // so a queued-before-connect update still reaches the pump.
        if (body.timeout === 0) return Response.json({ ok: true, result: pending[0] ?? [] });
        return Response.json({ ok: true, result: await nextBatch(init?.signal ?? undefined) });
      case "sendMessage":
        return Response.json({
          ok: true,
          result: { message_id: 1, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text },
        });
      case "sendChatAction":
        return Response.json({ ok: true, result: true });
      default:
        return Response.json({ ok: false, error_code: 404, description: `no fake for ${method}` }, { status: 404 });
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    sends: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body),
    push(message: object) {
      pending.push([{ update_id: nextUpdateId++, message }]);
    },
  };
}

const dm = (text: string, fromId = 7, extra: object = {}) => ({
  message_id: 100,
  date: 0,
  chat: { id: 555, type: "private" },
  from: { id: fromId, is_bot: false, first_name: "Jon" },
  text,
  ...extra,
});

const groupMsg = (text: string, extra: object = {}) => ({
  message_id: 101,
  date: 0,
  chat: { id: -600, type: "group" },
  from: { id: 7, is_bot: false, first_name: "Jon" },
  text,
  ...extra,
});

let channel: TelegramChannel | null = null;

afterEach(async () => {
  if (channel) await channel.disconnect();
  channel = null;
  vi.restoreAllMocks();
});

async function connected(tg: ReturnType<typeof fakeTelegram>) {
  channel = new TelegramChannel("test-token", { fetch: tg.fetch });
  const received: IncomingMessage[] = [];
  channel.onMessage((m) => received.push(m));
  await channel.connect();
  return { channel, received };
}

describe("TelegramChannel adapter (real Bot, injected fetch)", () => {
  it("connects via getMe and reports connected", async () => {
    const tg = fakeTelegram();
    const { channel } = await connected(tg);
    expect(channel.isConnected()).toBe(true);
    expect(tg.calls.some((c) => c.method === "getMe")).toBe(true);
  });

  it("delivers a DM through the pipeline with sender identity", async () => {
    const tg = fakeTelegram();
    const { received } = await connected(tg);
    tg.push(dm("hello there"));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      chatId: "555", senderName: "Jon", text: "hello there", chatType: "private", senderId: "7",
    });
  });

  it("drops a DM from a sender outside the allowlist", async () => {
    const tg = fakeTelegram();
    const { received } = await connected(tg);
    tg.push(dm("intruder", 999));
    tg.push(dm("legit"));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].text).toBe("legit");
  });

  it("gates group messages: mention strips, reply-to-bot passes, plain drops", async () => {
    const tg = fakeTelegram();
    const { received } = await connected(tg);
    tg.push(groupMsg("just chatting"));
    tg.push(groupMsg("@kuchi_bot what time?"));
    tg.push(groupMsg("yes tomorrow", {
      reply_to_message: { message_id: 9, date: 0, chat: { id: -600, type: "group" }, from: { id: 42, is_bot: true, first_name: "kuchi" }, text: "ok?" },
    }));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.map((m) => m.text)).toEqual(["what time?", "yes tomorrow"]);
  });

  it("/start replies with identifiers even for a non-allowlisted sender (ungated bootstrap)", async () => {
    const tg = fakeTelegram();
    const { received } = await connected(tg);
    tg.push(dm("/start", 999));
    await vi.waitFor(() => expect(tg.sends()).toHaveLength(1));
    expect(String(tg.sends()[0].text)).toContain("Chat ID: 555");
    expect(String(tg.sends()[0].text)).toContain("Your user ID: 999");
    expect(received).toHaveLength(0); // command consumed, not an agent message
  });

  it("/status replies only to allowlisted senders; unregistered commands hit neither path", async () => {
    const tg = fakeTelegram();
    const { received } = await connected(tg);
    tg.push(dm("/status", 999)); // gated: no reply
    tg.push(dm("/frobnicate"));  // unregistered: falls through, "/" guard drops it
    tg.push(dm("/status"));      // allowed
    await vi.waitFor(() => expect(tg.sends()).toHaveLength(1));
    expect(String(tg.sends()[0].text)).toContain("Uptime:");
    expect(received).toHaveLength(0);
  });

  it("sendMessage sends HTML with link previews disabled", async () => {
    const tg = fakeTelegram();
    const { channel } = await connected(tg);
    await channel.sendMessage("555", "**bold** text");
    const sent = tg.sends();
    expect(sent).toHaveLength(1);
    expect(sent[0].parse_mode).toBe("HTML");
    expect(sent[0].link_preview_options).toEqual({ is_disabled: true });
    expect(sent[0].text).toBe("<b>bold</b> text");
  });

  it("parse-400 degrades to a plain send with exactly one HTTP attempt each (transport retries off)", async () => {
    const tg = fakeTelegram((method, body) =>
      method === "sendMessage" && body.parse_mode === "HTML"
        ? { status: 400, payload: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } }
        : undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel } = await connected(tg);
    await channel.sendMessage("555", "odd markup");
    const sent = tg.sends();
    // one rejected HTML attempt + one accepted plain attempt — no hidden
    // transport retries multiplying either (maxRetries: 0 is load-bearing)
    expect(sent).toHaveLength(2);
    expect(sent[0].parse_mode).toBe("HTML");
    expect(sent[1].parse_mode).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain text"));
  });

  it("an at-boot polling fatal (409 on the probe) rejects connect() — startup fails cleanly", async () => {
    const tg = fakeTelegram((method) =>
      method === "getUpdates"
        ? { status: 409, payload: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }
        : undefined,
    );
    channel = new TelegramChannel("test-token", { fetch: tg.fetch });
    await expect(channel.connect()).rejects.toMatchObject({ errorCode: 409 });
    expect(channel.isConnected()).toBe(false);
    channel = null; // nothing to disconnect
  });

  it("a post-connect polling fatal fires onFatalError and drops connected (no healthy-but-deaf state)", async () => {
    // Probe (timeout: 0) passes; the pump's long-poll calls hit 409.
    const tg = fakeTelegram((method, body) =>
      method === "getUpdates" && body.timeout !== 0
        ? { status: 409, payload: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }
        : undefined,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fatal = vi.fn();
    channel = new TelegramChannel("test-token", { fetch: tg.fetch });
    channel.onFatalError(fatal);
    await channel.connect();
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(channel.isConnected()).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("fatally"), expect.anything());
  });

  it("caller-supplied botOptions cannot re-enable transport retries (maxRetries is forced 0)", async () => {
    const tg = fakeTelegram((method) =>
      method === "sendChatAction"
        ? { status: 500, payload: { ok: false, error_code: 500, description: "Internal Server Error" } }
        : undefined,
    );
    // Hostile options: maxRetries: 2 would mean 3 transport attempts per call.
    channel = new TelegramChannel("test-token", { fetch: tg.fetch, maxRetries: 2 });
    await channel.connect();
    await expect(channel.sendTyping("555")).rejects.toMatchObject({ errorCode: 500 });
    expect(tg.calls.filter((c) => c.method === "sendChatAction")).toHaveLength(1);
  });

  it("disconnect awaits pump termination; a fresh connect works after", async () => {
    const tg = fakeTelegram();
    const { channel, received } = await connected(tg);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    tg.push(dm("after reconnect"));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(channel.isConnected()).toBe(true);
  });

  it("double connect throws instead of orphaning a pump", async () => {
    const tg = fakeTelegram();
    const { channel } = await connected(tg);
    await expect(channel.connect()).rejects.toThrow(/disconnect first/);
  });

  it("double disconnect is a no-op, not an error (plan F4)", async () => {
    const tg = fakeTelegram();
    const { channel } = await connected(tg);
    await channel.disconnect();
    await expect(channel.disconnect()).resolves.toBeUndefined();
  });

  it("disconnect during an in-flight send lets the send settle (plan F4)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tg = fakeTelegram();
    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/sendMessage")) await gate;
      return tg.fetch(input, init);
    }) as typeof fetch;
    channel = new TelegramChannel("test-token", { fetch: slowFetch });
    await channel.connect();
    const inflight = channel.sendMessage("555", "slow one");
    const closing = channel.disconnect();
    release();
    await expect(inflight).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(tg.sends()).toHaveLength(1);
  });

  it("an update queued before connect survives the probe and reaches the pipeline (verify r2)", async () => {
    const tg = fakeTelegram();
    tg.push(dm("was waiting"));
    const { received } = await connected(tg);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].text).toBe("was waiting");
  });

  it("a transient blip on the probe retries within the budget instead of failing startup (verify r2)", async () => {
    let probeFailures = 1;
    const tg = fakeTelegram((method, body) => {
      if (method === "getUpdates" && body.timeout === 0 && probeFailures-- > 0) {
        return { status: 502, payload: { ok: false, error_code: 502, description: "Bad Gateway" } };
      }
      return undefined;
    });
    const { channel } = await connected(tg); // succeeds despite the 502 (1s real backoff)
    expect(channel.isConnected()).toBe(true);
  });

  it("an over-budget 429 on the probe fails startup immediately — no early retry, no clamp (verify r2)", async () => {
    const tg = fakeTelegram((method, body) =>
      method === "getUpdates" && body.timeout === 0
        ? { status: 429, payload: { ok: false, error_code: 429, description: "flood", parameters: { retry_after: 300 } } }
        : undefined,
    );
    channel = new TelegramChannel("test-token", { fetch: tg.fetch });
    await expect(channel.connect()).rejects.toMatchObject({ errorCode: 429 });
    channel = null;
  });

  it("a failed connect leaves the channel reconnectable (verify r2)", async () => {
    let getMeFailures = 1;
    const tg = fakeTelegram((method) =>
      method === "getMe" && getMeFailures-- > 0
        ? { status: 401, payload: { ok: false, error_code: 401, description: "Unauthorized" } }
        : undefined,
    );
    channel = new TelegramChannel("test-token", { fetch: tg.fetch });
    await expect(channel.connect()).rejects.toMatchObject({ errorCode: 401 });
    await channel.connect(); // must not hit the double-connect guard
    expect(channel.isConnected()).toBe(true);
  });

  it("disconnect cancels an in-flight probe retry; a stale generation never fires after reconnect (verify r3)", async () => {
    let probeCalls = 0;
    const tg = fakeTelegram((method, body) => {
      if (method === "getUpdates" && body.timeout === 0) {
        probeCalls++;
        // First generation's probe: transient failure → helper schedules a
        // 1s backoff retry. That retry must be cancelled by disconnect.
        if (probeCalls === 1) return { status: 502, payload: { ok: false, error_code: 502, description: "Bad Gateway" } };
      }
      return undefined;
    });
    channel = new TelegramChannel("test-token", { fetch: tg.fetch });
    const firstConnect = channel.connect();
    await vi.waitFor(() => expect(probeCalls).toBe(1)); // reached the backoff sleep
    // Attach the rejection expectation BEFORE it can settle (no unhandled
    // rejection), but do NOT await it yet: the backoff sleep is not abortable,
    // so awaiting would consume the stale generation's window and the overlap
    // this test exists to exercise would never happen.
    const firstRejection = expect(firstConnect).rejects.toMatchObject({ name: "AbortError" });
    await channel.disconnect(); // aborts the generation mid-backoff
    await channel.connect(); // fresh generation, live pump — OVERLAPS the stale backoff
    const probesAfterReconnect = probeCalls;
    expect(channel.isConnected()).toBe(true);
    // The stale backoff elapses while the new pump is live: the loop-top abort
    // check must throw without issuing a request — no zombie probe, no 409 kill.
    await new Promise((r) => setTimeout(r, 1200));
    await firstRejection;
    expect(probeCalls).toBe(probesAfterReconnect);
    expect(channel.isConnected()).toBe(true);
  });

  it("disconnect racing a slow connect never starts an orphan pump (QA W1)", async () => {
    const tg = fakeTelegram();
    channel = new TelegramChannel("test-token", { fetch: tg.fetch });
    const connecting = channel.connect(); // this.bot is set synchronously
    await channel.disconnect();
    // The generation abort turns the raced connect into a clean rejection.
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(channel.isConnected()).toBe(false);
    // Give a would-be orphan pump time to issue a long-poll, then check none did.
    await new Promise((r) => setTimeout(r, 30));
    expect(tg.calls.filter((c) => c.method === "getUpdates" && c.body.timeout !== 0)).toHaveLength(0);
  });
});
