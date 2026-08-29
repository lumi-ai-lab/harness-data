#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv).catch((error) => {
  const message = error?.code && !String(error?.message || "").startsWith(`${error.code}:`)
    ? `${error.code}: ${error.message || String(error)}`
    : (error?.message || String(error));
  console.error(message);
  process.exitCode = 1;
});
