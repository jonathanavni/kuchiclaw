import { beforeEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => ({ held: new Set<number>(), nextPort: 55_000 }));

vi.mock("node:net", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  return { default: {
    createServer: () => {
      class FakeServer extends EventEmitter {
        listening = false;
        private port = 0;

        listen(requestedPort: number, _host: string, callback: () => void) {
          const port = requestedPort === 0 ? sockets.nextPort++ : requestedPort;
          if (sockets.held.has(port)) {
            queueMicrotask(() => this.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" })));
            return this;
          }
          this.port = port;
          this.listening = true;
          sockets.held.add(port);
          queueMicrotask(callback);
          return this;
        }

        address() { return { address: "127.0.0.1", family: "IPv4", port: this.port }; }

        close(callback?: (err?: Error) => void) {
          if (this.listening) sockets.held.delete(this.port);
          this.listening = false;
          queueMicrotask(() => callback?.());
          return this;
        }
      }
      return new FakeServer();
    },
  } };
});

import { acquireInstanceLock } from "./instance-lock.js";

beforeEach(() => sockets.held.clear());

describe("TCP instance lock", () => {
  it("allows exactly one holder on the same port", async () => {
    const first = await acquireInstanceLock(0);
    try {
      await expect(acquireInstanceLock(first.port)).rejects.toThrow(
        new RegExp(`another orchestrator instance.*port ${first.port} in use`),
      );
    } finally {
      await first.release();
    }
  });

  it("frees the port after the holder closes", async () => {
    const first = await acquireInstanceLock(0);
    const port = first.port;
    await first.release();
    const second = await acquireInstanceLock(port);
    expect(second.port).toBe(port);
    await second.release();
  });

  it("respects a caller-supplied port", async () => {
    const lock = await acquireInstanceLock(48_765);
    expect(lock.port).toBe(48_765);
    await lock.release();
  });
});
