import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { AUTHZ_BINDING_ENV, registerAuthzBashOverride } from "../authz-bash.mjs";
import { AuthorizationStateStore, encodeBindingBase64url } from "../authz-state.mjs";

const runtimeModule = process.env.QDM_PI_RUNTIME_MODULE?.trim();

function runtimeUrl(value) {
  if (value.startsWith("file:")) return value;
  return pathToFileURL(isAbsolute(value) ? value : resolve(value)).href;
}

function candidate() {
  const binding = {
    version: 1,
    sessionId: "runtime-session",
    requestId: "runtime-request",
    envelopeSha256: "a".repeat(64),
    expiresAt: "2099-07-30T01:30:00Z",
  };
  return {
    binding,
    bindingBase64url: encodeBindingBase64url(binding),
    contextFingerprint: "c".repeat(64),
    summary: "Requester: runtime-smoke",
  };
}

test(
  "Pi 0.83.0 runtime smoke: real createBashTool preserves binding and sanitizes CLI environment",
  { skip: runtimeModule ? false : "set QDM_PI_RUNTIME_MODULE to Pi 0.83.0 dist/index.js" },
  async (t) => {
    const runtime = await import(runtimeUrl(runtimeModule));
    assert.equal(runtime.VERSION, "0.83.0");
    assert.equal(typeof runtime.createBashTool, "function");

    const cwd = mkdtempSync(join(tmpdir(), "qdm-pi-runtime-smoke-"));
    mkdirSync(cwd, { recursive: true });
    t.after(() => rmSync(cwd, { force: true, recursive: true }));

    const stateStore = new AuthorizationStateStore();
    const bound = candidate();
    stateStore.apply("runtime-session", bound);
    const poisonedEnvironment = {
      QDM_METRIC_CLI: "/tmp/raw-qdm-metric-cli",
      QDM_CMR_CLI: "/tmp/qdm-cmr-cli",
      QDM_SQL_CLI: "/tmp/qdm-sql-cli",
      QDM_CAS_CLI: "/tmp/cas-cli",
      QDM_CAS_CONFIG_DIR: "/tmp/cas-config",
    };
    const previousEnvironment = new Map(
      Object.keys(poisonedEnvironment).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(poisonedEnvironment)) process.env[name] = value;
    t.after(() => {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    let bashTool;
    registerAuthzBashOverride(
      {
        registerTool(tool) {
          bashTool = tool;
        },
      },
      { createBashTool: runtime.createBashTool, cwd, projectRoot: cwd, stateStore },
    );

    stateStore.bindToolCall("runtime-tool", stateStore.snapshotSession("runtime-session"));
    const command = [
      `printf 'direct:%s\\n' "$${AUTHZ_BINDING_ENV}"`,
      `(printf 'subshell:%s\\n' "$${AUTHZ_BINDING_ENV}")`,
      `printf 'pipeline:%s\\n' "$${AUTHZ_BINDING_ENV}" | cat`,
      `(printf 'background:%s\\n' "$${AUTHZ_BINDING_ENV}") & wait`,
      `printf 'metric-cli:%s\\n' "$QDM_METRIC_CLI"`,
      `printf 'cmr:<%s>\\n' "\${QDM_CMR_CLI-unset}"`,
      `printf 'sql:<%s>\\n' "\${QDM_SQL_CLI-unset}"`,
      `printf 'cas:<%s>\\n' "\${QDM_CAS_CLI-unset}"`,
      `printf 'cas-config:<%s>\\n' "\${QDM_CAS_CONFIG_DIR-unset}"`,
    ].join("; ");
    const result = await bashTool.execute("runtime-tool", { command });
    const output = result.content[0].text;
    for (const label of ["direct", "subshell", "pipeline", "background"]) {
      assert.match(output, new RegExp(`${label}:${bound.bindingBase64url}`));
    }
    assert.match(output, new RegExp(`metric-cli:${join(cwd, "bin", "qdm-metric-cli")}`));
    for (const label of ["cmr", "sql", "cas", "cas-config"]) {
      assert.match(output, new RegExp(`${label}:<unset>`));
    }

    const previous = process.env[AUTHZ_BINDING_ENV];
    process.env[AUTHZ_BINDING_ENV] = "stale-parent-binding";
    try {
      stateStore.bindToolCall("runtime-unbound", stateStore.snapshotSession("missing-session"));
      const unbound = await bashTool.execute("runtime-unbound", {
        command: `printf '<%s>' "\${${AUTHZ_BINDING_ENV}-unset}"`,
      });
      assert.match(unbound.content[0].text, /<unset>/);
    } finally {
      if (previous === undefined) delete process.env[AUTHZ_BINDING_ENV];
      else process.env[AUTHZ_BINDING_ENV] = previous;
    }

    stateStore.bindToolCall("runtime-exit", stateStore.snapshotSession("runtime-session"));
    await assert.rejects(
      () => bashTool.execute("runtime-exit", { command: "printf preserved-output; exit 7" }),
      (error) => {
        assert.match(error.message, /preserved-output/);
        assert.match(error.message, /Command exited with code 7/);
        return true;
      },
    );
  },
);
