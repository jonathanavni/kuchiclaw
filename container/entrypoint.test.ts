import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_VISIBLE_SECRET_KEYS, RESULT_ENVELOPE_VERSION } from "./prepare.js";
import { getProductionExitCode, runEntrypoint, type QueryFn } from "./entrypoint.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runEntrypoint refresh boundary", () => {
  it.each(["success", "failure", "absent"] as const)(
    "scrubs before query on refresh %s",
    async (kind) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const refreshToken = kind === "absent" ? undefined : `refresh-${kind}`;
      if (kind !== "absent") {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(kind === "success"
          ? {
              ok: true,
              json: async () => ({
                access_token: "new-short-access",
                refresh_token: "rotated-refresh",
                expires_in: 60,
              }),
            }
          : { ok: false }));
      }
      const env: Record<string, string | undefined> = {};
      const capture: BoundaryCapture = {};
      const observe = snapshotObserver(capture);
      const query = snapshottingSuccessfulQuery(capture);

      const output = await runEntrypoint(rawInput(refreshToken), {
        query, env, observe,
      });

      expect(observe).toHaveBeenCalledOnce();
      const boundary = JSON.parse(capture.observeJson!);
      expect(boundary.input).not.toHaveProperty("refreshToken");
      expect(capture.optionsEnv).toBe(env);
      expect(JSON.parse(capture.queryEnvJson!)).toEqual(boundary.env);
      if (refreshToken) {
        expect(capture.observeJson).not.toContain(refreshToken);
        expect(capture.queryEnvJson).not.toContain(refreshToken);
        expect(capture.queryJson).not.toContain(refreshToken);
      }
      if (kind === "success") {
        // The rotated refresh token must stay in the newTokens carrier only —
        // never in the options/systemPrompt/prompt handed to the SDK.
        expect(capture.observeJson).not.toContain("rotated-refresh");
        expect(capture.queryJson).not.toContain("rotated-refresh");
      }
      expect(output.newTokens !== undefined).toBe(kind === "success");
      expect(output.status).toBe("success");
    },
  );

  it("refuses smuggling aliases and every allowlisted key by refresh-token value", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const refreshToken = "long-lived-refresh-never-expose";
    const secrets = Object.fromEntries([
      ["OAUTH_ROTATION_TOKEN", refreshToken],
      ["refreshToken", refreshToken],
      ...AGENT_VISIBLE_SECRET_KEYS.map((key) => [key, refreshToken]),
    ]);
    const env: Record<string, string | undefined> = {};
    const capture: BoundaryCapture = {};
    const query = snapshottingSuccessfulQuery(capture);

    const output = await runEntrypoint(rawInput(refreshToken, secrets), {
      query,
      env,
      observe: snapshotObserver(capture),
    });

    expect(query).toHaveBeenCalledOnce();
    expect(JSON.parse(capture.queryEnvJson!)).toEqual({});
    expect(output.warnings).toEqual([
      "refused secret key: OAUTH_ROTATION_TOKEN",
      "refused secret key: refreshToken",
      ...AGENT_VISIBLE_SECRET_KEYS.map((key) => `refused secret key: ${key}`),
    ]);
    expect(JSON.stringify(output.warnings)).not.toContain(refreshToken);
    expect(output.status).toBe("success");
  });

  it("does not rebroadcast the refresh credential after query resolves", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const refreshToken = "original-refresh-token";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "short-access", expires_in: 60 }),
    }));
    const env: Record<string, string | undefined> = {};
    const capture: BoundaryCapture = {};

    const output = await runEntrypoint(rawInput(refreshToken), {
      query: snapshottingSuccessfulQuery(capture),
      env,
      observe: snapshotObserver(capture),
    });

    expect(capture.observeJson).not.toContain(refreshToken);
    expect(capture.queryEnvJson).not.toContain(refreshToken);
    expect(capture.queryJson).not.toContain(refreshToken);
    expect(JSON.stringify(env)).not.toContain(refreshToken);
    expect(output.newTokens?.refreshToken).toBe(refreshToken);
    const { newTokens: sanctionedCarrier, ...agentVisibleOutput } = output;
    expect(sanctionedCarrier).toBeDefined();
    expect(JSON.stringify(agentVisibleOutput)).not.toContain(refreshToken);
  });

  it.each([
    {
      name: "access token equals the input refresh token",
      response: {
        access_token: "input-refresh-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 60,
      },
    },
    {
      name: "access token equals the returned refresh token",
      response: {
        access_token: "returned-refresh-token",
        refresh_token: "returned-refresh-token",
        expires_in: 60,
      },
    },
  ])("keeps the original access token when $name", async ({ response }) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => response,
    }));
    const capture: BoundaryCapture = {};
    const output = await runEntrypoint(rawInput("input-refresh-token"), {
      env: {},
      query: snapshottingSuccessfulQuery(capture),
      observe: snapshotObserver(capture),
    });

    const queryEnv = JSON.parse(capture.queryEnvJson!);
    expect(queryEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("existing-short-access");
    for (const refreshValue of ["input-refresh-token", response.refresh_token]) {
      expect(capture.observeJson).not.toContain(refreshValue);
      expect(capture.queryEnvJson).not.toContain(refreshValue);
      expect(JSON.stringify(output)).not.toContain(refreshValue);
    }
    expect(output.newTokens).toBeUndefined();
  });

  it("redacts a refused key whose name equals the refresh credential", async () => {
    const refreshToken = "credential-shaped-secret-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const capture: BoundaryCapture = {};

    const output = await runEntrypoint(
      rawInput(refreshToken, {
        CLAUDE_CODE_OAUTH_TOKEN: "existing-short-access",
        [refreshToken]: "x",
      }),
      {
        env: {},
        query: snapshottingSuccessfulQuery(capture),
        observe: snapshotObserver(capture),
      },
    );

    expect(output.warnings).toEqual(["refused secret key: <redacted>"]);
    expect(JSON.stringify(output)).not.toContain(refreshToken);
    expect(JSON.stringify(output.warnings)).not.toContain(refreshToken);
    expect(JSON.stringify(log.mock.calls)).not.toContain(refreshToken);
    expect(capture.queryEnvJson).not.toContain(refreshToken);
  });
});

