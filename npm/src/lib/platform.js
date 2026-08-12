export function platformKey() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const key = `${os}-${arch}`;
  if (!["darwin-arm64", "darwin-amd64", "linux-amd64", "windows-amd64"].includes(key)) {
    throw new Error(`unsupported platform: ${key}`);
  }
  return key;
}

export function binaryName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}
