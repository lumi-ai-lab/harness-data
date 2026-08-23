import fs from "node:fs";

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
  return process.platform === "win32" ? `${name}.exe` : name;
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