describe("signed result transport (P5.1)", () => {
  const outputKey = "ab".repeat(32); // 32-byte hex

  it("writes a valid signed envelope the host can verify with the per-run key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const capture: BoundaryCapture = {};
    let envelope: string | undefined;

    const output = await runEntrypoint(rawInput(undefined, undefined, outputKey), {
      env: {},
      query: snapshottingSuccessfulQuery(capture),
      writeResult: (e) => { envelope = e; },
    });

    expect(envelope).toBeDefined();
    const parsed = JSON.parse(envelope!) as { v: number; hmac: string; payload: string };
    expect(parsed.v).toBe(RESULT_ENVELOPE_VERSION);
    const expected = createHmac("sha256", Buffer.from(outputKey, "hex"))
      .update(parsed.payload, "utf8").digest("hex");
    expect(parsed.hmac).toBe(expected);
    expect(JSON.parse(parsed.payload)).toMatchObject({ status: "success", result: "done" });
    expect(output.status).toBe("success");
  });

  it("scrubs the output key from the agent boundary and never emits it in env or prompt", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const capture: BoundaryCapture = {};

    await runEntrypoint(rawInput(undefined, undefined, outputKey), {
      env: {},
      query: snapshottingSuccessfulQuery(capture),
      observe: snapshotObserver(capture),
      writeResult: () => {},
    });

    const boundary = JSON.parse(capture.observeJson!);
    expect(boundary.input).not.toHaveProperty("outputKey");
    expect(capture.observeJson).not.toContain(outputKey);
    expect(capture.queryEnvJson).not.toContain(outputKey);
    expect(capture.queryJson).not.toContain(outputKey);
  });

  it("refuses a secret whose value equals the output key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const capture: BoundaryCapture = {};

    const output = await runEntrypoint(
      rawInput(undefined, { CLAUDE_CODE_OAUTH_TOKEN: outputKey }, outputKey),
      {
        env: {},
        query: snapshottingSuccessfulQuery(capture),
        observe: snapshotObserver(capture),
        writeResult: () => {},
      },
    );

    expect(output.warnings).toEqual(["refused secret key: CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(JSON.parse(capture.queryEnvJson!)).toEqual({});
    expect(capture.queryEnvJson).not.toContain(outputKey);
  });

  it("writes nothing when no output key is supplied", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const writeResult = vi.fn();

    await runEntrypoint(rawInput(), { env: {}, query: snapshottingSuccessfulQuery({}), writeResult });

    expect(writeResult).not.toHaveBeenCalled();
  });
});

