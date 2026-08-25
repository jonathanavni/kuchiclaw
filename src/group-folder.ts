// Manages per-group directory structure.
// Each group gets its own folder with MEMORY.md, CONTEXT.md, and logs/.

import fs from "node:fs";
import path from "node:path";
import { GROUPS_DIR, PROJECT_ROOT, IPC_DIR, SKILLS_DIR } from "./config.js";
import { isValidGroupName } from "./ipc-auth.js";

export interface GroupPaths {
  /** Root of this group's folder (e.g., groups/main/) */
  root: string;
  /** Per-group durable memory file */
  memory: string;
  /** Per-group session scratchpad */
  context: string;
  /** Container log directory */
  logs: string;
  /** Global SOUL.md (read-only, shared across groups) */
  soul: string;
  /** Global TOOLS.md (read-only, shared across groups) */
  tools: string;
  /** Host IPC directory — containers write requests here */
  ipc: string;
  /** Skills directory — CLI scripts mounted read-only */
  skills: string;
  /** Global HEARTBEAT.md (read-only, self-maintenance checklist) */
  heartbeat: string;
  /** Parent of per-run result directories — host-owned, never mounted itself */
  outRoot: string;
}

/** Ensure a group folder exists with all required files, return paths. */
export function ensureGroupFolder(groupName: string): GroupPaths {
  if (!isValidGroupName(groupName)) {
    throw new Error(`Invalid group name: "${groupName}"`);
  }

  const root = path.join(GROUPS_DIR, groupName);
  const ipc = path.join(IPC_DIR, groupName);
  const paths: GroupPaths = {
    root,
    memory: path.join(root, "MEMORY.md"),
    context: path.join(root, "CONTEXT.md"),
    logs: path.join(root, "logs"),
    soul: path.join(PROJECT_ROOT, "SOUL.md"),
    tools: path.join(PROJECT_ROOT, "TOOLS.md"),
    ipc,
    skills: SKILLS_DIR,
    heartbeat: path.join(PROJECT_ROOT, "HEARTBEAT.md"),
    outRoot: path.join(root, "out"),
  };

  assertRealDirectoryIfPresent(root, "group");
  assertRealDirectoryIfPresent(ipc, "IPC namespace");
  assertRealDirectoryIfPresent(paths.outRoot, "output root");

  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(ipc, { recursive: true });
  fs.mkdirSync(paths.outRoot, { recursive: true });
  assertRealDirectoryIfPresent(root, "group");
  assertRealDirectoryIfPresent(ipc, "IPC namespace");
  assertRealDirectoryIfPresent(paths.outRoot, "output root");

  // Seed MEMORY.md if it doesn't exist
  if (!fs.existsSync(paths.memory)) {
    fs.writeFileSync(paths.memory, "# Memory\n\n## Lessons\n\n## Facts\n");
  }

  // Seed CONTEXT.md if it doesn't exist
  if (!fs.existsSync(paths.context)) {
    fs.writeFileSync(paths.context, "# Context\n\nSession scratchpad.\n");
  }

  return paths;
}

function assertRealDirectoryIfPresent(target: string, description: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${description} path is not a real directory: ${target}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
