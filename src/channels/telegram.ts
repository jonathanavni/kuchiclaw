// Telegram channel adapter using node-telegram-bot-api v2 (long polling).
// Implements the Channel interface from registry.ts.

import {
  Bot,
  NetworkError,
  ParseError,
  TelegramApiError,
  TimeoutError,
  type BotOptions,
} from "node-telegram-bot-api";
import { ALLOWED_SENDER_IDS } from "../config.js";
import { PermanentDeliveryError } from "./registry.js";
import type { Channel, IncomingMessage } from "./registry.js";

/** Max message length Telegram allows per message */
const TELEGRAM_MAX_LENGTH = 4096;

/** Fail closed: a message without a resolvable sender ID is dropped unless the
 *  operator explicitly opted into allow-all ("*"). The startup gate guarantees
 *  the list is never empty by the time the channel is connected. */
export function isAllowedSender(
  senderId: string | undefined,
  allowlist: string[] = ALLOWED_SENDER_IDS,
): boolean {
  if (allowlist.includes("*")) return true;
  return senderId !== undefined && allowlist.includes(senderId);
}

/** Group-chat trigger gate: returns the text to process (mention stripped), or
 *  null when the message should be ignored. Triggers on an @mention of the bot
 *  or a Telegram reply to one of the bot's own messages — a reply is the
 *  instinctive follow-up and used to be silently dropped. */
export function gateGroupMessage(
  text: string,
  botUsername: string,
  isReplyToBot: boolean,
): string | null {
  if (!botUsername) return text; // username unknown ⇒ no gate (pre-existing behavior)
  const mentionTag = `@${botUsername}`;
  if (text.includes(mentionTag)) {
    const stripped = text.replace(mentionTag, "").trim();
    return stripped || null; // nothing left after stripping mention
  }
  return isReplyToBot ? text : null;
}

export type MessageHandler = (msg: IncomingMessage) => void;

/** Wall-clock budget per startup API call (getMe, the polling probe). */
const STARTUP_CALL_BUDGET_MS = 30_000;
const STARTUP_CALL_MAX_ATTEMPTS = 3;

/**
 * Bounded, budgeted retry for a startup API call (`getMe`, the at-boot polling
 * probe). Transient failures retry honoring `retry_after` — but ONLY while the
 * wait fits the wall-clock budget: a 429 asking to wait past the budget FAILS
 * startup (the circuit breaker paces the restart) instead of stalling a service
 * that looks active while polling, IPC, and the scheduler haven't started.
 * Never waits less than `retry_after` (the P7 honor-verbatim rule) — over
 * budget means fail, not clamp. The budget bounds the requests themselves too
 * (per-attempt abort): the v2 transport's default per-request timeout is 300s.
 */
export async function startupCallWithBudget<T>(
  call: (signal: AbortSignal) => Promise<T>,
  options: {
    budgetMs?: number;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Lifecycle cancellation: a disconnect must stop the retry loop, or a
     *  stale probe retry can outlive its generation and 409-collide with a
     *  reconnected pump's getUpdates. */
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const budgetMs = options.budgetMs ?? STARTUP_CALL_BUDGET_MS;
  const maxAttempts = options.maxAttempts ?? STARTUP_CALL_MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = Date.now() + budgetMs;
  let lastErr: unknown;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("startup call cancelled", "AbortError");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastErr ?? new TimeoutError("startup call budget exhausted");
    const budgetSignal = AbortSignal.timeout(remaining);
    try {
      return await call(options.signal ? AbortSignal.any([options.signal, budgetSignal]) : budgetSignal);
    } catch (err) {
      lastErr = err;
      const { kind, retryAfterMs } = classifyTelegramSendError(err);
      if (kind === "permanent" || kind === "parse") throw err;
      const wait = retryAfterMs ?? 1000 * Math.pow(2, attempt - 1);
      if (attempt >= maxAttempts || Date.now() + wait > deadline) throw err;
      await sleep(wait);
    }
  }
}

