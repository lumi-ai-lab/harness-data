import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVerdict,
  collectRequiredRubrics,
  gateFailuresForScores,
  writeVerdict,
  fingerprintScanContent,
} from "../scripts/write-verdict.mjs";

const goodScores = () => ({
  R1: { score: 2 },
  R2: { score: 2 },
  R3: { score: 1 },
  R4: { score: 1 },
  R5: { score: 1 },
  R6: { score: 2 },
  R7: { score: 2 },
});

test("buildVerdict stamps producer and forces pass=false on hardBlockers", () => {
  const v = buildVerdict(
    {
      pass: true,
      scores: goodScores(),
      hardBlockers: [{ code: "INVENTED_METRIC" }],
    },
    { scanFingerprint: "abc" }
  );
  assert.equal(v.producer, "write-verdict.mjs");
  assert.equal(v.scanFingerprint, "abc");
  assert.equal(v.pass, false);
  assert.equal(v.draft, false);
  assert.equal(v.total, 11);
});

test("buildVerdict deterministically applies the fixed pass formula instead of draft discretion", () => {
  const eligible = buildVerdict(
    {
      pass: false,
      scores: goodScores(),
      hardBlockers: [],
      issues: [],
    },
    { scanFingerprint: "eligible" }
  );
  assert.equal(eligible.total, 11);
  assert.equal(eligible.pass, true, "a pessimistic draft cannot reject an eligible scorecard");

  const belowThreshold = buildVerdict(
    {
      pass: true,
      scores: Object.fromEntries(
        ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: id === "R7" ? 0 : 1 }])
      ),
      hardBlockers: [],
      issues: [],
    },
    { scanFingerprint: "below" }
  );
  assert.equal(belowThreshold.total, 6);
  assert.equal(belowThreshold.pass, false, "an optimistic draft cannot bypass total>=10");

  for (const required of ["R1", "R2"]) {
    const scores = Object.fromEntries(
      ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: id === required ? 0 : 2 }])
    );
    const verdict = buildVerdict(
      { pass: true, scores, hardBlockers: [], issues: [] },
      { scanFingerprint: `missing-${required}` }
    );
    assert.equal(verdict.total, 12);
    assert.equal(verdict.pass, false, `${required}>=1 is mandatory even above the total threshold`);
  }
});

test("collectRequiredRubrics preserves the base formula when no completed task declares targets", () => {
  assert.deepEqual(collectRequiredRubrics(undefined), []);
  assert.deepEqual(collectRequiredRubrics({ tasks: [] }), []);
  assert.deepEqual(collectRequiredRubrics({
    tasks: [{ id: "legacy-done", status: "done", analysisRequirements: [] }],
  }), []);
  assert.deepEqual(collectRequiredRubrics({
    tasks: [{ id: "pending-only", status: "pending", targetRubric: ["R5"] }],
  }), []);
});

test("collectRequiredRubrics prefers requirement targets and uses legacy task targets only as supplements", () => {
  const required = collectRequiredRubrics({
    tasks: [{
      id: "drill-001",
      status: "done",
      targetRubric: ["R1", "R5"],
      analysisRequirements: [{
        id: "answer-gap",
        targetRubric: ["R1"],
      }],
    }],
  });
  assert.deepEqual(required, [{
    rubric: "R1",
    minScore: 2,
    sources: [{
      taskId: "drill-001",
      requirementId: "answer-gap",
      source: "analysisRequirements[].targetRubric",
    }],
  }, {
    rubric: "R5",
    minScore: 2,
    sources: [{
      taskId: "drill-001",
      requirementId: null,
      source: "task.targetRubric",
    }],
  }]);
});

test("collectRequiredRubrics honors minScore=1 and takes the highest gate across completed tasks", () => {
  const required = collectRequiredRubrics({
    editorial: { userQuestion: "任意业务问题；不得参与门禁特判" },
    tasks: [{
      id: "drill-low",
      status: "done",
      analysisRequirements: [{ id: "structure", targetRubric: ["R3", "R5"], minScore: 1 }],
    }, {
      id: "drill-high",
      status: "done",
      analysisRequirements: [{ id: "comparison", targetRubric: ["R5"], minScore: 2 }],
    }, {
      id: "ignored",
      status: "failed",
      analysisRequirements: [{ id: "metric", targetRubric: ["R4"], minScore: 2 }],
    }],
  });
  assert.deepEqual(required.map(({ rubric, minScore }) => ({ rubric, minScore })), [
    { rubric: "R3", minScore: 1 },
    { rubric: "R5", minScore: 2 },
  ]);
  assert.equal(required[1].sources.length, 2);
});

test("collectRequiredRubrics rejects invalid completed-task minScore", () => {
  for (const minScore of [0, null]) {
    assert.throws(
      () => collectRequiredRubrics({
        tasks: [{
          id: "bad",
          status: "done",
          analysisRequirements: [{ id: "answer", targetRubric: ["R1"], minScore }],
        }],
      }),
      /minScore must be 1 or 2/
    );
  }
});

