import { CONTAINER_IMAGE } from "./config.js";
import { execDocker, type DockerExecResult } from "./docker.js";

export async function preflightDocker(): Promise<void> {
  const version = await execDocker(["version"]);
  if (!version.ok) {
    throw new Error(
      `Docker daemon preflight failed; verify Docker is installed and reachable: ${dockerSummary(version)}`,
    );
  }
  const image = await execDocker(["image", "inspect", CONTAINER_IMAGE]);
  if (!image.ok) {
    throw new Error(
      `Docker image preflight failed for ${CONTAINER_IMAGE}; build or pull the image before startup: ${dockerSummary(image)}`,
    );
  }
}

/** Remove orchestrator-owned and pre-label legacy containers, never CLI-labeled runs. */
export async function reapOrchestratorContainers(): Promise<void> {
  const initial = await enumerateReapTargets("initial");
  const remaining = new Set(initial);
  for (const id of initial) {
    const removed = await execDocker(["rm", "--force", id]);
    if (!removed.ok && !isContainerAbsent(removed)) {
      throw new Error(
        `Docker reap removal failed; surviving/unverifiable IDs: ${[...remaining].join(", ")}; ` +
        `${id}: ${dockerSummary(removed)}`,
      );
    }
    remaining.delete(id);
  }

  const survivors = await enumerateReapTargets("final");
  if (survivors.size > 0) {
    throw new Error(`Docker reap incomplete; surviving/unverifiable IDs: ${[...survivors].join(", ")}`);
  }
}

async function enumerateReapTargets(stage: string): Promise<Set<string>> {
  const ownedResult = await execDocker([
    "ps", "-aq", "--filter", "label=kuchiclaw.owner=orchestrator",
  ]);
  const owned = parseDockerIds(ownedResult, `${stage} owner enumeration`);
  const namedResult = await execDocker([
    "ps", "-aq", "--filter", "name=^kuchiclaw-",
  ]);
  const named = parseDockerIds(namedResult, `${stage} legacy enumeration`);
  const targets = new Set(owned);

  for (const id of named) {
    if (targets.has(id)) continue;
    const inspected = await execDocker(["inspect", "-f", "{{json .Config.Labels}}", id]);
    if (!inspected.ok) {
      throw new Error(
        `Docker reap could not verify labels; surviving/unverifiable IDs: ${id}; ${dockerSummary(inspected)}`,
      );
    }
    let labels: Record<string, unknown> | null;
    try {
      labels = JSON.parse(inspected.stdout.trim() || "null") as Record<string, unknown> | null;
    } catch {
      throw new Error(`Docker reap received malformed labels; surviving/unverifiable IDs: ${id}`);
    }
    if (labels !== null && (typeof labels !== "object" || Array.isArray(labels))) {
      throw new Error(`Docker reap received malformed labels; surviving/unverifiable IDs: ${id}`);
    }
    if (!labels || labels["kuchiclaw.owner"] === undefined) targets.add(id);
  }
  return targets;
}

function parseDockerIds(result: DockerExecResult, operation: string): Set<string> {
  if (!result.ok) {
    throw new Error(
      `Docker reap ${operation} failed; surviving/unverifiable IDs: unknown; ${dockerSummary(result)}`,
    );
  }
  const ids = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
  for (const id of ids) {
    if (!/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/i.test(id)) {
      throw new Error(`Docker reap ${operation} returned malformed ID; surviving/unverifiable IDs: ${id}`);
    }
  }
  return new Set(ids);
}

function isContainerAbsent(result: DockerExecResult): boolean {
  return !result.timedOut && /no such (?:container|object)/i.test(result.stderr);
}

function dockerSummary(result: DockerExecResult): string {
  return `ok:${result.ok},timedOut:${result.timedOut},code:${result.code},` +
    `stderr:${JSON.stringify(result.stderr.slice(0, 300))}`;
}
