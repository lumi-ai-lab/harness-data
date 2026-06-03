#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv).catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
