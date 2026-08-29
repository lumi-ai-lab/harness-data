import assert from "node:assert/strict";
import test from "node:test";

import { verifyNpmArtifact } from "./verify-npm-artifact.mjs";

test("npm artifact has a clean, verifiable package surface", () => {
  const report = verifyNpmArtifact();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.files > 0);
  assert.deepEqual(report.errors, []);
});
