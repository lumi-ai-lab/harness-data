import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BLOB_SOURCE_ENV,
  BLOB_SOURCE_ENV_FILE,
  BLOB_SOURCE_FILE,
  resolveAuthBlob,
} from "../src/lib/authz/auth-blob.js";
import { ENV_AUTH_BLOB, ENV_AUTH_BLOB_FILE, ENV_AUTH_USER_ID } from "../src/lib/authz/constants.js";

const testBlob = "qdm1enc.testblob";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "auth-blob-"));
}

test("resolveAuthBlob local fallback disabled", () => {
  assert.throws(
    () =>
      resolveAuthBlob({
        projectRoot: tempRoot(),
        config: { allowLocalBlob: false },
        env: { [ENV_AUTH_BLOB]: testBlob, [ENV_AUTH_USER_ID]: "local-user" },
      }),
    /local blob fallback is disabled/,
  );
});

test("resolveAuthBlob reads env blob", () => {
  const resolved = resolveAuthBlob({
    projectRoot: tempRoot(),
    config: {},
    env: { [ENV_AUTH_BLOB]: testBlob, [ENV_AUTH_USER_ID]: "env-user" },
  });
  assert.equal(resolved.source, BLOB_SOURCE_ENV);
  assert.equal(resolved.blob, testBlob);
  assert.equal(resolved.userId, "env-user");
});

test("resolveAuthBlob reads env blob file", () => {
  const root = tempRoot();
  const blobPath = path.join(root, "admin-auth.blob");
  writeFileSync(blobPath, `${testBlob}\n`, { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  const resolved = resolveAuthBlob({
    projectRoot: root,
    config: {},
    env: { [ENV_AUTH_BLOB_FILE]: blobPath, [ENV_AUTH_USER_ID]: "env-user" },
  });
  assert.equal(resolved.source, BLOB_SOURCE_ENV_FILE);
  assert.equal(resolved.blob, testBlob);
  assert.equal(resolved.userId, "env-user");
});

test("resolveAuthBlob reads configured file", () => {
  const root = tempRoot();
  mkdirSync(path.join(root, "config"), { recursive: true });
  const blobPath = path.join(root, "config", "dev-auth.blob");
  writeFileSync(blobPath, `${testBlob}\n`, { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  const resolved = resolveAuthBlob({
    projectRoot: root,
    config: { blobFile: "config/dev-auth.blob", devUserId: "local-user" },
    env: {},
  });
  assert.equal(resolved.source, BLOB_SOURCE_FILE);
  assert.equal(resolved.blob, testBlob);
  assert.equal(resolved.userId, "local-user");
});

test("resolveAuthBlob env blob prioritized over config file", () => {
  const root = tempRoot();
  mkdirSync(path.join(root, "config"), { recursive: true });
  const blobPath = path.join(root, "config", "dev-auth.blob");
  writeFileSync(blobPath, "qdm1enc.fileblob\n", { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  const resolved = resolveAuthBlob({
    projectRoot: root,
    config: { blobFile: "config/dev-auth.blob", devUserId: "file-user" },
    env: { [ENV_AUTH_BLOB]: testBlob, [ENV_AUTH_USER_ID]: "env-user" },
  });
  assert.equal(resolved.source, BLOB_SOURCE_ENV);
  assert.equal(resolved.blob, testBlob);
  assert.equal(resolved.userId, "env-user");
});

test("resolveAuthBlob no blob available", () => {
  assert.throws(
    () => resolveAuthBlob({ projectRoot: tempRoot(), config: {}, env: {} }),
    /no encrypted blob is available/,
  );
});

test("resolveAuthBlob rejects group readable file", { skip: process.platform === "win32" }, () => {
  const root = tempRoot();
  const blobPath = path.join(root, "admin-auth.blob");
  writeFileSync(blobPath, `${testBlob}\n`, { mode: 0o644 });
  chmodSync(blobPath, 0o644);
  assert.throws(
    () =>
      resolveAuthBlob({
        projectRoot: root,
        config: {},
        env: { [ENV_AUTH_BLOB_FILE]: blobPath, [ENV_AUTH_USER_ID]: "env-user" },
      }),
    /permissions must be 0600/,
  );
});
