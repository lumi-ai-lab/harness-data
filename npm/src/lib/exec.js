import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

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

async function isExecutableFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    // Windows has no execute bit; an existing file in PATH is treated as runnable.
    return process.platform === "win32" || (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function commandExists(command) {
  if (!command) return false;
  const hasSeparator = command.includes("/") || (path.sep !== "/" && command.includes(path.sep));
  if (hasSeparator) return isExecutableFile(path.resolve(command));
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of extensions) {
      // An empty PATH segment means the current directory, same as the shell.
      if (await isExecutableFile(path.join(dir || ".", command + ext))) return true;
    }
  }
  return false;
}
