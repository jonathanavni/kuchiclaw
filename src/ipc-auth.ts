import path from "node:path";
import { IPC_DIR, MAIN_CHAT_ID } from "./config.js";
import { chatIdToGroup, groupToChatId } from "./group-mapping.js";

/** Telegram IDs must survive the channel adapter's Number conversion exactly. */
export function isCanonicalChatId(id: string): boolean {
  return /^-?[1-9][0-9]*$/.test(id) && String(Number(id)) === id;
}

/** Phase 1 accepts only the configured main namespace and Telegram namespaces. */
export function isValidGroupName(name: string): boolean {
  const validShape = name === "main"
    ? isValidMainChatId(MAIN_CHAT_ID)
    : name.startsWith("tg-") && isCanonicalChatId(name.slice(3));

  return validShape && path.relative(IPC_DIR, path.join(IPC_DIR, name)) === name;
}

export function isValidMainChatId(value: string): boolean {
  return value.startsWith("tg-") && isCanonicalChatId(value.slice(3));
}

/** Stored or mounted identities are valid only when both directions agree exactly. */
function hasExactGroupDestination(group: string, chatId: string): boolean {
  if (!isValidGroupName(group) || !isCanonicalChatId(chatId)) return false;
  if (group === "main") return true;
  return chatIdToGroup("tg", chatId) === group && groupToChatId(group) === chatId;
}

export function assertDestinationAllowed(
  sourceGroup: string,
  isMain: boolean,
  chatId: string,
): void {
  if (!isValidGroupName(sourceGroup) || isMain !== (sourceGroup === "main")) {
    throw new Error(`Authorization denied: invalid source group "${sourceGroup}"`);
  }
  if (!isCanonicalChatId(chatId)) {
    throw new Error(`Authorization denied: noncanonical chat ID "${chatId}"`);
  }
  if (!isMain && !hasExactGroupDestination(sourceGroup, chatId)) {
    throw new Error(
      `Authorization denied: group "${sourceGroup}" cannot access chat ${chatId}`,
    );
  }
}
