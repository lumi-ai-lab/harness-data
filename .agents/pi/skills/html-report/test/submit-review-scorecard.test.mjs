import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeReviewScorecard,
  submitReviewScorecard,
} from "../scripts/submit-review-scorecard.mjs";

function scorecard(overrides = {}) {
  return {
    scores: Object.fromEntries(
      ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, {
        score: id === "R3" ? 1 : 2,
        note: `${id} 已核对“最佳平衡点”，包含逗号、反斜杠 \\ 和 | 表格符`,
      }])
    ),
    summary: "报告证据完整，保留“最佳平衡点”原文。",
    hardBlockers: [],
    issues: [{
      severity: "soft",
      code: "DEPTH_SHORT",
      rubric: "R3",
      message: "未充分回答\"最佳平衡点\"作为区间的含义",
      where: "report/report.md 深度分析",
    }],
    repairHints: [],
    ...overrides,
  };
}

test("scorecard normalizes only the observed unambiguous nested metadata drift", () => {
  const canonical = scorecard();
  const nested = {
    scores: {
      ...canonical.scores,
      summary: canonical.summary,
      hardBlockers: canonical.hardBlockers,
      issues: canonical.issues,
      repairHints: canonical.repairHints,
    },
  };
  assert.deepEqual(normalizeReviewScorecard(nested), normalizeReviewScorecard(canonical));
  assert.throws(
    () => normalizeReviewScorecard({ ...canonical, scores: { ...nested.scores } }),
    /either all top-level or all nested/
  );
});

async function seed(t, scanOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "submit-review-scorecard-"));
  const session = join(root, "session");
  const quality = join(session, "quality");
  await mkdir(quality, { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({ status: "confirmed" }));
  await writeFile(join(quality, "scan.json"), JSON.stringify({
    version: 1,
    report: { matchedCount: 12, unmatchedCount: 0 },
    hardIssues: [],
    softIssues: [],
    ...scanOverrides,
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { session, quality, resultPath };
}

test("typed Reviewer scorecard safely round-trips quotes and writes all B4 artifacts", async (t) => {
  const seeded = await seed(t);
  const value = await submitReviewScorecard(seeded.resultPath, scorecard());
  assert.equal(value.status, "passed");
  assert.equal(value.pass, true);
  assert.equal(value.total, 13);
  assert.deepEqual(value.repairHints, []);
  assert.deepEqual(value.requiredRubrics, []);
  assert.deepEqual(value.gateFailures, []);

  const draft = JSON.parse(await readFile(join(seeded.quality, "verdict.draft.json"), "utf8"));
  assert.equal(draft.issues[0].message, "未充分回答\"最佳平衡点\"作为区间的含义");
  assert.match(draft.scores.R1.note, /反斜杠 \\/);
  const verdict = JSON.parse(await readFile(join(seeded.quality, "verdict.json"), "utf8"));
  assert.equal(verdict.producer, "write-verdict.mjs");
  assert.equal(verdict.total, 13);
  assert.equal(verdict.pass, true);
  assert.match(verdict.scanFingerprint, /^[a-f0-9]{64}$/);

  const report = await readFile(join(seeded.quality, "report.md"), "utf8");
  assert.match(report, /total: 13 \/ 14/);
  assert.match(report, /“最佳平衡点”/);
  assert.match(report, /反斜杠 \\ 和 \\| 表格符/);
  assert.match(report, /## 动态任务门禁/);
  assert.match(report, /无（沿用基础门禁）/);
});

test("typed Reviewer scorecard exposes dynamic task gates, fails them, and renders an actionable hint", async (t) => {
  const seeded = await seed(t);
  await mkdir(join(seeded.session, "analysis"), { recursive: true });
  await writeFile(join(seeded.session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "drill-compare",
      status: "done",
      analysisRequirements: [{
        id: "top-vs-rest",
        targetRubric: ["R5"],
      }],
    }],
  }));
  const value = await submitReviewScorecard(seeded.resultPath, scorecard({
    scores: {
      ...scorecard().scores,
      R5: { score: 1, note: "仅有简单对比，尚未形成完整对照链条" },
    },
    issues: [],
  }));

  assert.equal(value.total, 12);
  assert.equal(value.pass, false, "the base formula passes, but the dynamic R5 gate must fail");
  assert.equal(value.status, "failed");
  assert.deepEqual(value.requiredRubrics.map(({ rubric, minScore }) => ({ rubric, minScore })), [
    { rubric: "R5", minScore: 2 },
  ]);
  assert.deepEqual(value.gateFailures.map(({ rubric, actualScore }) => ({ rubric, actualScore })), [
    { rubric: "R5", actualScore: 1 },
  ]);
  assert.ok(value.repairHints.some((hint) => /R5 动态任务门槛未达标/.test(hint)));

  const report = await readFile(join(seeded.quality, "report.md"), "utf8");
  assert.match(report, /R5：要求 ≥ 2，实际 1/);
  assert.match(report, /drill-compare\/top-vs-rest/);
  assert.match(report, /R5：实际 1 < 要求 2/);
});

test("typed Reviewer scorecard carries scan hard issues and forces a failed verdict", async (t) => {
  const seeded = await seed(t, {
    hardIssues: [{ code: "DATA_UNTRACEABLE", message: "关键数字不可追溯", where: "report.md" }],
  });
  const value = await submitReviewScorecard(seeded.resultPath, scorecard({ issues: [] }));
  assert.equal(value.status, "failed");
  assert.equal(value.pass, false);
  assert.equal(value.total, 13);
  assert.equal(value.repairHints.length, 1);

  const draft = JSON.parse(await readFile(join(seeded.quality, "verdict.draft.json"), "utf8"));
  assert.equal(draft.hardBlockers[0].code, "DATA_UNTRACEABLE");
  const verdict = JSON.parse(await readFile(join(seeded.quality, "verdict.json"), "utf8"));
  assert.equal(verdict.pass, false);
});

test("typed Reviewer scorecard rejects malformed rubric cells before writing", () => {
  const malformed = scorecard();
  malformed.scores.R4.score = 1.5;
  assert.throws(() => normalizeReviewScorecard(malformed), /scores\.R4\.score must be 0, 1, or 2/);
});