export class TelegramChannel implements Channel {
  private bot: Bot | null = null;
  private token: string;
  private botOptions: BotOptions;
  private connected = false;
  private onMessageHandler: MessageHandler | null = null;
  private onFatalHandler: ((err: unknown) => void) | null = null;
  private pollingDone: Promise<void> | null = null;
  private connectAbort: AbortController | null = null;
  private stopping = false;
  private startTime = Date.now();
  private botUsername = "";
  private botId = 0;

  constructor(token: string, botOptions: BotOptions = {}) {
    this.token = token;
    // Single retry owner: ALL retry policy lives in sendWithRetry/deliver().
    // The v2 transport's own retry layer (default maxRetries: 2, with a
    // retry_after cap that violates the honor-verbatim rule) must stay off, or
    // every failing chunk multiplies into hidden HTTP attempts. maxRetries sits
    // AFTER the spread so no caller (the injection seam is for `fetch`) can
    // silently re-enable transport retries.
    this.botOptions = { ...botOptions, maxRetries: 0 };
  }

  /** Register a callback for incoming user messages (not commands) */
  onMessage(handler: MessageHandler): void {
    this.onMessageHandler = handler;
  }

  /** Register the fatal-polling callback. Wire this BEFORE connect(): the
   *  polling pump starts inside connect(), and a fatal 401/409 landing there
   *  must reach the shutdown path, not strand a healthy-looking deaf process. */
  onFatalError(handler: (err: unknown) => void): void {
    this.onFatalHandler = handler;
  }

  async connect(): Promise<void> {
    // The v2 pump is not re-entrant, and a second connect would orphan the
    // first Bot's polling promise supervisor.
    if (this.bot) throw new Error("TelegramChannel.connect() called while connected; disconnect first");
    const bot = new Bot(this.token, this.botOptions);
    const generation = new AbortController();
    this.bot = bot;
    this.connectAbort = generation;
    this.stopping = false;
    this.startTime = Date.now();
    try {
      await this.finishConnect(bot, generation.signal);
    } catch (err) {
      // A failed connect must leave the channel reconnectable, not wedged
      // behind the double-connect guard.
      if (this.bot === bot) this.bot = null;
      if (this.connectAbort === generation) this.connectAbort = null;
      throw err;
    }
  }

