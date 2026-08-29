import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { migrateCommand, planMigration } from "../src/commands/migrate.js";
import { binaryName, platformKey } from "../src/lib/platform.js";
import { workspaceIdentity } from "../src/lib/root-context.js";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(npmRoot, "bin", "harness-data.js");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function snapshotTree(root) {
  const entries = [];
  function visit(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = path.join(prefix, name);
      const full = path.join(directory, name);
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) {
        entries.push({ relative, type: "symlink", target: fs.readlinkSync(full) });
      } else if (info.isDirectory()) {
        entries.push({ relative, type: "directory" });
        visit(full, relative);
      } else {
        entries.push({ relative, type: "file", sha256: sha256(fs.readFileSync(full)) });
      }
    }
  }
  visit(root);
  return entries;
}

function write(root, relative, value, options = {}) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, options);
  return target;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += String(value); } },
    stderr: { write(value) { stderr += String(value); } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

function legacyFixture({ auth = true, platform = process.platform } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdm-migrate-"));
  const legacyRoot = path.join(root, "legacy-runtime");
  const dataRoot = path.join(root, "data");
  const secretRoot = path.join(root, "secrets");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  for (const dir of ["agents/codex/hooks", "wikis/metrics", "wikis/reports", "wikis/dims", "wikis/rules", "bin", "config", ".harness/index", ".harness/state/business-report", ".harness/state/html-report/legacy-report"]) {
    fs.mkdirSync(path.join(legacyRoot, dir), { recursive: true });
  }
  write(legacyRoot, "bootstrap/cli-manifest.json", JSON.stringify({
    schemaVersion: 2,
    owner: "lumi-ai-lab",
    tools: [{ name: "qdm-metric-cli", binary: "qdm-metric-cli", platforms: {} }],
  }, null, 2));
  write(legacyRoot, "wikis/index.md", "# Wikis\n");
  for (const dir of ["metrics", "reports", "dims", "rules"]) write(legacyRoot, `wikis/${dir}/sample.md`, `# ${dir}\n`);
  write(legacyRoot, ".harness/index/wikis-index.json", JSON.stringify({ meta: { root: legacyRoot, version: 1 }, docs: [] }));
  write(legacyRoot, ".harness/index/wikis-runtime-index.json", JSON.stringify({ meta: { root: legacyRoot, version: 1 }, docsByPath: {} }));
  write(legacyRoot, ".harness/state/business-report/legacy-session.json", JSON.stringify({ session_id: "legacy-session", reports: {} }));
  write(legacyRoot, ".harness/state/html-report/legacy-report/result.json", JSON.stringify({ status: "confirmed", session_id: "legacy-report", cards: [] }));
  write(legacyRoot, ".harness/state/should-skip.lock", "stale\n");
  write(legacyRoot, ".harness/installer-state.json", JSON.stringify({
    schemaVersion: 4,
    agent: "codex",
    runtimeTag: "v0.0.53",
    wikisTag: "v0.0.53",
    packageVersion: "0.0.53",
    tools: { "qdm-metric-cli": { version: "v-test", sha256: "fixture" } },
  }, null, 2));
  const metricCli = write(legacyRoot, `bin/${binaryName("qdm-metric-cli", platform)}`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (process.platform !== "win32") fs.chmodSync(metricCli, 0o755);
  const legacyHook = write(legacyRoot, "agents/codex/hooks/legacy-hook.sh", "#!/bin/sh\nprintf 'legacy-hook-ok\\n'\n", { mode: 0o755 });
  if (process.platform !== "win32") fs.chmodSync(legacyHook, 0o755);
  if (auth) {
    const blob = write(legacyRoot, "config/dev-auth.blob", "qdm1enc.legacy-secret-material\n", { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(blob, 0o600);
    write(legacyRoot, "config/harness-config.yaml", [
      "paths:",
      "  knowledge: wikis",
      "",
      "authz:",
      "  mode: on",
      "  blob_file: config/dev-auth.blob",
      "  dev_user_id: migration-user",
      "  allow_local_blob: true",
      "",
    ].join("\n"));
  } else {
    write(legacyRoot, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n\nauthz:\n  mode: off\n");
  }
  return { root, legacyRoot, dataRoot, secretRoot, workspaceRoot, metricCli, legacyHook };
}

test("migrate --check is read-only and does not expose the auth blob", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = snapshotTree(f.legacyRoot);
  const io = capture();
  const report = await migrateCommand({
    check: true,
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
    host: "codex",
    json: true,
  }, io);

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.mode, "check");
  assert.equal(report.items.some((item) => item.name === "auth-secret"), true);
  assert.equal(fs.existsSync(f.dataRoot), false);
  assert.equal(fs.existsSync(f.secretRoot), false);
  assert.deepEqual(snapshotTree(f.legacyRoot), before);
  assert.doesNotMatch(io.stdoutText, /legacy-secret-material/);
});

test("migrate copies verified legacy data to roots, preserves source, and is idempotent", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = snapshotTree(f.legacyRoot);
  const io = capture();
  const first = await migrateCommand({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
    host: "codex",
    json: true,
  }, io);

  assert.equal(first.ok, true, io.stdoutText);
  assert.equal(first.migrated, true);
  assert.equal(first.doctor.ok, true);
  const legacyHook = spawnSync(f.legacyHook, { encoding: "utf8" });
  assert.equal(legacyHook.status, 0, legacyHook.stderr);
  assert.equal(legacyHook.stdout, "legacy-hook-ok\n");
  assert.deepEqual(snapshotTree(f.legacyRoot), before);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "plugins")), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "migration.json")), true);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "config", "settings.json")), true);
  const installManifest = JSON.parse(fs.readFileSync(path.join(f.dataRoot, "install-manifest.json"), "utf8"));
  assert.equal(installManifest.resourceVersion, first.source.wikiContentVersion);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "resources", "legacy", first.source.id, "wikis", "index.md")), true);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "resources", "legacy", first.source.id, "index", "wikis-index.json")), true);
  const migratedMetric = path.join(f.dataRoot, "runtimes", platformKey(), first.source.runtimeVersion, binaryName("qdm-metric-cli"));
  assert.equal(fs.existsSync(migratedMetric), true);
  assert.equal(sha256(fs.readFileSync(migratedMetric)), sha256(fs.readFileSync(f.metricCli)));

  const stateRoot = path.join(f.dataRoot, "state", "workspaces", workspaceIdentity({ host: "codex", workspaceRoot: fs.realpathSync.native(f.workspaceRoot), schemaVersion: 1 }));
  assert.equal(fs.existsSync(path.join(stateRoot, "business-report", "legacy-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "html-report", "legacy-report", "result.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "should-skip.lock")), false);
  const legacyReport = JSON.parse(fs.readFileSync(path.join(f.legacyRoot, ".harness/state/html-report/legacy-report/result.json"), "utf8"));
  assert.equal(legacyReport.status, "confirmed");
  const legacyMetric = spawnSync(f.metricCli, { encoding: "utf8" });
  assert.equal(legacyMetric.status, 0, legacyMetric.stderr);

  const secret = first.items.find((item) => item.name === "auth-secret");
  assert.ok(secret, "migration plan must record the secret mapping");
  assert.equal(fs.existsSync(secret.target), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(secret.target).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(secret.target, "utf8"), "qdm1enc.legacy-secret-material\n");
  assert.doesNotMatch(fs.readFileSync(path.join(f.dataRoot, "config", "settings.json"), "utf8"), /legacy-secret-material/);
  assert.doesNotMatch(io.stdoutText, /legacy-secret-material/);
  assert.doesNotMatch(io.stderrText, /legacy-secret-material/);

  const afterFirst = snapshotTree(f.dataRoot);
  const secondIo = capture();
  const second = await migrateCommand({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
    host: "codex",
    json: true,
  }, secondIo);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.migrated, false);
  assert.deepEqual(snapshotTree(f.dataRoot), afterFirst);
  assert.doesNotMatch(secondIo.stdoutText, /legacy-secret-material/);
  assert.doesNotMatch(secondIo.stderrText, /legacy-secret-material/);
});

