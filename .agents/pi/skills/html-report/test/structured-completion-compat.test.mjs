import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const packagesRoot = join(projectRoot, ".harness", "compat-matrix", "packages");

const versions = [
  ["0.35.1", "file-only"],
  ["0.36.0", "tool-event"],
  ["0.40.0", "tool-event"],
  ["0.41.0", "tool-event"],
  ["0.50.0", "tool-event"],
];

function executionSource(version) {
  return join(
    packagesRoot,
    `subagents-${version}`,
    "node_modules",
    "pi-subagents",
    "src",
    "runs",
    "foreground",
    "execution.ts",
  );
}

test("installed pi-subagents packages keep the official structured completion contract", (t) => {
  const present = versions.filter(([version]) => existsSync(executionSource(version)));
  if (present.length === 0) {
    t.skip("compat-matrix packages are not installed");
    return;
  }

  for (const [version, mode] of present) {
    const source = readFileSync(executionSource(version), "utf8");
    assert.match(source, /readStructuredOutput/, `${version} must revalidate output.json`);
    if (mode === "file-only") {
      assert.doesNotMatch(
        source,
        /structuredOutputToolInvoked/,
        `${version} should accept a valid output.json without a tool event`,
      );
      continue;
    }
    assert.match(
      source,
      /structuredOutputToolInvoked/,
      `${version} requires a real structured_output tool event`,
    );
    assert.match(
      source,
      /MISSING_STRUCTURED_OUTPUT_CALL_ERROR/,
      `${version} must fail closed when the official tool was not invoked`,
    );
  }
});
