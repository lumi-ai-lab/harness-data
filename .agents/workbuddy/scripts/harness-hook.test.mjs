import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { shouldBypassHtmlReportContext } from "./harness-hook.mjs";

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
