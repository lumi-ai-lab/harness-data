import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { autoStartHtmlReport, shouldBypassHtmlReportContext } from "./harness-hook.mjs";

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "workbuddy-harness-hook-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("html-report context bypass covers first turn and continuation only", () => {
  const { root, cleanup } = tempRoot();
  try {
    const sessionId = "yuexi-sales-20260824-102503";
    assert.equal(shouldBypassHtmlReportContext(root, {
      session_id: sessionId,
      prompt: "生成粤西区销售情况报告",
    }), true);
    assert.equal(shouldBypassHtmlReportContext(root, {
      session_id: sessionId,
      prompt: "继续",
    }), true);
    assert.equal(shouldBypassHtmlReportContext(root, {
      session_id: sessionId,
      prompt: "销售额最近怎么样？",
    }), false);
    assert.equal(shouldBypassHtmlReportContext(root, {
      session_id: sessionId,
      prompt: "继续",
    }), false, "ordinary prompt clears the html-report continuation marker");
  } finally {
    cleanup();
  }
});

test("html-report context bypass requires a stable session id", () => {
  const { root, cleanup } = tempRoot();
  try {
    assert.equal(shouldBypassHtmlReportContext(root, {
      session_id: "",
      prompt: "生成粤西区销售情况报告",
    }), false);
  } finally {
    cleanup();
  }
});

test("explicit html-report skill prompts bypass context", () => {
  const { root, cleanup } = tempRoot();
  try {
    assert.equal(shouldBypassHtmlReportContext(root, {
      session_id: "skill-session",
      prompt: '<skill name="html-report"></skill> 生成粤西区销售情况报告',
    }), true);
  } finally {
    cleanup();
  }
});

test("html-report hook can disable auto-start for transport-only tests", () => {
  const { root, cleanup } = tempRoot();
  try {
    assert.deepEqual(autoStartHtmlReport(root, "hook-session", "生成销售报告", {
      QDM_HARNESS_HTML_REPORT_AUTOSTART: "0",
    }), { ok: true, skipped: true });
  } finally {
    cleanup();
  }
});

test("html-report hook auto-starts a real Runner session", () => {
  const { root, cleanup } = tempRoot();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "harness-config.yaml"), "paths:\n  knowledge: wikis\n");
    symlinkSync(join(repoRoot, ".agents"), join(root, ".agents"), "dir");
    const result = autoStartHtmlReport(root, "real-hook-session", "生成销售报告", {
      ...process.env,
      CODEBUDDY_PROJECT_DIR: root,
      HTML_REPORT_METRIC_CLI_UI_OPEN: "0",
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.message, /html-report session 已启动/);
    const sessionKey = createHash("sha256").update("workbuddy:real-hook-session").digest("hex");
    assert.equal(existsSync(join(root, ".harness", "state", "html-report", sessionKey, "debug", "pipeline-state.json")), true);
  } finally {
    cleanup();
  }
});

test("WorkBuddy context hook auto-starts once, then handles continuation", () => {
  const { root, cleanup } = tempRoot();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "harness-config.yaml"), "paths:\n  knowledge: wikis\n");
    symlinkSync(join(repoRoot, ".agents"), join(root, ".agents"), "dir");
    const env = {
      ...process.env,
      CODEBUDDY_PROJECT_DIR: root,
      HTML_REPORT_METRIC_CLI_UI_OPEN: "0",
    };
    const hook = fileURLToPath(new URL("./harness-hook.mjs", import.meta.url));
    const first = spawnSync(process.execPath, [hook, "context"], {
      cwd: root,
      env,
      input: JSON.stringify({ session_id: "hook-process-session", prompt: "生成销售报告", cwd: root }),
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /qdm-metric-cli UI/);
    const second = spawnSync(process.execPath, [hook, "context"], {
      cwd: root,
      env,
      input: JSON.stringify({ session_id: "hook-process-session", prompt: "继续", cwd: root }),
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /Stage Runner/);
  } finally {
    cleanup();
  }
});

test("failed html-report auto-start clears the retry marker", () => {
  const { root, cleanup } = tempRoot();
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "harness-config.yaml"), "paths:\n  knowledge: wikis\n");
    const hook = fileURLToPath(new URL("./harness-hook.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [hook, "context"], {
      cwd: root,
      env: { ...process.env, CODEBUDDY_PROJECT_DIR: root },
      input: JSON.stringify({ session_id: "failed-hook-session", prompt: "生成销售报告", cwd: root }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Stage Runner is missing/);
    const digest = createHash("sha256").update("failed-hook-session").digest("hex");
    assert.equal(existsSync(join(root, ".harness", "state", "workbuddy-html-report", `${digest}.json`)), false);
  } finally {
    cleanup();
  }
});
