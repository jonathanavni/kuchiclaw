import { NetworkError, ParseError, TelegramApiError, TimeoutError } from "node-telegram-bot-api";
import { describe, expect, it, vi } from "vitest";
import { PermanentDeliveryError } from "./registry.js";
import {
  classifyTelegramSendError,
  gateGroupMessage,
  startupCallWithBudget,
  isAllowedSender,
  markdownToHtml,
  sendChunked,
  splitMessage,
} from "./telegram.js";

/** Real v2 error instances — classification must hold against true instanceof,
 *  not a hand-rolled duck (the v0.67 suite's silent-degradation trap). */
const tgError = (code: number, description: string, retryAfter?: number) =>
  new TelegramApiError(code, description, retryAfter !== undefined ? { retry_after: retryAfter } : undefined);

// The allowlist is passed explicitly so tests don't depend on process.env.
describe("isAllowedSender (P6.6 fail-closed)", () => {
  it("allows a listed sender", () => {
    expect(isAllowedSender("7", ["7", "8"])).toBe(true);
  });

  it("drops an unlisted sender", () => {
    expect(isAllowedSender("9", ["7", "8"])).toBe(false);
  });

  it("drops a message with no resolvable sender ID", () => {
    expect(isAllowedSender(undefined, ["7"])).toBe(false);
  });

  it("drops everyone on an empty allowlist (belt to the startup gate's braces)", () => {
    expect(isAllowedSender("7", [])).toBe(false);
    expect(isAllowedSender(undefined, [])).toBe(false);
  });

  it("explicit '*' allows anyone, including senderless messages", () => {
    expect(isAllowedSender("9", ["*"])).toBe(true);
    expect(isAllowedSender(undefined, ["*"])).toBe(true);
  });
});

describe("gateGroupMessage (group-chat trigger gate)", () => {
  it("triggers on @mention and strips it", () => {
    expect(gateGroupMessage("@kuchi_bot what time is it?", "kuchi_bot", false)).toBe(
      "what time is it?",
    );
  });

  it("drops a mention-only message (nothing left after stripping)", () => {
    expect(gateGroupMessage("@kuchi_bot", "kuchi_bot", false)).toBeNull();
  });

  it("triggers on a reply to the bot, text passed through unchanged", () => {
    expect(gateGroupMessage("yes, tomorrow works", "kuchi_bot", true)).toBe(
      "yes, tomorrow works",
    );
  });

  it("strips the mention even when the message is also a reply to the bot", () => {
    expect(gateGroupMessage("@kuchi_bot and invite Keren", "kuchi_bot", true)).toBe(
      "and invite Keren",
    );
  });

  it("drops a plain message that neither mentions nor replies to the bot", () => {
    expect(gateGroupMessage("just chatting", "kuchi_bot", false)).toBeNull();
  });

  it("does not gate when the bot username is unknown (pre-existing behavior)", () => {
    expect(gateGroupMessage("just chatting", "", false)).toBe("just chatting");
  });
});

