/**
 * cli-shim.mjs — Codex hook entry that launches data-harness-cli
 * without going through a Windows shell (PowerShell/CMD).
 *
 * Prefer the JS CLI via the current Node executable. Fall back to a
 * workspace bin wrapper when the package is not present (tests / older runtimes).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(__dirname, "..", "..", "..");
const main = join(runtimeRoot, "packages", "data-harness-cli", "src", "main.js");
const args = process.argv.slice(2);

const result = existsSync(main)
  ? spawnSync(process.execPath, [main, ...args], { stdio: "inherit", shell: false, windowsHide: true })
  : spawnSync(
      join(runtimeRoot, "bin", process.platform === "win32" ? "data-harness-cli.exe" : "data-harness-cli"),
      args,
      { stdio: "inherit", shell: false, windowsHide: true },
    );

process.exit(result.status ?? 1);
