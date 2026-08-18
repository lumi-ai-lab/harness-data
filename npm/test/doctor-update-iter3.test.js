import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDoctor } from "../src/commands/doctor.js";

function createDoctorRuntime(blobFile, mode = 0o600, allowLocalBlob = true) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-iter3-"));
  for (const dir of ["bin", "config", "bootstrap", "agents", "wikis/metrics", "wikis/reports", "wikis/dims", "wikis/rules"]) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "# Wikis\n");
  fs.writeFileSync(path.join(workspace, "config", "harness-config.yaml"), [
    "authz:",
    "  mode: on",
    `  blob_file: ${blobFile}`,
    `  allow_local_blob: ${allowLocalBlob ? "true" : "false"}`,
    "",
  ].join("\n"));
  const blob = path.isAbsolute(blobFile) ? blobFile : path.join(workspace, blobFile);
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.writeFileSync(blob, "qdm1enc.iter3-secret\n", { mode });
  fs.chmodSync(blob, mode);
  const cli = path.join(workspace, "bin", "qdm-metric-cli");
  fs.writeFileSync(cli, [
    "#!/bin/sh",
    'if [ "$1" = version ]; then echo "qdm-metric-cli 0.1.10"; exit 0; fi',
    'if [ "$1" = auth ] && [ "$4" = qdm1enc.iter3-secret ]; then exit 0; fi',
    'if [ "$1" = auth ]; then exit 77; fi',
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.chmodSync(cli, 0o755);
  fs.writeFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), `export QDM_METRIC_CLI="${cli}"\n`);
  return workspace;
}

test("doctor supports a historical absolute blob_file", async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-iter3-legacy-"));
  const workspace = createDoctorRuntime(path.join(legacyDir, "legacy-auth.blob"));
  const report = await collectDoctor(workspace, { env: {} });
  const checks = new Map(report.checks.map((check) => [check.name, check]));
  assert.equal(checks.get("auth Blob regular non-link")?.ok, true);
  assert.equal(checks.get("auth Blob POSIX mode <=0600")?.ok, true);
  assert.equal(checks.get("qdm auth describe with Blob")?.ok, true);
});

test("doctor rejects group-readable Blob permissions", async () => {
  const workspace = createDoctorRuntime("config/dev-auth.blob", 0o040);
  const report = await collectDoctor(workspace, { env: {} });
  const checks = new Map(report.checks.map((check) => [check.name, check]));
  assert.equal(checks.get("auth Blob regular non-link")?.ok, true);
  assert.equal(checks.get("auth Blob POSIX mode <=0600")?.ok, false);
  assert.equal(checks.get("auth Blob safe read")?.ok, false);
  assert.equal(checks.get("qdm auth describe with Blob")?.ok, false);
});

test("doctor keeps allow_local_blob=false valid when a local probe Blob exists", async () => {
  const workspace = createDoctorRuntime("config/dev-auth.blob", 0o400, false);
  const report = await collectDoctor(workspace, { env: {} });
  const checks = new Map(report.checks.map((check) => [check.name, check]));
  assert.equal(checks.get("authz allow_local_blob")?.ok, true);
  assert.equal(checks.get("auth Blob POSIX mode <=0600")?.ok, true);
  assert.equal(checks.get("qdm auth describe without credentials")?.ok, true);
  assert.equal(checks.get("qdm auth describe with Blob")?.ok, true);
});