it("uses a nonzero production exit code only for crash-level errors", () => {
  expect(getProductionExitCode({ status: "error", error: "Container crashed: boom" })).toBe(1);
  expect(getProductionExitCode({ status: "error", error: "Agent stopped: failure" })).toBe(0);
  expect(getProductionExitCode({ status: "success" })).toBe(0);
});

function rawInput(
  refreshToken?: string,
  secrets: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "existing-short-access" },
  outputKey?: string,
): string {
  return JSON.stringify({
    prompt: "hello",
    groupFolder: "tg-123",
    chatId: "123",
    secrets,
    refreshToken,
    outputKey,
    systemPrompt: "trusted system prompt",
    messageHistory: "recent messages",
  });
}

interface BoundaryCapture {
  observeJson?: string;
  optionsEnv?: unknown;
  queryEnvJson?: string;
  queryJson?: string;
}

function snapshotObserver(capture: BoundaryCapture) {
  return vi.fn((state: Parameters<NonNullable<Parameters<typeof runEntrypoint>[1]["observe"]>>[0]) => {
    // Serialize the FULL boundary (options includes systemPrompt) so value-based
    // assertions cover every channel the SDK receives, not just env and input.
    capture.observeJson = JSON.stringify({ env: state.env, input: state.input, options: state.options });
    capture.optionsEnv = state.options.env;
  });
}

function snapshottingSuccessfulQuery(
  capture: BoundaryCapture,
): ReturnType<typeof vi.fn<QueryFn>> {
  return vi.fn<QueryFn>((args) => {
    capture.queryEnvJson = JSON.stringify(args.options.env);
    capture.queryJson = JSON.stringify({ prompt: args.prompt, options: args.options });
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done" };
    })();
  });
}

describe("model threading (P6.3)", () => {
  function modelRawInput(model?: string, fallbackModel?: string): string {
    return JSON.stringify({
      prompt: "hello",
      groupFolder: "tg-123",
      chatId: "123",
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "existing-short-access" },
      model,
      fallbackModel,
    });
  }

  it("forwards model and fallbackModel to the SDK options", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const capture: BoundaryCapture = {};
    const query = snapshottingSuccessfulQuery(capture);

    const output = await runEntrypoint(modelRawInput("opus", "sonnet"), { query, env: {} });

    expect(output.status).toBe("success");
    const q = JSON.parse(capture.queryJson!);
    expect(q.options.model).toBe("opus");
    expect(q.options.fallbackModel).toBe("sonnet");
  });

  it("omits both keys entirely when unset (SDK default must win)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const capture: BoundaryCapture = {};
    const query = snapshottingSuccessfulQuery(capture);

    const output = await runEntrypoint(modelRawInput(), { query, env: {} });

    expect(output.status).toBe("success");
    const q = JSON.parse(capture.queryJson!);
    expect(q.options).not.toHaveProperty("model");
    expect(q.options).not.toHaveProperty("fallbackModel");
  });
});