test("migration fails closed when enabled legacy auth has no explicit secret root", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const plan = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.blockers.some((item) => item.code === "QDM_SECRET_UNAVAILABLE"), true);
  await assert.rejects(
    migrateCommand({ from: f.legacyRoot, to: f.dataRoot, workspaceRoot: f.workspaceRoot }),
    (error) => error?.code === "QDM_SECRET_UNAVAILABLE",
  );
  assert.equal(fs.existsSync(f.dataRoot), false);
});

test("migration rejects an unsupported legacy manifest before writing any target data", async (t) => {
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.legacyRoot, "bootstrap/cli-manifest.json", JSON.stringify({ schemaVersion: 99, tools: [] }));
  const sourceAfterFixtureMutation = snapshotTree(f.legacyRoot);
  const plan = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.blockers.some((item) => /unsupported legacy CLI manifest schema/.test(item.message)), true);
  await assert.rejects(
    migrateCommand({ from: f.legacyRoot, to: f.dataRoot, workspaceRoot: f.workspaceRoot }),
    (error) => error?.code === "QDM_MIGRATION_REQUIRED",
  );
  assert.equal(fs.existsSync(f.dataRoot), false);
  assert.equal(fs.existsSync(f.secretRoot), false);
  assert.deepEqual(snapshotTree(f.legacyRoot), sourceAfterFixtureMutation);
});

