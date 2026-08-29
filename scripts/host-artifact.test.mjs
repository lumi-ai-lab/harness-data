import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHostArtifacts, selfTestHostArtifacts, verifyHostArtifacts } from "./host-artifact.mjs";
import { HOST_ARTIFACT_HOSTS, hostArtifactKind } from "./host-artifact-contract.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

test("host artifact matrix builds, verifies, and self-tests every supported host", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdm-host-artifacts-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "artifacts");

  const built = buildHostArtifacts({
    host: "all",
    outputDir,
    version: "0.0.54-test",
  });
  assert.deepEqual(built.map((item) => item.host), HOST_ARTIFACT_HOSTS);
  assert.equal(built.every((item) => item.verification.errors.length === 0), true);
  assert.equal(built.every((item) => item.selfTest?.host === item.host), true);

  const verified = verifyHostArtifacts({ host: "all", artifactRoot: outputDir });
  assert.equal(verified.length, HOST_ARTIFACT_HOSTS.length);
  const selfTested = selfTestHostArtifacts({ host: "all", artifactRoot: outputDir });
  assert.deepEqual(selfTested.map((item) => item.host), HOST_ARTIFACT_HOSTS);

  for (const host of HOST_ARTIFACT_HOSTS) {
    const report = verifyArtifact(path.join(outputDir, host), { kind: hostArtifactKind(host) });
    assert.deepEqual(report.errors, [], host);
  }
});
