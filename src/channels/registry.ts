// Channel interface — abstraction over messaging platforms.
// Telegram first, extensible to WhatsApp etc. later.

/** Normalized incoming message from any channel */
export interface IncomingMessage {
  /** Channel-specific chat identifier (e.g., Telegram chat ID) */
  chatId: string;
  /** Display name of the sender */
  senderName: string;
  /** Message text content */
  text: string;
  /** Chat type — used for @mention filtering (group chats require mention) */
  chatType?: "private" | "group" | "supergroup" | "channel";
  /** Platform-specific sender ID — used for allowlist checks */
  senderId?: string;
}

/** Thrown by a channel's sendMessage when the failure is permanent (e.g. bot
 *  blocked, malformed request) — retrying can only duplicate already-delivered
 *  chunks, so the queue's delivery retry must give up on it immediately. */
export class PermanentDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentDeliveryError";
  }
}

/** A messaging channel (Telegram, WhatsApp, etc.) */
export interface Channel {
  /** Establish connection to the messaging platform */
  connect(): Promise<void>;

  /** Send a text message to a specific chat */
  sendMessage(chatId: string, text: string): Promise<void>;

  /** Whether the channel is currently connected */
  isConnected(): boolean;

  /** Whether this channel owns/handles the given chat ID */
  ownsJid(jid: string): boolean;

  /** Gracefully disconnect from the messaging platform */
  disconnect(): Promise<void>;
}
