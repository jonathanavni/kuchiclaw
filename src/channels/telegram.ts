// Telegram channel adapter using node-telegram-bot-api (long polling).
// Implements the Channel interface from registry.ts.

import TelegramBot from "node-telegram-bot-api";
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

export type MessageHandler = (msg: IncomingMessage) => void;

export class TelegramChannel implements Channel {
  private bot: TelegramBot | null = null;
  private token: string;
  private connected = false;
  private onMessageHandler: MessageHandler | null = null;
  private startTime = Date.now();
  private botUsername = "";

  constructor(token: string) {
    this.token = token;
  }

  /** Register a callback for incoming user messages (not commands) */
  onMessage(handler: MessageHandler): void {
    this.onMessageHandler = handler;
  }

  async connect(): Promise<void> {
    this.bot = new TelegramBot(this.token, { polling: true });
    this.startTime = Date.now();

    // Learn our own username for @mention detection in group chats
    const me = await this.bot.getMe();
    this.botUsername = me.username ?? "";

    // /start stays UNGATED on purpose: it's the bootstrap channel. A fresh
    // operator needs their chat ID (for MAIN_CHAT_ID) and user ID (for
    // ALLOWED_SENDER_IDS) before the allowlist can name them — and it only
    // tells the requester their own identifiers.
    this.bot.onText(/\/start/, (msg) => {
      this.bot!.sendMessage(
        msg.chat.id,
        `KuchiClaw is online.\nChat ID: ${msg.chat.id}\nYour user ID: ${msg.from?.id ?? "unknown"}`,
      );
    });

    this.bot.onText(/\/status/, (msg) => {
      if (!isAllowedSender(msg.from?.id ? String(msg.from.id) : undefined)) return;
      const uptimeMs = Date.now() - this.startTime;
      const uptimeMin = Math.floor(uptimeMs / 60_000);
      const statusText = `Status: running\nUptime: ${uptimeMin}m`;
      this.bot!.sendMessage(msg.chat.id, statusText);
    });

    // Regular messages (not commands)
    this.bot.on("message", (msg) => {
      if (!msg.text || msg.text.startsWith("/")) return;
      if (!this.onMessageHandler) return;

      const senderId = msg.from?.id ? String(msg.from.id) : undefined;
      const chatType = msg.chat.type as IncomingMessage["chatType"];

      if (!isAllowedSender(senderId)) return;

      // Group chats require @mention to activate
      let text = msg.text;
      const isGroupChat = chatType === "group" || chatType === "supergroup";
      if (isGroupChat && this.botUsername) {
        const mentionTag = `@${this.botUsername}`;
        if (!text.includes(mentionTag)) return;
        text = text.replace(mentionTag, "").trim();
        if (!text) return; // Nothing left after stripping mention
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

    this.connected = true;
    console.log(`[Telegram] Connected (long polling) as @${this.botUsername}`);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not connected");
    const numericId = Number(chatId);
    await sendChunked(
      text,
      async (html) => {
        await this.bot!.sendMessage(numericId, html, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      },
      async (plain) => {
        await this.bot!.sendMessage(numericId, plain);
      },
    );
  }

  /** Send typing indicator to a chat */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendChatAction(Number(chatId), "typing");
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // All Telegram chat IDs are numeric (possibly negative for groups)
    return /^-?\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.connected = false;
      console.log("[Telegram] Disconnected");
    }
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
 *  them can only duplicate earlier chunks; network/429/5xx are transient. */
export function classifyTelegramSendError(
  err: unknown,
): { kind: "parse" | "transient" | "permanent"; retryAfterMs?: number } {
  const body = (err as {
    response?: { body?: { error_code?: number; description?: string; parameters?: { retry_after?: number } } };
  })?.response?.body;
  const code = body?.error_code;
  if (code === 400 && /can't parse entities/i.test(body?.description ?? "")) {
    return { kind: "parse" };
  }
  if (typeof code === "number" && code >= 400 && code < 500 && code !== 429) {
    return { kind: "permanent" };
  }
  const retryAfter = body?.parameters?.retry_after;
  return { kind: "transient", retryAfterMs: typeof retryAfter === "number" ? retryAfter * 1000 : undefined };
}

/**
 * Render and deliver one logical message as sequential Telegram messages.
 * All retry and fallback handling is PER CHUNK: a later chunk's failure must
 * never re-send an earlier, already-accepted chunk — deliver()'s outer retry
 * re-runs the whole send, so this layer only throws once a single chunk has
 * exhausted its own retries (documented residual: Telegram has no idempotency
 * key, so exactly-once is unattainable after that point).
 */
export async function sendChunked(
  text: string,
  sendHtml: (html: string) => Promise<void>,
  sendPlain: (plain: string) => Promise<void>,
  options: ChunkSendOptions = {},
): Promise<void> {
  const maxLen = options.maxLen ?? TELEGRAM_MAX_LENGTH - 96;
  for (const chunk of splitMessage(text, maxLen)) {
    await sendOneChunk(chunk, sendHtml, sendPlain, options);
  }
}

async function sendOneChunk(
  chunk: string,
  sendHtml: (html: string) => Promise<void>,
  sendPlain: (plain: string) => Promise<void>,
  options: ChunkSendOptions,
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
      return;
    }
    for (const piece of splitMessage(chunk, smaller)) {
      await sendOneChunk(piece, sendHtml, sendPlain, options);
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
      // Honor retry_after verbatim — retrying earlier both extends the flood
      // limit and, on exhaustion, escalates to deliver()'s whole-message retry
      // (chunk-0 replay). Holding this group's queue slot for the wait is the
      // correct backpressure; delivery is already a separate failure domain.
      await sleep(retryAfterMs ?? baseMs * Math.pow(2, attempt - 1));
    }
  }
}

function formatSendError(err: unknown): string {
  const body = (err as { response?: { body?: { error_code?: number; description?: string } } })?.response?.body;
  if (body) return `${body.error_code} ${body.description ?? ""}`.trim();
  return err instanceof Error ? err.message : String(err);
}
