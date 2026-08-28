#!/usr/bin/env node
export * from "../../../../../packages/harness-runtime-node/src/open-metric-cli-ui.mjs";
import { bindCliScriptPath, runCli } from "../../../../../packages/harness-runtime-node/src/open-metric-cli-ui.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const cliScriptPath = fileURLToPath(import.meta.url);
bindCliScriptPath(cliScriptPath);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(cliScriptPath)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
