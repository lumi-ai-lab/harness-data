import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Serialize bundle producers and Marketplace consumers of plugins/harness-data/dist. */
export function acquireDistBuildLock(dist, { timeoutMs = 30_000, staleMs = 120_000 } = {}) {
  const lockPath = `${dist}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`, "utf8");
      return {
        path: lockPath,
        release() {
          rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // The competing builder may be replacing the lock; retry below.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error(`timed out waiting for bundle lock: ${lockPath}`);
}
