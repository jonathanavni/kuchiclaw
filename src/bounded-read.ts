// Shared fd-based bounded file reader for container-written files (IPC requests
// and the signed result file). Reading through one descriptor with O_NOFOLLOW |
// O_NONBLOCK means the metadata checks and the bytes refer to the same object,
// so a container swapping the path between stat and read cannot win the race.

import fs from "node:fs";

/** Read at most `maxBytes` from a regular, single-hard-link, non-symlink file.
 *  Throws for a symlink (ELOOP), a non-regular file, nlink≠1, or oversize. */
export function readBoundedFile(filePath: string, maxBytes: number, what: string): string {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${what} is not a regular file`);
    if (stat.nlink !== 1) throw new Error(`${what} must have exactly one hard link`);
    if (stat.size > maxBytes) throw new Error(`${what} exceeds size limit`);

    // maxBytes+1 probe: fstat's size is raceable against a growing file, so the
    // authoritative cap is enforced on the bytes actually read.
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`${what} exceeds size limit`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