describe("splitMessage", () => {
  it("returns the text unchanged when it fits", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits at line boundaries and every chunk fits maxLen", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join("\n")).toBe(text);
  });

  it("closes and re-opens a fence straddling the chunk boundary (with language tag)", () => {
    const code = Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const text = `intro\n\`\`\`ts\n${code}\n\`\`\`\ntail`;
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every chunk must contain an even number of fence lines — balanced fences.
      const fences = chunk.split("\n").filter((l) => /^\s{0,3}```/.test(l));
      expect(fences.length % 2).toBe(0);
    }
    // A continuation chunk re-opens with the original language tag.
    expect(chunks[1].startsWith("```ts")).toBe(true);
    expect(chunks[0].endsWith("```")).toBe(true);
  });

  it("renders each fence-split chunk to valid HTML (the P7 fence bug)", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line_of_code_${i}();`).join("\n");
    const text = `\`\`\`python\n${code}\n\`\`\``;
    const chunks = splitMessage(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const html = markdownToHtml(chunk);
      // The fence regex matched: no literal backticks survive to the output.
      expect(html).not.toContain("`");
      expect(html).toContain("<pre><code>");
    }
  });

  it("never splits a surrogate pair on a hard cut", () => {
    // encodeURIComponent throws URIError on a lone surrogate.
    const wellFormed = (s: string) => { try { encodeURIComponent(s); return true; } catch { return false; } };
    const text = "😀".repeat(300); // one long line, no newlines
    const chunks = splitMessage(text, 101);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(wellFormed(chunk)).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("throws on an unusable maxLen instead of looping forever", () => {
    expect(() => splitMessage("x".repeat(100), 0)).toThrow(/maxLen/);
    expect(() => splitMessage("x".repeat(100), 8)).toThrow(/maxLen/);
  });

  it("does not toggle fence state on hard-cut continuations of one long line", () => {
    // Engineered so a continuation PIECE begins with ``` (piece boundary right
    // before the backticks) — a buggy per-piece toggle would emit fence closers.
    const budget = 100 - 4 - 32 - 1; // budget - closeReserve - MAX_FENCE_INTRO - 1 = pieceMax
    const text = "a".repeat(budget) + "```" + "b".repeat(150);
    const chunks = splitMessage(text, 100);
    expect(chunks[1]?.startsWith("```")).toBe(true);
    // The ``` sits mid-line, so no chunk gets fence closers/reopeners injected.
    expect(chunks.join("")).toBe(text);
  });

  it("preserves leading indentation across fence-split chunks (post-impl F2)", () => {
    const code = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? `def f${i}():` : `    return ${i}  # indented`).join("\n");
    const text = `\`\`\`python\n${code}\n\`\`\``;
    const chunks = splitMessage(text, 250);
    expect(chunks.length).toBeGreaterThan(1);

    // Render each chunk, extract the code payloads, and reassemble: the code
    // must round-trip byte-exact — including indented first lines of
    // continuation chunks, which .trim() used to destroy.
    const payloads = chunks.map((chunk) => {
      const html = markdownToHtml(chunk);
      const m = html.match(/<pre><code>([\s\S]*)<\/code><\/pre>/);
      expect(m).not.toBeNull();
      return m![1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    });
    expect(payloads.join("\n")).toBe(code);
  });
});

describe("markdownToHtml", () => {
  it("converts fences, inline code, bold, italic, links", () => {
    const html = markdownToHtml("**b** *i* `c` [t](http://u)\n```\nblock\n```");
    expect(html).toContain("<b>b</b>");
    expect(html).toContain("<i>i</i>");
    expect(html).toContain("<code>c</code>");
    expect(html).toContain('<a href="http://u">t</a>');
    expect(html).toContain("<pre><code>block</code></pre>");
  });

  it("escapes HTML in text and code", () => {
    const html = markdownToHtml("a < b & c\n`<script>`");
    expect(html).toContain("a &lt; b &amp; c");
    expect(html).toContain("<code>&lt;script&gt;</code>");
  });

  it("does not expand $-substitution patterns in restored code (P7 fix)", () => {
    const html = markdownToHtml("run `echo $& $' $1` now");
    expect(html).toContain("<code>echo $&amp; $' $1</code>");
  });
});

describe("classifyTelegramSendError (v2 typed errors)", () => {
  it("classifies an entity-parse 400 as parse", () => {
    expect(classifyTelegramSendError(tgError(400, "Bad Request: can't parse entities: ..."))).toEqual({ kind: "parse" });
  });

  it("classifies a 429 as transient with retry_after honored", () => {
    expect(classifyTelegramSendError(tgError(429, "Too Many Requests", 7))).toEqual({ kind: "transient", retryAfterMs: 7000 });
  });

  it("classifies a 429 WITHOUT retry_after as transient with undefined retryAfterMs", () => {
    expect(classifyTelegramSendError(tgError(429, "Too Many Requests"))).toEqual({ kind: "transient", retryAfterMs: undefined });
  });

  it("classifies 5xx as transient", () => {
    expect(classifyTelegramSendError(tgError(502, "Bad Gateway"))).toEqual({ kind: "transient", retryAfterMs: undefined });
  });

  it("classifies typed transport errors as transient", () => {
    expect(classifyTelegramSendError(new NetworkError("fetch failed"))).toEqual({ kind: "transient" });
    expect(classifyTelegramSendError(new TimeoutError())).toEqual({ kind: "transient" });
    expect(classifyTelegramSendError(new ParseError("bad envelope"))).toEqual({ kind: "transient" });
  });

  it("classifies non-parse 4xx as permanent (round-3 F2)", () => {
    expect(classifyTelegramSendError(tgError(403, "Forbidden: bot was blocked by the user"))).toEqual({ kind: "permanent" });
    expect(classifyTelegramSendError(tgError(400, "Bad Request: chat not found"))).toEqual({ kind: "permanent" });
    expect(classifyTelegramSendError(tgError(401, "Unauthorized"))).toEqual({ kind: "permanent" });
  });

  it("classifies caller-abort DOMExceptions as transient WITHOUT the unknown-shape noise (verify r2)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(classifyTelegramSendError(new DOMException("t", "TimeoutError"))).toEqual({ kind: "transient" });
    expect(classifyTelegramSendError(new DOMException("a", "AbortError"))).toEqual({ kind: "transient" });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("treats an unknown error shape as transient but logs loudly (plan v2 F3)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(classifyTelegramSendError(new Error("ECONNRESET"))).toEqual({ kind: "transient" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unclassified"), expect.anything());
    error.mockRestore();
  });
});

