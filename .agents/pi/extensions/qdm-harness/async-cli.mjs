import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the checks.
    }
  }, 250);
  forceTimer.unref?.();
}

export function runAsyncCommand(command, args, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        error,
        timedOut: false,
        aborted: false,
        truncated: false,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let spawnError;
    let settled = false;

    const append = (chunks, chunk) => {
      if (truncated) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        terminate(child);
        return;
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        outputBytes += remaining;
        truncated = true;
        terminate(child);
        return;
      }
      chunks.push(buffer);
      outputBytes += buffer.length;
    };

    child.stdout.on("data", (chunk) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => append(stderrChunks, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = () => {
      aborted = true;
      terminate(child);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener?.("abort", onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: spawnError,
        timedOut,
        aborted,
        truncated,
      });
    };

    child.on("close", finish);
    child.stdin.on("error", () => {
      // EPIPE is expected when a command exits before consuming all input.
    });
    child.stdin.end(options.input ?? "");
  });
}
