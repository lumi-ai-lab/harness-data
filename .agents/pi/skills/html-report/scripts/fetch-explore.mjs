#!/usr/bin/env node
export * from "../../../../../packages/html-report-kernel/src/data/fetch-explore.mjs";
import { runCli } from "../../../../../packages/html-report-kernel/src/data/fetch-explore.mjs";
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
