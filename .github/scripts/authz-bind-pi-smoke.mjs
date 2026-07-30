#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseAuthzBindOutput } from "../../.agents/pi/extensions/qdm-harness/authz-state.mjs";

const cli = path.resolve(process.argv[2] || "");
if (!cli || !fs.existsSync(cli)) throw new Error("usage: authz-bind-pi-smoke.mjs /absolute/path/to/data-harness-cli");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-authz-bind-pi-")));
try {
  const contextDir = path.join(root, "requester-context");
  const controlDir = path.join(root, "control");
  const privateDir = path.join(root, "private");
  const secretsDir = path.join(root, "secrets");
  for (const directory of [contextDir, controlDir, privateDir, secretsDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  const now = Date.now();
  // ACP session IDs are opaque. The leading/trailing spaces deliberately
  // prove that neither the Go helper nor the Pi parser normalizes them.
  const sessionId = " 会话-<&-\u2028-\"-\\-session ";
  const requestId = "请求-<&-\u2028-\"-\\-request";
  const envelope = {
    version: 1,
    workspaceId: "workspace-smoke",
    agentId: "agent-smoke",
    sessionId,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    requesterContext: {
      version: 1,
      requestId,
      policyRevision: `sha256:${"a".repeat(64)}`,
      principal: {
        channel: "wecom",
        botId: "bot-smoke",
        canonicalUserId: "user-smoke",
        displayName: "测试用户"
      },
      audience: { chatId: "chat-smoke", chatType: "group" },
      authorization: {
        capabilities: ["qdm.indicators.query"],
        scope: { manageAreaIds: ["CN07"], categoryLevel1Ids: ["12"] }
      }
    }
  };
  const sessionName = `${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`;
  fs.writeFileSync(path.join(contextDir, sessionName), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

  const controlPath = path.join(controlDir, "authz-state.json");
  fs.writeFileSync(controlPath, `${JSON.stringify({
    version: 1,
    generation: 1,
    state: "enabled",
    updatedAt: new Date(now - 30_000).toISOString()
  })}\n`, { mode: 0o600 });

  const configPath = path.join(root, "authz.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    mode: "lumi-mvp-required",
    piVersion: "0.81.1",
    requesterContextDir: contextDir,
    maxEnvelopeBytes: 65536,
    maxEnvelopeTtlSeconds: 1800,
    clockSkewSeconds: 30,
    realIndicatorsCli: {
      path: path.join(privateDir, "qdm-indicators-cli-v0.0.4"),
      version: "0.0.4",
      artifactSha256: "b".repeat(64),
      configDir: secretsDir
    },
    approvedIndicatorCatalog: {
      path: path.join(root, "approved-indicators-v1.json"),
      sha256: "c".repeat(64)
    },
    killSwitch: { controlPath, pollMilliseconds: 1000 },
    limits: {
      maxDateRangeDays: 31,
      maxIndicators: 10,
      maxDimensions: 10,
      defaultPageSize: 200,
      maxPageSize: 1000,
      defaultMetadataLimit: 100,
      maxMetadataLimit: 500,
      timeoutSeconds: 120,
      maxOutputBytes: 2097152
    }
  })}\n`, { mode: 0o600 });

  const result = spawnSync(cli, ["authz-bind", "--session-id", sessionId, "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = parseAuthzBindOutput(result.stdout, sessionId, { nowMs: now });
  assert.equal(parsed.binding.sessionId, sessionId);
  assert.equal(parsed.binding.requestId, requestId);
  assert.match(parsed.summary, /Authorized manageAreaIds: CN07/);
  assert.match(parsed.summary, /Authorized categoryLevel1Ids: 12/);
  process.stdout.write("authz-bind -> Pi parser cross-language smoke passed\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
