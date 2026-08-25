#!/usr/bin/env node

// CLI entrypoint for testing the agent loop.
// Usage: echo "What is 2+2?" | npx tsx src/cli.ts
//    or: npx tsx src/cli.ts "What is 2+2?"

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runContainer } from "./container-runner.js";
import type { ContainerTerminationUnknownError } from "./container-errors.js";
import { ensureGroupFolder } from "./group-folder.js";
import { insertMessage, updateMessageStatus, getRecentMessages, formatHistory } from "./db.js";
import { getSecrets } from "./auth.js";
import { isValidGroupName } from "./ipc-auth.js";
import type { ContainerInput } from "./types.js";

async function readStdin(): Promise<string> {
  // If stdin is a TTY (no piped input), return empty
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/** Parse CLI flags from argv */
function parseArgs(argv: string[]): { group: string; showHistory: boolean; promptArgs: string[] } {
  const args = argv.slice(2);
  let group = "main";
  let showHistory = false;
  const promptArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--group" && i + 1 < args.length) {
      group = args[++i];
    } else if (args[i] === "--history") {
      showHistory = true;
    } else {
      promptArgs.push(args[i]);
    }
  }

  return { group, showHistory, promptArgs };
}

export function validateCliGroup(group: string): void {
  if (isValidGroupName(group)) return;
  if (group === "main") {
    throw new Error('Group "main" is unavailable: set MAIN_CHAT_ID or pass --group tg-<id>');
  }
  throw new Error(`Invalid group name "${group}"; pass --group tg-<id>`);
}

export async function main() {
  const { group, showHistory, promptArgs } = parseArgs(process.argv);
  validateCliGroup(group);

  // --history: display recent conversation and exit
  if (showHistory) {
    const messages = getRecentMessages(group);
    if (messages.length === 0) {
      console.log(`No message history for group "${group}".`);
    } else {
      console.log(formatHistory(messages));
    }
    return;
  }

  // Get prompt from args or stdin
  const argsPrompt = promptArgs.join(" ");
  const stdinPrompt = await readStdin();
  const prompt = argsPrompt || stdinPrompt;

  if (!prompt) {
    console.error("Usage: npx tsx src/cli.ts \"your prompt\"");
    console.error("       npx tsx src/cli.ts --group mygroup \"your prompt\"");
    console.error("       npx tsx src/cli.ts --history [--group mygroup]");
    console.error("       echo \"your prompt\" | npx tsx src/cli.ts");
    process.exit(1);
  }

  const { secrets, isApiKeyFallback } = await getSecrets();
  const model = isApiKeyFallback ? "claude-sonnet-4-6" : undefined;
  const paths = ensureGroupFolder(group);

  // Load recent history from SQLite for conversational context
  const recentMessages = getRecentMessages(group);
  const messageHistory = formatHistory(recentMessages);

  // Store the user's prompt. The CLI processes it here and now — not via the
  // orchestrator queue — so give it a terminal status below so the orchestrator's
  // crash recovery never mistakes a finished CLI prompt for an orphaned work item.
  const userMsgId = insertMessage(group, "user", prompt);

  const input: ContainerInput = {
    prompt,
    groupFolder: group,
    secrets,
    messageHistory: messageHistory || undefined,
    model,
  };

  console.error(`[KuchiClaw] Group: ${group} | Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  try {
    const output = await runContainer(input, paths, {
      owner: "cli",
      onContainmentFailure: (error: ContainerTerminationUnknownError) => {
        console.error(`[KuchiClaw] ${error.message}; container may still be alive`);
        process.exitCode = 1;
      },
    });

    if (output.status === "success") {
      const result = output.result ?? "(no response)";
      updateMessageStatus(userMsgId, "done");
      // Store the agent's response
      insertMessage(group, "assistant", result);
      console.log(result);
    } else {
      updateMessageStatus(userMsgId, "failed");
      console.error(`[KuchiClaw] Agent error: ${output.error}`);
      process.exit(1);
    }
  } catch (err) {
    updateMessageStatus(userMsgId, "failed");
    console.error(`[KuchiClaw] Container error: ${err}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[KuchiClaw] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
