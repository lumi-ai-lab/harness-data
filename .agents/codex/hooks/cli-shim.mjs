/**
 * cli-shim.mjs — Codex hook entry point that directly spawns data-harness-cli
 * without going through any Windows shell (PowerShell/CMD).
 *
 * Codex hooks pass a command string through the host shell. On Windows,
 * quoting rules differ across shells and break bash-style commands. This
 * shim is invoked as `node "cli-shim.mjs" <args>` — `node` is a bare
 * executable name that all shells recognize — and uses spawnSync with
 * shell:false to launch the Go CLI binary directly via CreateProcess.
 *
 * The shim is cross-platform but only referenced on Windows (non-Windows
 * hooks.json keeps the original `bash -c '...'` form).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ext = process.platform === "win32" ? ".exe" : "";
const cliPath = join(__dirname, "..", "..", "..", "bin", `data-harness-cli${ext}`);

const result = spawnSync(cliPath, process.argv.slice(2), {
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

process.exit(result.status ?? 1);
