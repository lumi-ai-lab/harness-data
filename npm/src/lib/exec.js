import { spawn } from "node:child_process";

function redactSensitiveValues(value, values) {
  let redacted = value;
  for (const sensitive of values) {
    if (sensitive) redacted = redacted.split(sensitive).join("******");
  }
  return redacted;
}

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", ...(options.env || {}) },
      shell: options.shell || false,
      stdio: options.stdio || "pipe"
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => (stdout += chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) {
        resolve(result);
        return;
      }
      const sensitiveArgs = new Set(options.sensitiveArgs || []);
      const sensitiveValues = args.filter((_, index) => sensitiveArgs.has(index));
      const detail = redactSensitiveValues(stderr.trim() || stdout.trim(), sensitiveValues);
      const displayArgs = args.map((arg, index) => sensitiveArgs.has(index) ? "******" : arg);
      reject(new Error(`${command} ${displayArgs.join(" ")} failed${detail ? `: ${detail}` : ""}`));
    });
  });
}

export async function commandExists(command) {
  const result = await run(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    allowFailure: true
  });
  return result.code === 0;
}