test("migration rolls back dataRoot when secret finalization fails", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = snapshotTree(f.legacyRoot);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).includes(".auth.blob.migrate-") && String(to).endsWith(`${path.sep}auth.blob`)) {
      throw new Error("simulated secret finalization failure");
    }
    return originalRename(from, to);
  };
  try {
    await assert.rejects(
      migrateCommand({
        from: f.legacyRoot,
        to: f.dataRoot,
        secretRoot: f.secretRoot,
        workspaceRoot: f.workspaceRoot,
      }),
      /simulated secret finalization failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.existsSync(f.dataRoot), false);
  const legacyHook = spawnSync(f.legacyHook, { encoding: "utf8" });
  assert.equal(legacyHook.status, 0, legacyHook.stderr);
  assert.equal(legacyHook.stdout, "legacy-hook-ok\n");
  const profilesRoot = path.join(f.secretRoot, "profiles");
  const hasCommittedSecret = fs.existsSync(profilesRoot) && fs.readdirSync(profilesRoot)
    .some((name) => fs.existsSync(path.join(profilesRoot, name, "auth.blob")));
  assert.equal(hasCommittedSecret, false);
  assert.deepEqual(snapshotTree(f.legacyRoot), before);
});

test("CLI exposes migrate --check with a machine-readable report", (t) => {
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    cli,
    "migrate",
    "--check",
    "--from", f.legacyRoot,
    "--to", f.dataRoot,
    "--workspace-root", f.workspaceRoot,
    "--json",
  ], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "check");
  assert.equal(report.ok, true);
});

test("source-only migrate --check reports required roots without guessing them", async (t) => {
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const report = await migrateCommand({ check: true, from: f.legacyRoot }, capture());
  assert.equal(report.ok, false);
  assert.equal(report.ready, false);
  assert.equal(report.sourceValid, true);
  assert.equal(report.target.dataRoot, "");
  assert.equal(report.target.workspaceRoot, "");
  assert.equal(report.warnings.some((item) => item.includes("--to <data-root>")), true);
  assert.equal(report.warnings.some((item) => item.includes("--workspace-root")), true);
});

test("migration rejects a legacy source with a symbolic-link directory component", async (t) => {
  if (process.platform === "win32") return t.skip("directory symlink setup is platform-dependent");
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside-config");
  fs.renameSync(path.join(f.legacyRoot, "config"), outside);
  fs.symlinkSync(outside, path.join(f.legacyRoot, "config"), "dir");

  const plan = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.sourceValid, false);
  assert.match(plan.blockers[0].message, /symbolic link/);
  assert.equal(fs.existsSync(f.dataRoot), false);
});