  private async finishConnect(bot: Bot, cancel: AbortSignal): Promise<void> {
    // Learn our own identity: username for @mention detection, id for
    // reply-to-bot detection in group chats. Also the loud early bad-token
    // check — a permanent 4xx fails startup immediately.
    const me = await startupCallWithBudget((signal) => bot.api.getMe(signal), { signal: cancel });
    this.botUsername = me.username ?? "";
    this.botId = me.id;

    // Handler errors: log and consume. Rethrowing here is the v2 fail-loud
    // opt-in (polling rejects, Telegram redelivers) — redelivery would re-run
    // message intake and duplicate agent runs, so we take loss over duplicates,
    // same as the scheduler and retry policy do.
    bot.catch((err, ctx) => {
      console.error(
        `[Telegram] Handler error on update ${ctx.update.update_id} (update dropped, polling continues):`,
        err,
      );
    });

    // /start stays UNGATED on purpose: it's the bootstrap channel. A fresh
    // operator needs their chat ID (for MAIN_CHAT_ID) and user ID (for
    // ALLOWED_SENDER_IDS) before the allowlist can name them — and it only
    // tells the requester their own identifiers.
    // (v2 command() matches a proper leading command incl. /start@bot — the old
    // onText substring match anywhere in the text was tightened deliberately.)
    // Command replies are fire-and-forget (v0.67 parity): startPolling awaits
    // each handler, so awaiting a retry loop here would stall ALL message
    // intake for the length of a flood-wait. Failures log; commands re-issue.
    const replyDetached = (chatId: number, text: string): void => {
      void sendWithRetry(async () => {
        await bot.api.sendMessage({ chat_id: chatId, text });
      }, {}).catch((err) => {
        console.error("[Telegram] Command reply failed:", formatSendError(err));
      });
    };

    bot.command("start", (ctx) => {
      const msg = ctx.message;
      if (!msg) return;
      replyDetached(
        msg.chat.id,
        `KuchiClaw is online.\nChat ID: ${msg.chat.id}\nYour user ID: ${msg.from?.id ?? "unknown"}`,
      );
    });

    bot.command("status", (ctx) => {
      const msg = ctx.message;
      if (!msg) return;
      if (!isAllowedSender(msg.from?.id ? String(msg.from.id) : undefined)) return;
      const uptimeMin = Math.floor((Date.now() - this.startTime) / 60_000);
      replyDetached(msg.chat.id, `Status: running\nUptime: ${uptimeMin}m`);
    });

    // Regular messages. The startsWith("/") guard is load-bearing: matched
    // commands stop the middleware chain above, but UNregistered commands
    // (/anything-else) fall through to here.
    bot.on("message", (ctx) => {
      const msg = ctx.message;
      if (!msg?.text || msg.text.startsWith("/")) return;
      if (!this.onMessageHandler) return;

      const senderId = msg.from?.id ? String(msg.from.id) : undefined;
      const chatType = msg.chat.type as IncomingMessage["chatType"];

      if (!isAllowedSender(senderId)) return;

      // Group chats require @mention or a reply to the bot to activate
      let text = msg.text;
      const isGroupChat = chatType === "group" || chatType === "supergroup";
      if (isGroupChat) {
        const isReplyToBot = msg.reply_to_message?.from?.id === this.botId;
        const gated = gateGroupMessage(text, this.botUsername, isReplyToBot);
        if (gated === null) return;
        text = gated;
      }

      const senderName =
        msg.from?.first_name ??
        msg.from?.username ??
        "Unknown";

      this.onMessageHandler({
        chatId: String(msg.chat.id),
        senderName,
        text,
        chatType,
        senderId,
      });
    });

    // Probe getUpdates once (timeout 0, offset untouched — nothing confirmed)
    // so an at-boot fatal (409 second poller, revoked token) rejects connect()
    // and fails startup cleanly, instead of racing the detached pump's fatal
    // callback against main() starting producers after connect resolves.
    // Budgeted like getMe: a transient blip retries here — the pump would have
    // tolerated it, so the probe must not turn it into a startup failure.
    await startupCallWithBudget((signal) => bot.api.getUpdates({ timeout: 0, limit: 1 }, signal), {
      signal: cancel,
    });

    // A disconnect can race a slow connect (both awaits above): it has already
    // stopped and nulled the bot, so starting the pump now would orphan it —
    // a live poller confirming offsets against a closed queue.
    if (this.stopping || this.bot !== bot) return;

    // Supervised polling: the pump self-retries transient errors, so this
    // promise settling at all (fatal 401/409 rejection, or resolution we did
    // not ask for via stop()) means the channel is dead — surface it instead
    // of staying healthy-looking but deaf.
    this.pollingDone = bot.startPolling().then(
      () => {
        if (this.stopping) return;
        this.connected = false;
        const err = new Error("Telegram polling ended unexpectedly");
        console.error("[Telegram]", err.message);
        this.onFatalHandler?.(err);
      },
      (err) => {
        if (this.stopping) return;
        this.connected = false;
        console.error("[Telegram] Polling failed fatally:", err);
        this.onFatalHandler?.(err);
      },
    );

    this.connected = true;
    console.log(`[Telegram] Connected (long polling) as @${this.botUsername}`);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not connected");
    const bot = this.bot;
    const numericId = Number(chatId);
    await sendChunked(
      text,
      async (html) => {
        await bot.api.sendMessage({
          chat_id: numericId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      },
      async (plain) => {
        await bot.api.sendMessage({ chat_id: numericId, text: plain });
      },
    );
  }

  /** Send typing indicator to a chat. Zero-retry best-effort (unchanged from
   *  v0.67): a lost typing indicator is cosmetic. */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction({ chat_id: Number(chatId), action: "typing" });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // All Telegram chat IDs are numeric (possibly negative for groups)
    return /^-?\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    if (!this.bot) return;
    // stop() is sync (aborts the pump); the startPolling promise is the actual
    // termination signal — wait for it so no handler is cut off mid-update.
    // The generation abort cancels an in-flight startup retry (getMe/probe) so
    // a stale probe can't outlive this generation and collide with a reconnect.
    this.stopping = true;
    this.connectAbort?.abort();
    this.connectAbort = null;
    this.bot.stop();
    if (this.pollingDone) await this.pollingDone;
    this.bot = null;
    this.pollingDone = null;
    this.connected = false;
    console.log("[Telegram] Disconnected");
  }
}

/**
 * Convert standard Markdown to Telegram-compatible HTML.
 * Handles: code blocks, inline code, bold, italic, links, headers.
 * Strips unsupported syntax (horizontal rules, images).
 */
export function markdownToHtml(text: string): string {
  // Step 1: Extract code blocks and inline code to protect them from further processing
  const codeBlocks: string[] = [];
  const placeholder = (i: number) => `\x00CODE${i}\x00`;

  // Fenced code blocks (```...```). Strip only the structural newline before the
  // closing fence — trimming would eat leading indentation, which corrupts a
  // fence-split continuation chunk whose first code line is indented.
  let result = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    const i = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return placeholder(i);
  });

  // Inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const i = codeBlocks.length;
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder(i);
  });

  // Step 2: Escape HTML special chars in remaining text (not inside code)
  result = escapeHtml(result);

  // Step 3: Convert markdown formatting to HTML

  // Headers (# ... ) → just the text (OpenClaw flattens these)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words like some_var_name)
  result = result.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Blockquotes: > text
  result = result.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rules (---, ***) → just remove
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");

  // Step 4: Restore code blocks. Function replacer, not a string: agent-authored
  // code can contain `$&`/`$'`-style sequences that String.replace would expand.
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(placeholder(i), () => codeBlocks[i]);
  }

  return result.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A fence line opens or closes a ``` block; must sit at line start (≤3 spaces indent). */
const FENCE_LINE = /^\s{0,3}```/;