test("collectRequiredRubrics requires structured requirements only for marked current-contract tasks", () => {
  for (const task of [{
    id: "missing",
    status: "done",
    analysisContractVersion: 1,
  }, {
    id: "empty",
    status: "done",
    analysisContractVersion: 1,
    analysisRequirements: [],
  }]) {
    assert.throws(
      () => collectRequiredRubrics({ tasks: [task] }),
      /analysisRequirements must be non-empty/
    );
  }
  assert.throws(
    () => collectRequiredRubrics({
      tasks: [{
        id: "future",
        status: "done",
        analysisContractVersion: 2,
        analysisRequirements: [{ id: "answer", targetRubric: ["R1"] }],
      }],
    }),
    /analysisContractVersion must be exactly 1/
  );
});

test("buildVerdict adds completed-task gates on top of an otherwise passing base formula", () => {
  const requiredRubrics = collectRequiredRubrics({
    tasks: [{
      id: "drill-001",
      status: "done",
      analysisContractVersion: 1,
      analysisRequirements: [{ id: "comparison", targetRubric: ["R5"] }],
    }],
  });
  const verdict = buildVerdict(
    { scores: goodScores(), hardBlockers: [], issues: [] },
    { scanFingerprint: "dynamic", requiredRubrics }
  );
  assert.equal(verdict.total, 11);
  assert.equal(verdict.pass, false, "R5=1 must fail a declared default minScore=2 gate");
  assert.deepEqual(verdict.requiredRubrics, requiredRubrics);
  assert.deepEqual(verdict.gateFailures, [{
    rubric: "R5",
    minScore: 2,
    actualScore: 1,
    sources: requiredRubrics[0].sources,
  }]);
  assert.deepEqual(gateFailuresForScores(requiredRubrics, { ...goodScores(), R5: { score: 2 } }), []);
});

test("buildVerdict normalizes legacy max fields to the 0–2 / 14 scale", () => {
  const legacyScores = Object.fromEntries(
    Object.entries(goodScores()).map(([id, cell]) => [id, { ...cell, max: 7 }])
  );
  const verdict = buildVerdict(
    { pass: true, scores: legacyScores, maxTotal: 49 },
    { scanFingerprint: "legacy" }
  );
  assert.equal(verdict.maxTotal, 14);
  assert.ok(Object.values(verdict.scores).every((cell) => cell.max === 2));
});

test("buildVerdict rejects score outside 0–2", () => {
  assert.throws(
    () =>
      buildVerdict(
        {
          pass: true,
          scores: { ...goodScores(), R1: { score: 6 } },
        },
        { scanFingerprint: "x" }
      ),
    /0–2|0-2|R1/
  );
});

test("buildVerdict rejects fractional rubric scores", () => {
  assert.throws(
    () =>
      buildVerdict(
        {
          pass: true,
          scores: { ...goodScores(), R3: { score: 1.5 } },
        },
        { scanFingerprint: "x" }
      ),
    /R3.*0, 1, or 2/
  );
});

test("writeVerdict fingerprints scan.json and writes disk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-wv-"));
  const session = join(root, ".harness", "state", "html-report", "wv1");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "quality"), { recursive: true });
  const scanBody = JSON.stringify({ version: 1, hardIssues: [] });
  await writeFile(join(session, "quality", "scan.json"), scanBody);

  const { verdict } = await writeVerdict(session, {
    pass: true,
    scores: goodScores(),
    hardBlockers: [],
  });

  assert.equal(verdict.scanFingerprint, fingerprintScanContent(scanBody));
  const disk = JSON.parse(await readFile(join(session, "quality", "verdict.json"), "utf8"));
  assert.equal(disk.producer, "write-verdict.mjs");
  assert.equal(disk.total, 11);
  assert.equal(disk.pass, true);
  assert.deepEqual(disk.requiredRubrics, []);
  assert.deepEqual(disk.gateFailures, []);
});

test("writeVerdict reads only completed targets from the current Session tasks.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-wv-dynamic-"));
  const session = join(root, ".harness", "state", "html-report", "wv-dynamic");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "quality"), { recursive: true });
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "quality", "scan.json"), JSON.stringify({ version: 1, hardIssues: [] }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "done-target",
      status: "done",
      analysisContractVersion: 1,
      analysisRequirements: [{ id: "comparison", targetRubric: ["R5"] }],
    }, {
      id: "pending-target",
      status: "pending",
      analysisRequirements: [{ id: "answer", targetRubric: ["R1"] }],
    }],
  }));

  const { verdict } = await writeVerdict(session, {
    scores: goodScores(),
    hardBlockers: [],
    issues: [],
  });
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.requiredRubrics.map(({ rubric }) => rubric), ["R5"]);
  assert.deepEqual(verdict.gateFailures.map(({ rubric }) => rubric), ["R5"]);
});

test("writeVerdict forces pass=false when scan.json has hard issues", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-wv-scan-hard-"));
  const session = join(root, ".harness", "state", "html-report", "wv-scan-hard");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "quality"), { recursive: true });
  await writeFile(join(session, "quality", "scan.json"), JSON.stringify({
    version: 1,
    hardIssues: [{ code: "DATA_UNTRACEABLE", message: "关键数字不可追溯" }],
  }));

  const { verdict } = await writeVerdict(session, {
    pass: true,
    scores: goodScores(),
    hardBlockers: [],
    issues: [],
  });
  assert.equal(verdict.pass, false);
});

test("writeVerdict fails without scan.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-wv-miss-"));
  const session = join(root, ".harness", "state", "html-report", "wv2");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  await assert.rejects(() => writeVerdict(session, { scores: goodScores() }), /scan\.json/);
});