test("migration rejects secretRoot symbolic links without writing the auth blob outside secretRoot", async (t) => {
  if (process.platform === "win32") return t.skip("directory symlink setup is platform-dependent");
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside-secrets");
  fs.mkdirSync(f.secretRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(f.secretRoot, "profiles"), "dir");

  await assert.rejects(
    migrateCommand({
      from: f.legacyRoot,
      to: f.dataRoot,
      secretRoot: f.secretRoot,
      workspaceRoot: f.workspaceRoot,
    }),
    (error) => error?.code === "QDM_SECRET_UNAVAILABLE",
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(f.dataRoot), false);
});

test("completed migration blocks when target records are corrupted", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const first = await migrateCommand({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  }, capture());
  const corrupted = path.join(f.dataRoot, "resources", "legacy", first.source.id, "wikis", "index.md");
  fs.writeFileSync(corrupted, "# corrupted\n");

  const retry = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.idempotent, false);
  assert.equal(retry.blockers.some((entry) => entry.code === "QDM_MIGRATION_REQUIRED"), true);
  await assert.rejects(
    migrateCommand({
      from: f.legacyRoot,
      to: f.dataRoot,
      secretRoot: f.secretRoot,
      workspaceRoot: f.workspaceRoot,
    }),
    (error) => error?.code === "QDM_MIGRATION_REQUIRED",
  );
  assert.equal(fs.readFileSync(corrupted, "utf8"), "# corrupted\n");
});

test("completed migration blocks when legacy source content changes", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const first = await migrateCommand({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  }, capture());
  fs.writeFileSync(path.join(f.legacyRoot, "wikis", "index.md"), "# updated legacy wiki\n");

  const retry = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.idempotent, false);
  assert.notEqual(retry.source.id, first.source.id);
  assert.equal(retry.blockers.some((entry) => entry.code === "QDM_MIGRATION_REQUIRED"), true);
});

test("rollback failure preserves the secret and leaves an explicit recovery marker", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalRename = fs.renameSync;
  let secretFinalized = false;
  let postSecretRenameCount = 0;
  fs.renameSync = (from, to) => {
    if (String(from).includes(".auth.blob.migrate-") && String(to).endsWith(path.sep + "auth.blob")) {
      secretFinalized = true;
      originalRename(from, to);
      throw new Error("simulated failure after secret finalization");
    }
    if (secretFinalized && postSecretRenameCount++ === 0) {
      throw new Error("simulated data rollback failure");
    }
    return originalRename(from, to);
  };
  try {
    await assert.rejects(
      migrateCommand({
        from: f.legacyRoot,
        to: f.dataRoot,
        secretRoot: f.secretRoot,
        workspaceRoot: f.workspaceRoot,
      }),
      (error) => error?.code === "QDM_MIGRATION_ROLLBACK_FAILED",
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.existsSync(path.join(f.dataRoot, "migration-incomplete.json")), true);
  const profileNames = fs.readdirSync(path.join(f.secretRoot, "profiles"));
  assert.equal(profileNames.some((name) => fs.existsSync(path.join(f.secretRoot, "profiles", name, "auth.blob"))), true);
  const retry = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.idempotent, false);
});

test("migration rejects a symbolic-link dataRoot before it can redirect writes", (t) => {
  if (process.platform === "win32") return t.skip("directory symlink setup is platform-dependent");
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside-data");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, f.dataRoot, "dir");

  const plan = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.blockers.some((entry) => entry.code === "QDM_CONTEXT_INVALID"), true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("migration requires a new non-existent dataRoot", (t) => {
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.dataRoot, { recursive: true });

  const plan = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.sourceValid, true);
  assert.equal(plan.blockers.some((entry) => entry.code === "QDM_DATA_ROOT_UNAVAILABLE"), true);
});

