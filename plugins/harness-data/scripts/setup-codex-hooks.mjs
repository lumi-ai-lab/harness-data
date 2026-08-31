#!/usr/bin/env node
/**
 * Compatibility entrypoint. Codex discovers hooks/hooks.json from the plugin;
 * runtime initialization is owned by scripts/setup.mjs.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "setup.mjs");
if (process.argv.slice(2).some((arg) => arg === "--remove" || arg === "-r")) {
  process.stdout.write("QDM hooks are managed by the Codex plugin lifecycle; no global hooks.json entry was removed.\n");
  process.exit(0);
}
process.stderr.write("setup-codex-hooks.mjs is deprecated; delegating to scripts/setup.mjs.\n");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
