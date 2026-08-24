// Maps channel chat IDs to group folder names.
// Each channel+chatId pair gets a unique group. One chat (MAIN_CHAT_ID) maps to "main".
// MAIN_CHAT_ID is channel-qualified (e.g., "tg-123456789") so it works across channels.

import { MAIN_CHAT_ID } from "./config.js";

/**
 * Convert a channel chat ID to a group folder name.
 * The main chat maps to "main"; all others get "{prefix}-{chatId}".
 */
export function chatIdToGroup(channelPrefix: string, chatId: string): string {
  const qualifiedId = `${channelPrefix}-${chatId}`;
  if (MAIN_CHAT_ID && qualifiedId === MAIN_CHAT_ID) return "main";
  return qualifiedId;
}

/**
 * Reverse lookup: extract the chat ID from a group folder name.
 * Returns the chat ID portion of MAIN_CHAT_ID for "main", strips the channel prefix for others.
 * Returns null if the group name doesn't match the expected format.
 */
export function groupToChatId(group: string): string | null {
  if (group === "main") {
    if (!MAIN_CHAT_ID) return null;
    // MAIN_CHAT_ID is "{prefix}-{chatId}" — strip the prefix
    const match = MAIN_CHAT_ID.match(/^[a-z]+-(.+)$/);
    return match ? match[1] : null;
  }

  const match = group.match(/^tg-(.+)$/);
  return match ? match[1] : null;
}
