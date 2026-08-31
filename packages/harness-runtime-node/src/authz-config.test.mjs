import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { closeSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAuthBlob } from "./authz-config.mjs";

test("runtime auth resolver returns a canonical file source path", async () => {
  const root = await mkdtemp(join(tmpdir(), "qdm-runtime-auth-"));
  const blobPath = join(root, "auth.blob");
  await writeFile(blobPath, "qdm1enc.runtime\n");
  await chmod(blobPath, 0o600);
  const resolved = resolveAuthBlob({
    projectRoot: root,
    config: { allowLocalBlob: false, devUserId: "runtime-user" },
    secretRef: { kind: "file", path: blobPath },
    env: {},
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sourcePath, realpathSync(blobPath));
  assert.equal(resolved.blob, "qdm1enc.runtime");
});

test("runtime auth resolver rejects unsafe file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "qdm-runtime-auth-"));
  const blobPath = join(root, "auth.blob");
  await writeFile(blobPath, "qdm1enc.runtime\n");
  await chmod(blobPath, 0o644);
  const resolved = resolveAuthBlob({
    projectRoot: root,
    config: { allowLocalBlob: true, devUserId: "runtime-user" },
    secretRef: { kind: "file", path: blobPath },
    env: {},
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /permissions must be 0600/);
});

test("runtime auth resolver accepts an inherited secret file descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "qdm-runtime-auth-"));
  const blobPath = join(root, "auth.blob");
  await writeFile(blobPath, "qdm1enc.fd\n");
  const fd = openSync(blobPath, "r");
  try {
    const resolved = resolveAuthBlob({
      projectRoot: root,
      config: { allowLocalBlob: false, devUserId: "runtime-user" },
      secretRef: { kind: "fd", fd },
      env: {},
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.source, "secret_ref_fd");
    assert.equal(resolved.blob, "qdm1enc.fd");
    assert.equal("sourcePath" in resolved, false);
  } finally {
    closeSync(fd);
  }
});
