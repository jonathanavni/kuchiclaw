#!/usr/bin/env node

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTAINER_OUTPUT_DIR,
  RESULT_FILENAME,
  RESULT_TMP_FILENAME,
  applySecretsToEnv,
  assembleSystemPrompt,
  parseInput,
  refreshAuth,
  signEnvelope,
  type AgentEnv,
  type ContainerInput,
  type OAuthTokens,
} from "./prepare.js";

interface ContainerOutput {
  status: "success" | "error";
  result?: string;
  error?: string;
  newTokens?: OAuthTokens;
  warnings?: string[];
}

/** Sink for the signed envelope — a seam so tests spy instead of touching the
 *  filesystem. Production writes it atomically to the mounted output dir. */
export type WriteResultFn = (envelope: string) => void;

interface QueryArgs {
  prompt: string;
  options: Record<string, unknown>;
}

export type QueryFn = (args: QueryArgs) => AsyncIterable<unknown>;

export interface EntrypointDeps {
  query: QueryFn;
  env?: AgentEnv;
  writeResult?: WriteResultFn;
  observe?: (state: {
    input: ContainerInput;
    env: AgentEnv;
    options: Record<string, unknown>;
  }) => void;
}

export async function runEntrypoint(
  raw: string,
  deps: EntrypointDeps,
): Promise<ContainerOutput> {
  let sdkStderr = "";
  let warnings: string[] = [];
  let newTokens: OAuthTokens | undefined;
  // The signing key is needed at emit() — after untrusted agent code runs — so
  // it cannot be consumed-then-dropped like refreshToken. It lives only in this
  // closure local: never in env (/proc/pid/environ is same-uid readable), and
  // the property is deleted from `input` before observe/options are built.
  let outputKey: string | undefined;

  const emit = (output: ContainerOutput): ContainerOutput => {
    if (outputKey !== undefined && deps.writeResult) {
      deps.writeResult(signEnvelope(output, outputKey));
    }
    return output;
  };

  try {
    const input = parseInput(raw);
    outputKey = input.outputKey;
    delete input.outputKey;
    const env = deps.env ?? process.env;
    warnings = applySecretsToEnv(input.secrets, env, [input.refreshToken, outputKey]);
    newTokens = await refreshAuth(input, env);
    const systemPrompt = assembleSystemPrompt(input);
    // maxTurns is a circuit breaker against runaway loops, not a primary control —
    // set it high enough that normal multi-step skills finish (read docs → run tool
    // → summarize is already ~4 turns), low enough to kill a misbehaving agent.
    const maxTurns = 20;
    const options: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      maxTurns,
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
      cwd: "/workspace",
      systemPrompt,
      env,
      stderr: (data: string) => { sdkStderr += data; },
      ...(input.model ? { model: input.model } : {}),
      ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
    };
    if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
      options.mcpServers = input.mcpServers;
    }

    // This seam observes the exact objects handed to untrusted agent code.
    deps.observe?.({ input, env, options });
    const session = deps.query({ prompt: input.prompt, options });
    let resultText = "";
    let lastAssistantText = "";

    for await (const message of session) {
      const m = message as {
        type: string;
        subtype?: string;
        result?: string;
        message?: { content?: unknown };
      };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        const texts = (m.message.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string);
        if (texts.length > 0) lastAssistantText = texts.join("\n");
      }
      if (m.type !== "result") continue;
      if (m.subtype === "success") {
        resultText = m.result ?? "";
      } else if (m.subtype === "error_max_turns") {
        // Turn cap is a safety valve, not a logical failure. The agent may have
        // already finished the real work (e.g. sent an email, created a task)
        // and just run out of budget before summarizing. Return whatever it last
        // said, with a hint that the reply may be incomplete.
        resultText = lastAssistantText
          ? `${lastAssistantText}\n\n_(hit the ${maxTurns}-turn limit — reply may be incomplete)_`
          : `Hit the ${maxTurns}-turn limit before producing a response. The work may have partially completed — check downstream effects (emails, tasks, memory).`;
      } else {
        const detail = m.subtype ?? "unknown";
        if (sdkStderr) console.error(`[entrypoint] SDK stderr on ${detail}: ${sdkStderr}`);
        return emit(withMetadata({ status: "error", error: `Agent stopped: ${detail}` }, warnings, newTokens));
      }
    }

    return emit(withMetadata({ status: "success", result: resultText }, warnings, newTokens));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sdkStderr) console.error(`[entrypoint] SDK stderr: ${sdkStderr}`);
    return emit(withMetadata({ status: "error", error: `Container crashed: ${message}` }, warnings, newTokens));
  }
}

function withMetadata(
  output: ContainerOutput,
  warnings: string[],
  newTokens: OAuthTokens | undefined,
): ContainerOutput {
  return {
    ...output,
    ...(newTokens ? { newTokens } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Atomically publish the signed envelope: exclusive-create the temp file
 *  (O_EXCL|O_NOFOLLOW defeats a pre-planted symlink/FIFO from the same-uid
 *  agent — a collision fails the write, which is denial, never forgery), fsync,
 *  then rename over the result path so the host never reads a partial file. */
function writeResultFile(envelope: string): void {
  const tmpPath = path.join(CONTAINER_OUTPUT_DIR, RESULT_TMP_FILENAME);
  const finalPath = path.join(CONTAINER_OUTPUT_DIR, RESULT_FILENAME);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const fd = openSync(tmpPath, flags, 0o600);
  try {
    writeSync(fd, envelope);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export function getProductionExitCode(output: {
  status: "success" | "error";
  error?: string;
}): 0 | 1 {
  return output.status === "error" && output.error?.startsWith("Container crashed:") ? 1 : 0;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const output = await runEntrypoint(raw, {
    query: sdk.query as QueryFn,
    writeResult: writeResultFile,
  });
  if (getProductionExitCode(output) === 1) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // No signing key is available outside runEntrypoint (parseInput may not have
    // run), so no authentic result file can be written. Log and exit nonzero;
    // the host sees a missing result and fails the job without a retry.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[entrypoint] Container crashed: ${message}`);
    process.exit(1);
  });
}