describe("startupCallWithBudget (round-3 R3-1: budgeted startup calls)", () => {
  const me = { id: 42, is_bot: true as const, first_name: "kuchi", username: "kuchi_bot" };

  it("retries a transient failure then succeeds", async () => {
    const sleeps: number[] = [];
    const getMe = vi.fn()
      .mockRejectedValueOnce(new NetworkError("fetch failed"))
      .mockResolvedValueOnce(me);
    await expect(
      startupCallWithBudget(getMe, { sleep: async (ms) => { sleeps.push(ms); } }),
    ).resolves.toEqual(me);
    expect(sleeps).toEqual([1000]);
  });

  it("fails fast on a permanent 4xx (bad token)", async () => {
    const getMe = vi.fn().mockRejectedValue(tgError(401, "Unauthorized"));
    await expect(startupCallWithBudget(getMe, { sleep: async () => {} })).rejects.toMatchObject({ errorCode: 401 });
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it("fails startup when retry_after exceeds the budget — never waits early, never clamps", async () => {
    const sleeps: number[] = [];
    const getMe = vi.fn().mockRejectedValue(tgError(429, "flood", 300));
    await expect(
      startupCallWithBudget(getMe, { budgetMs: 30_000, sleep: async (ms) => { sleeps.push(ms); } }),
    ).rejects.toMatchObject({ errorCode: 429 });
    expect(getMe).toHaveBeenCalledTimes(1); // 300s does not fit a 30s budget
    expect(sleeps).toEqual([]);
  });

  it("gives up after maxAttempts on persistent transient failures", async () => {
    const getMe = vi.fn().mockRejectedValue(new TimeoutError());
    await expect(
      startupCallWithBudget(getMe, { maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(getMe).toHaveBeenCalledTimes(3);
  });
});

describe("sendChunked (round-1 F2: per-chunk delivery)", () => {
  const noSleep = () => Promise.resolve();
  const twoChunkText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

  function collector() {
    const sent: Array<{ mode: string; text: string }> = [];
    return {
      sent,
      html: vi.fn(async (h: string) => { sent.push({ mode: "html", text: h }); }),
      plain: vi.fn(async (p: string) => { sent.push({ mode: "plain", text: p }); }),
    };
  }

  it("a transient failure on chunk 2 never re-sends chunk 1", async () => {
    const c = collector();
    let chunk2Failures = 1;
    const flakyHtml = vi.fn(async (h: string) => {
      if (c.sent.length >= 1 && chunk2Failures-- > 0) throw new NetworkError("socket hang up");
      c.sent.push({ mode: "html", text: h });
    });

    await sendChunked(twoChunkText, flakyHtml, c.plain, { maxLen: 200, sleep: noSleep });
    const chunks = splitMessage(twoChunkText, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // chunk 1 delivered exactly once despite chunk 2's transient failure + retry
    expect(c.sent.filter((s) => s.text === markdownToHtml(chunks[0]))).toHaveLength(1);
    expect(c.sent.map((s) => s.text)).toEqual(chunks.map(markdownToHtml));
  });

  it("a parse-400 on chunk 2 degrades only chunk 2 to plain text", async () => {
    const c = collector();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call = 0;
    const parseFailOnSecond = vi.fn(async (h: string) => {
      call++;
      if (call === 2) {
        throw tgError(400, "Bad Request: can't parse entities");
      }
      c.sent.push({ mode: "html", text: h });
    });

    await sendChunked(twoChunkText, parseFailOnSecond, c.plain, { maxLen: 200, sleep: noSleep });
    const chunks = splitMessage(twoChunkText, 200);
    expect(c.sent[0]).toEqual({ mode: "html", text: markdownToHtml(chunks[0]) });
    expect(c.plain).toHaveBeenCalledExactlyOnceWith(chunks[1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain text"));
    warn.mockRestore();
  });

  it("parse-400 then transient failure on the SAME chunk retries the plain fallback, not chunk 1 (round-2 F4)", async () => {
    const c = collector();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sleeps: number[] = [];
    let htmlCall = 0;
    const htmlParseFailOnSecond = vi.fn(async (h: string) => {
      htmlCall++;
      if (htmlCall === 2) throw tgError(400, "Bad Request: can't parse entities");
      c.sent.push({ mode: "html", text: h });
    });
    let plainCall = 0;
    const plainFlaky = vi.fn(async (p: string) => {
      plainCall++;
      if (plainCall === 1) throw tgError(429, "flood", 3);
      c.sent.push({ mode: "plain", text: p });
    });

    await sendChunked(twoChunkText, htmlParseFailOnSecond, plainFlaky, {
      maxLen: 200, sleep: async (ms) => { sleeps.push(ms); },
    });
    const chunks = splitMessage(twoChunkText, 200);
    // Chunk 1 delivered exactly once; chunk 2's fallback retried in place.
    expect(c.sent.filter((s) => s.text === markdownToHtml(chunks[0]))).toHaveLength(1);
    expect(c.sent.at(-1)).toEqual({ mode: "plain", text: chunks[1] });
    expect(sleeps).toEqual([3000]); // retry_after honored on the plain retry
    warn.mockRestore();
  });

  it("throws only after per-chunk retries exhaust, honoring retry_after backoff", async () => {
    const sleeps: number[] = [];
    const alwaysFail = vi.fn(async () => {
      throw tgError(429, "flood", 2);
    });

    await expect(
      sendChunked("short message", alwaysFail, alwaysFail, {
        maxLen: 200, retries: 3, sleep: async (ms) => { sleeps.push(ms); },
      }),
    ).rejects.toMatchObject({ errorCode: 429 });
    expect(alwaysFail).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("honors a large retry_after verbatim — never retries before Telegram permits (post-impl r2)", async () => {
    const sleeps: number[] = [];
    let failures = 1;
    const floodOnce = vi.fn(async () => {
      if (failures-- > 0) {
        throw tgError(429, "flood", 300);
      }
    });

    await sendChunked("short message", floodOnce, floodOnce, {
      maxLen: 200, sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(sleeps).toEqual([300_000]);
  });

  it("a permanent 403 on chunk 2 throws PermanentDeliveryError with no retry and chunk 1 sent once (round-3 F2)", async () => {
    const c = collector();
    const sleeps: number[] = [];
    let call = 0;
    const blockedOnSecond = vi.fn(async (h: string) => {
      call++;
      if (call === 2) throw tgError(403, "Forbidden: bot was blocked by the user");
      c.sent.push({ mode: "html", text: h });
    });

    await expect(
      sendChunked(twoChunkText, blockedOnSecond, c.plain, {
        maxLen: 200, sleep: async (ms) => { sleeps.push(ms); },
      }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
    const chunks = splitMessage(twoChunkText, 200);
    expect(c.sent).toEqual([{ mode: "html", text: markdownToHtml(chunks[0]) }]);
    expect(sleeps).toEqual([]); // permanent: zero retries, zero backoff
    expect(c.plain).not.toHaveBeenCalled();
  });

  it("re-splits a chunk whose rendered HTML exceeds the limit", async () => {
    const c = collector();
    // 3000 raw '&' chars render to 15000 — over a 4096 rendered limit.
    const text = "&".repeat(3000);

    await sendChunked(text, c.html, c.plain, { maxLen: 4000, sleep: noSleep });
    expect(c.sent.length).toBeGreaterThan(1);
    for (const s of c.sent) expect(s.text.length).toBeLessThanOrEqual(4096);
    const roundTripped = c.sent.map((s) => s.text.replaceAll("&amp;", "&")).join("");
    expect(roundTripped).toBe(text);
  });
});

describe("sendChunked partial-delivery guard (plan v3 R2-1/R2-5, v3.1 R3-3)", () => {
  const twoChunkText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

  it("chunk-2 exhaustion after chunk 1 accepted → PermanentDeliveryError, chunk 1 sent once, cause preserved", async () => {
    const sent: string[] = [];
    let call = 0;
    const failFromSecond = vi.fn(async (h: string) => {
      call++;
      if (call >= 2) throw new NetworkError("socket hang up");
      sent.push(h);
    });
    const err = await sendChunked(twoChunkText, failFromSecond, failFromSecond, {
      maxLen: 200, retries: 2, sleep: async () => {},
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentDeliveryError);
    expect((err as Error).message).toContain("partial delivery: 1 sends accepted");
    expect((err as Error).message).toContain("socket hang up"); // formatted cause in message
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(NetworkError);
    const chunks = splitMessage(twoChunkText, 200);
    expect(sent).toEqual([markdownToHtml(chunks[0])]); // chunk 1 exactly once, never replayed
  });

  it("first-chunk exhaustion with nothing accepted rethrows raw (outer whole-message retry stays duplicate-free)", async () => {
    const alwaysFail = vi.fn(async () => { throw new TimeoutError(); });
    await expect(
      sendChunked(twoChunkText, alwaysFail, alwaysFail, { maxLen: 200, retries: 2, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("recursive re-split: leaf 1 accepted, leaf 2 exhausts → PermanentDeliveryError via leaf accounting (R3-3: no denominator)", async () => {
    // One top-level chunk whose rendered HTML overflows → recursive re-split
    // into multiple leaf sends. A top-level-only accepted flag would miss this.
    const text = "&".repeat(3000);
    const sent: string[] = [];
    let leaf = 0;
    const failOnSecondLeaf = vi.fn(async (h: string) => {
      leaf++;
      if (leaf >= 2) throw new NetworkError("mid-expansion failure");
      sent.push(h);
    });
    const err = await sendChunked(text, failOnSecondLeaf, failOnSecondLeaf, {
      maxLen: 4000, retries: 2, sleep: async () => {},
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentDeliveryError);
    expect((err as Error).message).toMatch(/partial delivery: \d+ sends accepted/);
    expect(sent.length).toBe(1); // leaf 1 exactly once
  });
});
