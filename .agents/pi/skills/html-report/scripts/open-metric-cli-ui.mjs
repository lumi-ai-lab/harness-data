#!/usr/bin/env node
export * from "../../../../../packages/harness-runtime-node/src/open-metric-cli-ui.mjs";
import { bindCliScriptPath, runCli } from "../../../../../packages/harness-runtime-node/src/open-metric-cli-ui.mjs";
import { fileURLToPath } from "node:url";
bindCliScriptPath(fileURLToPath(import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
