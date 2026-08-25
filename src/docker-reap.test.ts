import { beforeEach, describe, expect, it, vi } from "vitest";

const execDocker = vi.hoisted(() => vi.fn());
vi.mock("./docker.js", () => ({ execDocker }));

import { preflightDocker, reapOrchestratorContainers } from "./docker-reap.js";

const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr = "docker failed") => ({
  ok: false, code: 1, stdout: "", stderr, timedOut: false,
});

beforeEach(() => {
  execDocker.mockReset().mockResolvedValue(ok());
});

describe("fail-closed legacy-aware reap", () => {
  it("aborts on first ps failure", async () => {
    execDocker.mockResolvedValueOnce(bad("daemon unavailable"));
    await expect(reapOrchestratorContainers()).rejects.toThrow(/unverifiable IDs.*unknown/);
    expect(execDocker).toHaveBeenCalledOnce();
  });

  it("aborts on rm failure and names the target", async () => {
    execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(bad("permission denied"));
    await expect(reapOrchestratorContainers()).rejects.toThrow(/aaaaaaaaaaaa/);
  });

  it("accepts an auto-remove race reported as no-such-object", async () => {
    execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(bad("Error: No such object: aaaaaaaaaaaa"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await expect(reapOrchestratorContainers()).resolves.toBeUndefined();
  });

  it("aborts on final ps failure", async () => {
    execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(bad("final enumeration failed"));
    await expect(reapOrchestratorContainers()).rejects.toThrow(/unverifiable IDs.*unknown/);
  });

  it("aborts and names a container that survives the final enumeration", async () => {
    execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok());
    await expect(reapOrchestratorContainers()).rejects.toThrow(/incomplete.*aaaaaaaaaaaa/);
  });

  it("removes unlabeled legacy containers but leaves CLI-labeled containers untouched", async () => {
    let namedCalls = 0;
    execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "ps" && args.includes("label=kuchiclaw.owner=orchestrator")) return ok();
      if (args[0] === "ps") {
        namedCalls++;
        return ok(namedCalls === 1 ? "aaaaaaaaaaaa\nbbbbbbbbbbbb\n" : "bbbbbbbbbbbb\n");
      }
      if (args[0] === "inspect" && args.at(-1) === "aaaaaaaaaaaa") return ok("null\n");
      if (args[0] === "inspect") return ok('{"kuchiclaw.owner":"cli"}\n');
      if (args[0] === "rm") return ok();
      return bad("unexpected command");
    });

    await reapOrchestratorContainers();

    expect(execDocker).toHaveBeenCalledWith(["rm", "--force", "aaaaaaaaaaaa"]);
    expect(execDocker).not.toHaveBeenCalledWith(["rm", "--force", "bbbbbbbbbbbb"]);
  });
});

describe("Docker startup preflight", () => {
  it("fails actionably when the daemon version check fails", async () => {
    execDocker.mockResolvedValueOnce(bad("cannot connect"));
    await expect(preflightDocker()).rejects.toThrow(/Docker daemon preflight failed.*reachable/);
    expect(execDocker).toHaveBeenCalledOnce();
  });

  it("fails actionably when the configured image is absent", async () => {
    execDocker.mockResolvedValueOnce(ok()).mockResolvedValueOnce(bad("No such image"));
    await expect(preflightDocker()).rejects.toThrow(/Docker image preflight failed.*build or pull/);
  });
});
