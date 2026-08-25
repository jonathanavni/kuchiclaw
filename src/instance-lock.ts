import net from "node:net";
import { INSTANCE_LOCK_PORT } from "./config.js";

export interface InstanceLock {
  host: string;
  port: number;
  release(): Promise<void>;
}

/** Hold a loopback listen socket for the process lifetime as a singleton backstop. */
export function acquireInstanceLock(port = INSTANCE_LOCK_PORT): Promise<InstanceLock> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let acquired = false;

    const onError = (err: NodeJS.ErrnoException) => {
      if (acquired) return;
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          `another orchestrator instance is running (instance lock port ${port} in use; ` +
          "an unrelated process may also be holding the configurable port)",
        ));
        return;
      }
      reject(err);
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      acquired = true;
      server.removeListener("error", onError);
      const address = server.address();
      const boundHost = typeof address === "object" && address ? address.address : "127.0.0.1";
      const boundPort = typeof address === "object" && address ? address.port : port;
      let released = false;
      resolve({
        host: boundHost,
        port: boundPort,
        release: () => new Promise<void>((releaseResolve, releaseReject) => {
          if (released || !server.listening) {
            released = true;
            releaseResolve();
            return;
          }
          released = true;
          server.close((err) => err ? releaseReject(err) : releaseResolve());
        }),
      });
    });
  });
}
