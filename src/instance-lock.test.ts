import net from "node:net";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock } from "./instance-lock.js";

describe("TCP instance lock with real loopback sockets", () => {
  it("allows exactly one holder on a loopback port", async () => {
    const first = await acquireInstanceLock(0);
    try {
      expect(first.host).toBe("127.0.0.1");
      await expect(acquireInstanceLock(first.port)).rejects.toThrow(
        new RegExp(`another orchestrator instance.*port ${first.port} in use`),
      );
    } finally {
      await first.release();
    }
  });

  it("frees the real port after the holder closes", async () => {
    const first = await acquireInstanceLock(0);
    const port = first.port;
    await first.release();

    const second = await acquireInstanceLock(port);
    expect(second.port).toBe(port);
    expect(second.host).toBe("127.0.0.1");
    await second.release();
  });

  it("respects a caller-supplied free port", async () => {
    const port = await findFreeLoopbackPort();
    const lock = await acquireInstanceLock(port);
    expect(lock.port).toBe(port);
    expect(lock.host).toBe("127.0.0.1");
    await lock.release();
  });
});

function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("loopback probe did not return a TCP address"));
        return;
      }
      probe.close((err) => err ? reject(err) : resolve(address.port));
    });
  });
}
