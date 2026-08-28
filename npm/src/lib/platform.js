import fs from "node:fs";
import path from "node:path";

export function platformKey(platform = process.platform, architecture = process.arch) {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : platform;
  const arch = architecture === "x64" ? "amd64" : architecture;
  const key = `${os}-${arch}`;
  if (!["darwin-arm64", "linux-amd64", "windows-amd64", "windows-arm64"].includes(key)) {
    throw new Error(`unsupported platform: ${key}`);
  }
  return key;
}

export function binaryName(name) {
  if (name === "data-harness-cli") return name;
  return process.platform === "win32" ? `${name}.exe` : name;
}

export function harnessCliMain(runtimeDir) {
  return path.join(runtimeDir, "packages", "data-harness-cli", "src", "main.js");
}

export function isHarnessCliPresent(runtimeDir) {
  const main = harnessCliMain(runtimeDir);
  const posix = path.join(runtimeDir, "bin", "data-harness-cli");
  const cmd = path.join(runtimeDir, "bin", "data-harness-cli.cmd");
  if (fs.existsSync(main)) return true;
  if (process.platform === "win32") return fs.existsSync(cmd) || fs.existsSync(posix);
  try {
    fs.accessSync(posix, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function ensureHarnessCli(runtimeDir) {
  const main = harnessCliMain(runtimeDir);
  if (!fs.existsSync(main)) {
    throw new Error("runtime missing packages/data-harness-cli/src/main.js");
  }
  const binDir = path.join(runtimeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const posix = path.join(binDir, "data-harness-cli");
  fs.writeFileSync(
    posix,
    "#!/usr/bin/env node\n\nimport { main } from \"../packages/data-harness-cli/src/main.js\";\n\nawait main();\n",
  );
  if (process.platform !== "win32") fs.chmodSync(posix, 0o755);
  fs.writeFileSync(
    path.join(binDir, "data-harness-cli.cmd"),
    "@echo off\nnode \"%~dp0..\\packages\\data-harness-cli\\src\\main.js\" %*\n",
  );
}

/**
 * Check whether a file is executable.
 * On Windows, X_OK is unreliable — just check existence (the .exe extension
 * from binaryName() is what makes a binary runnable, not the executable bit).
 * On POSIX, use the standard X_OK access check.
 */
export function isExecutable(file) {
  try {
    if (process.platform === "win32") {
      fs.accessSync(file, fs.constants.F_OK);
    } else {
      fs.accessSync(file, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
