import fs from "node:fs";
import path from "node:path";
import {
  IPC_DIR,
  IPC_ERRORS_DIR,
  IPC_PARSE_GRACE_MS,
  IPC_POLL_MS,
  MAX_REQUEST_BYTES,
  MAX_REQUESTS_PER_NAMESPACE,
} from "./config.js";
import { isValidGroupName } from "./ipc-auth.js";
import { execute } from "./ipc.js";
import type { IpcRequest } from "./types.js";

export interface PollOptions {
  ipcDir?: string;
  errorsDir?: string;
  now?: () => number;
  firstSeen?: Map<string, number>;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
const defaultFirstSeen = new Map<string, number>();

export function startPolling(options: PollOptions = {}): void {
  const ipcDir = options.ipcDir ?? IPC_DIR;
  const errorsDir = options.errorsDir ?? IPC_ERRORS_DIR;
  fs.mkdirSync(ipcDir, { recursive: true });
  fs.mkdirSync(errorsDir, { recursive: true });
  stopped = false;

  const tick = async (): Promise<void> => {
    try {
      await pollOnce(options);
    } finally {
      if (!stopped) pollTimer = setTimeout(tick, IPC_POLL_MS);
    }
  };

  pollTimer = setTimeout(tick, IPC_POLL_MS);
  console.log(`[IPC] Polling ${ipcDir} every ${IPC_POLL_MS}ms`);
}

export function stopPolling(): void {
  stopped = true;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  console.log("[IPC] Polling stopped");
}

/** One non-reentrant scan; tests inject the clock and isolated roots. */
export async function pollOnce(options: PollOptions = {}): Promise<void> {
  const ipcDir = options.ipcDir ?? IPC_DIR;
  const errorsDir = options.errorsDir ?? IPC_ERRORS_DIR;
  const now = options.now ?? Date.now;
  const firstSeen = options.firstSeen ?? defaultFirstSeen;
  const present = new Set<string>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ipcDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[IPC] Cannot scan IPC root: ${err}`);
    }
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sourceGroup = entry.name;
    if (!isValidGroupName(sourceGroup)) {
      console.warn(`[IPC] Skipping invalid namespace "${sourceGroup}"`);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      console.warn(`[IPC] Skipping non-directory namespace "${sourceGroup}"`);
      continue;
    }

    const groupDir = path.join(ipcDir, sourceGroup);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(groupDir);
    } catch (err) {
      console.warn(`[IPC] Skipping unreadable namespace "${sourceGroup}": ${err}`);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      console.warn(`[IPC] Skipping unsafe namespace "${sourceGroup}"`);
      continue;
    }

    await pollNamespace(groupDir, sourceGroup, errorsDir, now, firstSeen, present);
  }

  for (const key of firstSeen.keys()) {
    if (!present.has(key)) firstSeen.delete(key);
  }
}

async function pollNamespace(
  groupDir: string,
  sourceGroup: string,
  errorsDir: string,
  now: () => number,
  firstSeen: Map<string, number>,
  present: Set<string>,
): Promise<void> {
  const entries: string[] = [];
  let overCap = false;
  let directory: fs.Dir | undefined;
  try {
    directory = fs.opendirSync(groupDir);
    for (let enumerated = 0; enumerated <= MAX_REQUESTS_PER_NAMESPACE; enumerated += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (enumerated === MAX_REQUESTS_PER_NAMESPACE) {
        overCap = true;
        break;
      }
      if (entry.name.endsWith(".json")) entries.push(entry.name);
    }
  } catch (err) {
    console.warn(`[IPC] Cannot scan namespace "${sourceGroup}": ${err}`);
    return;
  } finally {
    directory?.closeSync();
  }

  if (overCap) {
    console.warn(
      `[IPC] Namespace "${sourceGroup}" exceeds ${MAX_REQUESTS_PER_NAMESPACE} entries; processing the enumeration cap`,
    );
  }

  for (const fileName of entries) {
    const filePath = path.join(groupDir, fileName);
    const key = `${sourceGroup}/${fileName}`;
    present.add(key);

    let request: IpcRequest;
    try {
      const raw = readRequestFile(filePath);
      try {
        request = JSON.parse(raw) as IpcRequest;
      } catch (err) {
        const seenAt = firstSeen.get(key) ?? now();
        firstSeen.set(key, seenAt);
        if (now() - seenAt <= IPC_PARSE_GRACE_MS) continue;
        throw err;
      }

      await execute(request, sourceGroup, sourceGroup === "main");
      fs.unlinkSync(filePath);
      firstSeen.delete(key);
    } catch (err) {
      console.error(`[IPC] Error processing ${sourceGroup}/${fileName}:`, err);
      quarantine(filePath, sourceGroup, fileName, errorsDir);
      firstSeen.delete(key);
    }
  }
}

/** Read through one descriptor so metadata checks and bytes refer to one object. */
export function readRequestFile(filePath: string): string {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("IPC request is not a regular file");
    if (stat.nlink !== 1) throw new Error("IPC request must have exactly one hard link");
    if (stat.size > MAX_REQUEST_BYTES) throw new Error("IPC request exceeds size limit");

    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_REQUEST_BYTES) throw new Error("IPC request exceeds size limit");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function quarantineLooseRootRequests(
  ipcDir = IPC_DIR,
  errorsDir = IPC_ERRORS_DIR,
): void {
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(ipcDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`IPC root is not a real directory: ${ipcDir}`);
    }
    entries = fs.readdirSync(ipcDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".json") && !entry.isDirectory()) {
      quarantine(path.join(ipcDir, entry.name), "root", entry.name, errorsDir);
    }
  }
}

function quarantine(
  filePath: string,
  sourceGroup: string,
  fileName: string,
  errorsDir: string,
): void {
  try {
    fs.mkdirSync(errorsDir, { recursive: true });
    let target = path.join(errorsDir, `${Date.now()}-${sourceGroup}-${fileName}`);
    let suffix = 0;
    while (fs.existsSync(target)) {
      suffix += 1;
      target = path.join(errorsDir, `${Date.now()}-${suffix}-${sourceGroup}-${fileName}`);
    }
    fs.renameSync(filePath, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[IPC] Failed to quarantine ${sourceGroup}/${fileName}: ${err}`);
    }
  }
}
