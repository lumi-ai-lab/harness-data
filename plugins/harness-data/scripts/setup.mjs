#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupEnvironment } from "./context-store.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(`Usage: node scripts/setup.mjs [options]\n\n` +
    `  --data-root PATH       External state root (default: CODEX_HOME/qdm-harness/data)\n` +
    `  --resource-root PATH   Legacy non-Codex resource root override (Codex uses the Plugin)\n` +
    `  --secret-root PATH     Legacy non-Codex secret root (Codex uses <plugin>/secrets)\n` +
    `  --secret-ref VALUE     Existing auth.blob file reference\n` +
    `  --auth-blob BLOB       Auth blob content (prefer --auth-blob-file)\n` +
    `  --auth-blob-file PATH  Auth blob file to copy into the Plugin\n` +
    `  --auth-user-id ID      Authorization user identifier\n` +
    `  --workspace-allowlist PATH  Project directory to enable (not the plugin cache; repeatable; created if missing)\n` +
    `  --enable-workspace PATH     Alias of --workspace-allowlist\n` +
    `  --gitee-token TOKEN    Private Gitee Release token\n` +
    `  --github-token TOKEN   Private GitHub Release token\n` +
    `  --release-archive-password VALUE  Encrypted ZIP password\n` +
    `  --no-auth              Explicitly configure authz off\n` +
    `  --metric-cli PATH      Existing qdm-metric-cli executable\n` +
    `  --wikis-source PATH    Local wikis directory copied into the Plugin\n` +
    `  --json                 Print JSON report\n`);
  process.exit(0);
}

Object.assign(process.env, setupEnvironment({ pluginRoot }));
delete process.env.HARNESS_CONTEXT_FILE;
const { main } = await import("../dist/harness-data-installer/src/cli.js");
try {
  await main([
    process.execPath,
    fileURLToPath(import.meta.url),
    "setup",
    ...args,
    "--plugin-root",
    pluginRoot,
    "--host",
    "codex",
  ]);
} catch (error) {
  const message = error?.code ? `${error.code}: ${error.message || error}` : String(error?.message || error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