/** Cap for a re-opened fence intro so a pathological language tag can't eat a chunk. */
const MAX_FENCE_INTRO = 32;

/**
 * Split text into chunks of at most maxLen chars, breaking at line boundaries
 * when possible. Fence-aware: a boundary inside a ``` block closes the fence at
 * the chunk end and re-opens it (with its language tag) at the next chunk start,
 * so each chunk renders as valid markdown on its own — the pre-P7 splitter cut
 * mid-fence and left literal backticks in both halves.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (maxLen < 64) throw new Error(`splitMessage: maxLen too small (${maxLen})`);
  if (text.length <= maxLen) return [text];

  const budget = maxLen - 4; // reserve room for a closing "\n```"
  const pieceMax = budget - MAX_FENCE_INTRO - 1; // hard-cut pieces fit even after a re-opened fence
  const chunks: string[] = [];
  let fenceIntro: string | null = null; // inside a fence ⇒ its (capped) opening line
  let current = "";

  const flushAndReopen = () => {
    chunks.push(fenceIntro !== null ? `${current}\n\`\`\`` : current);
    current = fenceIntro ?? "";
  };

  // `continuation` marks a hard-cut piece that continues the previous piece's
  // source line — it must join without a newline separator.
  const append = (piece: string, continuation: boolean) => {
    const sep = current.length > 0 && !continuation ? "\n" : "";
    const next = current + sep + piece;
    if (next.length > budget && current.length > 0) {
      flushAndReopen();
      append(piece, false); // depth ≤ 2: after reopen, intro + separator + piece ≤ budget
      return;
    }
    current = next;
  };

  for (const rawLine of text.split("\n")) {
    hardCutPieces(rawLine, pieceMax).forEach((piece, idx) => append(piece, idx > 0));
    // Toggle on the whole original line, so hard-cut continuations of one long
    // line can never spuriously open or close a fence.
    if (FENCE_LINE.test(rawLine)) {
      fenceIntro = fenceIntro === null ? rawLine.trim().slice(0, MAX_FENCE_INTRO) : null;
    }
  }
  if (current.length > 0) {
    chunks.push(fenceIntro !== null ? `${current}\n\`\`\`` : current);
  }
  return chunks;
}

/** Hard-cut one overlong line into pieces, never splitting a surrogate pair. */
function hardCutPieces(line: string, pieceMax: number): string[] {
  if (line.length <= pieceMax) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > pieceMax) {
    let cut = pieceMax;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // high surrogate at the edge
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

export interface ChunkSendOptions {
  /** Raw-markdown chunk budget (default: Telegram limit minus tag headroom). */
  maxLen?: number;
  /** Rendered-HTML hard limit per message (default: Telegram's 4096). */
  maxRendered?: number;
  /** Send attempts per chunk before giving up (default 3). */
  retries?: number;
  /** Backoff base for transient failures (default 1000ms). */
  baseMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Classify a Telegram send failure: an entity-parse 400 gets a plain-text
 *  fallback for that chunk; other 4xx (except 429) are permanent — retrying
 *  them can only duplicate earlier chunks; network/timeout/429/5xx are
 *  transient. Built on v2's typed error classes (instanceof, not duck-typing). */
export function classifyTelegramSendError(
  err: unknown,
): { kind: "parse" | "transient" | "permanent"; retryAfterMs?: number } {
  if (err instanceof TelegramApiError) {
    if (err.errorCode === 400 && /can't parse entities/i.test(err.description)) {
      return { kind: "parse" };
    }
    if (err.errorCode >= 400 && err.errorCode < 500 && err.errorCode !== 429) {
      return { kind: "permanent" };
    }
    const retryAfter = err.retryAfter;
    return { kind: "transient", retryAfterMs: retryAfter !== undefined ? retryAfter * 1000 : undefined };
  }
  // ParseError = malformed JSON envelope from Telegram (transport-level, NOT
  // entity-parse) — transient like the other transport failures.
  if (err instanceof NetworkError || err instanceof TimeoutError || err instanceof ParseError) {
    return { kind: "transient" };
  }
  // A caller-supplied AbortSignal (our startup budgets, disconnect mid-send)
  // propagates verbatim as a DOMException — an expected shape, not an unknown.
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { kind: "transient" };
  }
  // Unknown shape: "transient" is the safe verdict ("permanent" would drop the
  // reply in one attempt), but loud — under v2 every expected failure above is
  // typed, so this branch firing means an unrecognized shape (or a dual-package
  // instanceof split) is silently degrading retry behavior.
  console.error("[Telegram] Unclassified send error shape; treating as transient:", err);
  return { kind: "transient" };
}

/**
 * Render and deliver one logical message as sequential Telegram messages.
 * All retry and fallback handling is PER CHUNK: a later chunk's failure must
 * never re-send an earlier, already-accepted chunk. Once ANY leaf send has been
 * accepted, exhaustion on a later one is wrapped in PermanentDeliveryError so
 * deliver()'s outer whole-message retry gives up instead of replaying accepted
 * chunks — the remainder is dropped: loss over duplicates. With nothing
 * accepted yet, the raw error escapes and the outer retry is duplicate-free
 * (residual: a lost ack can still mean Telegram accepted what we count as
 * failed — no idempotency key exists, so exactly-once is unattainable).
 */
export async function sendChunked(
  text: string,
  sendHtml: (html: string) => Promise<void>,
  sendPlain: (plain: string) => Promise<void>,
  options: ChunkSendOptions = {},
): Promise<void> {
  const maxLen = options.maxLen ?? TELEGRAM_MAX_LENGTH - 96;
  // Leaf-level accounting: recursive re-splits send more messages than the
  // top-level chunk count, so acceptance is counted per successful leaf send.
  const progress = { accepted: 0 };
  try {
    for (const chunk of splitMessage(text, maxLen)) {
      await sendOneChunk(chunk, sendHtml, sendPlain, options, progress);
    }
  } catch (err) {
    if (err instanceof PermanentDeliveryError || progress.accepted === 0) throw err;
    throw new PermanentDeliveryError(
      `partial delivery: ${progress.accepted} sends accepted; dropping remainder (${formatSendError(err)})`,
      { cause: err },
    );
  }
}

async function sendOneChunk(
  chunk: string,
  sendHtml: (html: string) => Promise<void>,
  sendPlain: (plain: string) => Promise<void>,
  options: ChunkSendOptions,
  progress: { accepted: number },
): Promise<void> {
  const maxRendered = options.maxRendered ?? TELEGRAM_MAX_LENGTH;
  const html = markdownToHtml(chunk);
  if (html.length > maxRendered) {
    // Escape expansion (&→&amp; is 5×) blew past the raw-budget headroom —
    // re-split this chunk at half the raw size. Strictly decreasing, so it
    // terminates; if it can't shrink further, plain text (no expansion) fits.
    const smaller = Math.floor(chunk.length / 2);
    if (smaller < 64) {
      await sendWithRetry(() => sendPlain(chunk), options);
      progress.accepted++;
      return;
    }
    for (const piece of splitMessage(chunk, smaller)) {
      await sendOneChunk(piece, sendHtml, sendPlain, options, progress);
    }
    return;
  }

  let mode: "html" | "plain" = "html";
  await sendWithRetry(async () => {
    if (mode === "html") {
      try {
        await sendHtml(html);
      } catch (err) {
        if (classifyTelegramSendError(err).kind !== "parse") throw err;
        // Telegram rejected our HTML entities — degrade this chunk to plain
        // text (loudly; the pre-P7 silent catch masked real rendering bugs).
        console.warn("[Telegram] HTML parse rejected; sending this chunk as plain text");
        mode = "plain";
        await sendPlain(chunk);
      }
    } else {
      await sendPlain(chunk);
    }
  }, options);
  progress.accepted++;
}

async function sendWithRetry(send: () => Promise<void>, options: ChunkSendOptions): Promise<void> {
  const retries = options.retries ?? 3;
  const baseMs = options.baseMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await send();
      return;
    } catch (err) {
      const { kind, retryAfterMs } = classifyTelegramSendError(err);
      if (kind === "permanent") {
        // Typed so deliver()'s outer retry gives up instead of re-sending the
        // whole message (which would duplicate every accepted earlier chunk).
        throw new PermanentDeliveryError(
          `Telegram rejected the send permanently: ${formatSendError(err)}`,
          { cause: err },
        );
      }
      if (attempt >= retries) throw err;
      // Honor retry_after verbatim — retrying earlier extends the flood limit.
      // On exhaustion sendChunked decides: partial delivery becomes a
      // PermanentDeliveryError (no replay), nothing-accepted escapes raw to
      // deliver()'s whole-message retry. Holding this group's queue slot for
      // the wait is the correct backpressure; delivery is already a separate
      // failure domain.
      await sleep(retryAfterMs ?? baseMs * Math.pow(2, attempt - 1));
    }
  }
}

function formatSendError(err: unknown): string {
  if (err instanceof TelegramApiError) return `${err.errorCode} ${err.description}`.trim();
  return err instanceof Error ? err.message : String(err);
}