test("migration validates an explicit pluginRoot before writing target data", (t) => {
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const pluginRoot = path.join(f.root, "incomplete-plugin");
  fs.mkdirSync(pluginRoot, { recursive: true });

  const plan = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
    pluginRoot,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.blockers.some((entry) => entry.code === "QDM_MIGRATION_REQUIRED"), true);
  assert.equal(fs.existsSync(f.dataRoot), false);
});

test("completed migration blocks when a target and its migration record are tampered together", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const first = await migrateCommand({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  }, capture());
  const metric = first.items.find((entry) => entry.name === "metric-cli");
  const pointerPath = path.join(f.dataRoot, "migration.json");
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  const recordPath = path.join(f.dataRoot, pointer.manifest);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const replacement = "#!/bin/sh\necho tampered\n";
  fs.writeFileSync(metric.target, replacement, { mode: 0o755 });
  const recordMetric = record.records.find((entry) => entry.name === "metric-cli");
  recordMetric.sha256 = sha256(Buffer.from(replacement));
  recordMetric.bytes = Buffer.byteLength(replacement);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");

  const retry = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.idempotent, false);
  assert.match(retry.blockers[0].message, /source hash changed/);
});

test("completed migration requires its canonical record path", async (t) => {
  const f = legacyFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await migrateCommand({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  }, capture());
  const pointerPath = path.join(f.dataRoot, "migration.json");
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  const alternate = "migrations/not-the-source-id.json";
  fs.copyFileSync(path.join(f.dataRoot, pointer.manifest), path.join(f.dataRoot, alternate));
  pointer.manifest = alternate;
  fs.writeFileSync(pointerPath, JSON.stringify(pointer, null, 2) + "\n");

  const retry = planMigration({
    from: f.legacyRoot,
    to: f.dataRoot,
    secretRoot: f.secretRoot,
    workspaceRoot: f.workspaceRoot,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.idempotent, false);
  assert.match(retry.blockers[0].message, /canonical migration record/);
});

test("migration fails closed when the dataRoot parent is not writable", async (t) => {
  const f = legacyFixture({ auth: false });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalAccess = fs.accessSync;
  const dataParent = fs.realpathSync.native(f.root);
  fs.accessSync = (candidate, mode) => {
    if (path.resolve(String(candidate)) === dataParent && mode === fs.constants.W_OK) {
      const error = new Error("simulated permission denied");
      error.code = "EACCES";
      throw error;
    }
    return originalAccess(candidate, mode);
  };
  try {
    await assert.rejects(
      migrateCommand({
        from: f.legacyRoot,
        to: f.dataRoot,
        workspaceRoot: f.workspaceRoot,
      }, capture()),
      (error) => error?.code === "QDM_DATA_ROOT_UNAVAILABLE",
    );
  } finally {
    fs.accessSync = originalAccess;
  }
  assert.equal(fs.existsSync(f.dataRoot), false);
});

test("migration fixture covers supported platform runtime names and versioned targets", async (t) => {
  const cases = [
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["win32", "x64"],
    ["win32", "arm64"],
  ];
  const fixtures = [];
  t.after(() => {
    for (const f of fixtures) fs.rmSync(f.root, { recursive: true, force: true });
  });
  for (const [platform, architecture] of cases) {
    const f = legacyFixture({ auth: false, platform });
    fixtures.push(f);
    const report = await migrateCommand({
      from: f.legacyRoot,
      to: f.dataRoot,
      workspaceRoot: f.workspaceRoot,
      platform,
      architecture,
    }, capture());
    const expectedPlatform = platformKey(platform, architecture);
    const metric = path.join(
      f.dataRoot,
      "runtimes",
      expectedPlatform,
      report.source.runtimeVersion,
      binaryName("qdm-metric-cli", platform),
    );
    assert.equal(report.ok, true, `${platform}/${architecture}`);
    assert.equal(report.target.platform, expectedPlatform);
    assert.equal(fs.existsSync(metric), true, metric);
  }
});
