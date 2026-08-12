import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewerReturnSchema,
  parseReviewerReturnText,
  reviewerExpectedFromAssignment,
  reviewerReturnPaths,
  validateReviewerArtifacts,
  validateReviewerReturn,
} from "../scripts/reviewer-return.mjs";
import { writeVerdict } from "../scripts/write-verdict.mjs";

const scores = () => ({
  R1: { score: 2 },
  R2: { score: 2 },
  R3: { score: 1 },
  R4: { score: 1 },
  R5: { score: 1 },
  R6: { score: 2 },
  R7: { score: 2 },
});

async function seedReviewerSession(t) {
  const root = await mkdtemp(join(tmpdir(), "html-report-reviewer-return-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  const paths = reviewerReturnPaths({ sessionDir: session });
  await mkdir(join(session, "quality"), { recursive: true });
  await writeFile(paths.resultPath, JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(paths.scanPath, JSON.stringify({ version: 1, hardIssues: [] }));
  await writeFile(paths.reportPath, "# 质量审核报告\n\n未通过。\n");
  const assignment = [
    `B4 scorecard for SESSION=${session}`,
    `result.json=${paths.resultPath}`,
    "review the parent-produced scan and submit the stamped verdict",
  ].join("\n");
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, session, paths, assignment };
}

function reviewerReturn(expected, {
  pass = false,
  total = 11,
  requiredRubrics = [],
  gateFailures = [],
} = {}) {
  return {
    status: pass ? "passed" : "failed",
    pass,
    total,
    maxTotal: 14,
    sessionDir: expected.sessionDir,
    resultPath: expected.resultPath,
    scanPath: expected.scanPath,
    reportPath: expected.reportPath,
    verdictPath: expected.verdictPath,
    repairHints: pass ? [] : ["删除不可追溯数字后重新审核"],
    requiredRubrics,
    gateFailures,
  };
}

function infrastructureErrorReturn(expected, overrides = {}) {
  return {
    status: "infrastructure_error",
    pass: false,
    total: 0,
    maxTotal: 14,
    sessionDir: expected.sessionDir,
    resultPath: expected.resultPath,
    scanPath: expected.scanPath,
    reportPath: expected.reportPath,
    verdictPath: expected.verdictPath,
    failedStep: "read",
    error: "ENOENT: frozen report input is unavailable",
    repairHints: ["恢复冻结输入后再重试 B4"],
    ...overrides,
  };
}

test("Reviewer assignment pins SESSION, result, scan, report, and verdict absolute paths", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  assert.deepEqual(expected, seeded.paths);

  const forged = reviewerExpectedFromAssignment(
    seeded.assignment.replace(seeded.paths.resultPath, join(seeded.root, "other", "result.json")),
    { sessionDir: seeded.session }
  );
  assert.match(forged.error, /固定路径/);

  const relative = reviewerExpectedFromAssignment("SESSION=relative\nresult.json=relative/result.json", {
    sessionDir: seeded.session,
  });
  assert.match(relative.error, /绝对路径/);
});

test("Reviewer schema is exact and binds failed status to pass=false", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const schema = buildReviewerReturnSchema(expected);
  const passed = schema.oneOf[0];
  const failed = schema.oneOf[1];
  const infrastructureError = schema.oneOf[2];
  assert.equal(passed.additionalProperties, false);
  assert.equal(passed.properties.status.const, "passed");
  assert.equal(passed.properties.pass.const, true);
  assert.equal(failed.properties.status.const, "failed");
  assert.equal(failed.properties.pass.const, false);
  assert.equal(failed.properties.total.type, "integer");
  assert.equal(failed.properties.total.maximum, 14);
  assert.equal(failed.properties.resultPath.const, expected.resultPath);
  assert.equal(failed.properties.scanPath.const, expected.scanPath);
  assert.equal(failed.properties.reportPath.const, expected.reportPath);
  assert.equal(failed.properties.verdictPath.const, expected.verdictPath);
  assert.equal(failed.properties.repairHints.minItems, 1);
  assert.ok(failed.required.includes("requiredRubrics"));
  assert.ok(failed.required.includes("gateFailures"));
  assert.equal(failed.properties.requiredRubrics.items.additionalProperties, false);
  assert.equal(failed.properties.gateFailures.items.properties.actualScore.maximum, 2);
  assert.equal(infrastructureError.additionalProperties, false);
  assert.equal(infrastructureError.properties.status.const, "infrastructure_error");
  assert.equal(infrastructureError.properties.pass.const, false);
  assert.equal(infrastructureError.properties.total.const, 0);
  assert.deepEqual(infrastructureError.properties.failedStep.enum, ["read", "write", "stamp"]);
  assert.equal(infrastructureError.properties.repairHints.minItems, 1);
});

test("Reviewer return rejects success wrapping, path redirection, and old 49-point totals", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  assert.deepEqual(validateReviewerReturn(reviewerReturn(expected), expected), { ok: true, errors: [] });

  const wrapped = reviewerReturn(expected);
  wrapped.status = "passed";
  let checked = validateReviewerReturn(wrapped, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /status must be passed/.test(error)));

  const redirected = reviewerReturn(expected);
  redirected.verdictPath = join(seeded.root, "forged-verdict.json");
  checked = validateReviewerReturn(redirected, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /verdictPath/.test(error)));

  const oldScale = reviewerReturn(expected, { total: 49 });
  checked = validateReviewerReturn(oldScale, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /0 to 14/.test(error)));

  const fractional = reviewerReturn(expected, { total: 10.5 });
  checked = validateReviewerReturn(fractional, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /integer from 0 to 14/.test(error)));

  const noRepairHint = reviewerReturn(expected);
  noRepairHint.repairHints = [];
  checked = validateReviewerReturn(noRepairHint, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /at least one actionable repair hint/.test(error)));
});

test("Reviewer infrastructure_error is strict, actionable, and does not require partial artifacts", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  await rm(join(seeded.session, "quality"), { recursive: true, force: true });

  const infrastructureError = infrastructureErrorReturn(expected);
  assert.deepEqual(validateReviewerReturn(infrastructureError, expected), { ok: true, errors: [] });
  assert.deepEqual(validateReviewerArtifacts(infrastructureError, expected), { ok: true, errors: [] });

  let checked = validateReviewerReturn(
    infrastructureErrorReturn(expected, { failedStep: "retry", repairHints: [] }),
    expected
  );
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /failedStep must be read, write, or stamp/.test(error)));
  assert.ok(checked.errors.some((error) => /at least one actionable repair hint/.test(error)));

  checked = validateReviewerReturn(infrastructureErrorReturn(expected, { total: 7 }), expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /must use total=0/.test(error)));
});

test("Reviewer artifacts accept an exact stamped failed verdict without calling it success", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const { verdict } = await writeVerdict(seeded.session, {
    pass: true,
    maxTotal: 14,
    scores: scores(),
    hardBlockers: [{ code: "DATA_UNTRACEABLE" }],
  });
  assert.equal(verdict.pass, false);
  const value = reviewerReturn(expected, { pass: false, total: verdict.total });
  assert.deepEqual(validateReviewerArtifacts(value, expected), { ok: true, errors: [] });

  const fakeSuccess = reviewerReturn(expected, { pass: true, total: verdict.total });
  const checked = validateReviewerArtifacts(fakeSuccess, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /pass must exactly match/.test(error)));

  await writeFile(expected.scanPath, JSON.stringify({ version: 1, hardIssues: [], changed: true }));
  const stale = validateReviewerArtifacts(value, expected);
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.some((error) => /scanFingerprint/.test(error)));
});

test("Reviewer artifacts reject a stamped pass value that violates the fixed score formula", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const { verdict } = await writeVerdict(seeded.session, {
    pass: false,
    scores: scores(),
    hardBlockers: [],
    issues: [],
  });
  assert.equal(verdict.total, 11);
  assert.equal(verdict.pass, true);

  verdict.pass = false;
  await writeFile(expected.verdictPath, JSON.stringify(verdict));
  const checked = validateReviewerArtifacts(
    reviewerReturn(expected, { pass: false, total: verdict.total }),
    expected
  );
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /base formula plus all completed-task dynamic rubric gates/.test(error)));
});

test("Reviewer artifacts recompute dynamic gates from done tasks and reject omitted or forged audit fields", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  await mkdir(join(seeded.session, "analysis"), { recursive: true });
  await writeFile(join(seeded.session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "drill-compare",
      status: "done",
      analysisRequirements: [{
        id: "comparison-chain",
        targetRubric: ["R5"],
      }],
    }, {
      id: "ignored-pending",
      status: "pending",
      targetRubric: ["R3"],
    }],
  }));
  const { verdict } = await writeVerdict(seeded.session, {
    scores: scores(),
    hardBlockers: [],
    issues: [],
  });
  assert.equal(verdict.total, 11);
  assert.equal(verdict.pass, false, "the dynamic R5>=2 gate must reject the base-eligible scorecard");

  const exact = reviewerReturn(expected, {
    pass: false,
    total: verdict.total,
    requiredRubrics: verdict.requiredRubrics,
    gateFailures: verdict.gateFailures,
  });
  assert.deepEqual(validateReviewerArtifacts(exact, expected), { ok: true, errors: [] });

  const omitted = { ...exact };
  delete omitted.requiredRubrics;
  let checked = validateReviewerReturn(omitted, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /unexpected or missing fields/.test(error)));

  const forgedReturn = {
    ...exact,
    requiredRubrics: [],
    gateFailures: [],
  };
  checked = validateReviewerArtifacts(forgedReturn, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /must exactly match quality\/verdict\.json/.test(error)));

  const forgedVerdict = JSON.parse(await readFile(expected.verdictPath, "utf8"));
  forgedVerdict.requiredRubrics = [];
  forgedVerdict.gateFailures = [];
  forgedVerdict.pass = true;
  await writeFile(expected.verdictPath, JSON.stringify(forgedVerdict));
  const fakeSuccess = reviewerReturn(expected, {
    pass: true,
    total: forgedVerdict.total,
    requiredRubrics: [],
    gateFailures: [],
  });
  checked = validateReviewerArtifacts(fakeSuccess, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /derived from completed current-Session tasks/.test(error)));
  assert.ok(checked.errors.some((error) => /base formula plus all completed-task dynamic rubric gates/.test(error)));
});

test("Reviewer artifacts reject pass=true when the stamped scan still has hard issues", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  await writeFile(expected.scanPath, JSON.stringify({
    version: 1,
    hardIssues: [{ code: "DATA_UNTRACEABLE", message: "关键数字不可追溯" }],
  }));
  const { verdict } = await writeVerdict(seeded.session, {
    pass: true,
    maxTotal: 14,
    scores: scores(),
    hardBlockers: [],
    issues: [],
  });
  assert.equal(verdict.pass, false, "write-verdict must honor scan-only hard issues");
  verdict.pass = true;
  await writeFile(expected.verdictPath, JSON.stringify(verdict));

  const checked = validateReviewerArtifacts(
    reviewerReturn(expected, { pass: true, total: verdict.total }),
    expected
  );
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /scan\.json has hardIssues/.test(error)));
});

test("Reviewer artifacts require report, scan, verdict, and write-verdict producer", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const { verdict } = await writeVerdict(seeded.session, {
    pass: true,
    maxTotal: 14,
    scores: scores(),
    hardBlockers: [],
  });
  const value = reviewerReturn(expected, { pass: true, total: verdict.total });

  const unstamped = JSON.parse(await readFile(expected.verdictPath, "utf8"));
  unstamped.producer = "report-reviewer";
  await writeFile(expected.verdictPath, JSON.stringify(unstamped));
  let checked = validateReviewerArtifacts(value, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /producer must be write-verdict/.test(error)));

  await unlink(expected.reportPath);
  checked = validateReviewerArtifacts(value, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /missing Reviewer quality\/report\.md/.test(error)));
});

test("Reviewer artifacts reject fractional R1-R7 verdict scores", async (t) => {
  const seeded = await seedReviewerSession(t);
  const expected = reviewerExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const { verdict } = await writeVerdict(seeded.session, {
    pass: true,
    maxTotal: 14,
    scores: scores(),
    hardBlockers: [],
  });
  const value = reviewerReturn(expected, { pass: true, total: verdict.total });
  verdict.scores.R3.score = 1.5;
  await writeFile(expected.verdictPath, JSON.stringify(verdict));

  const checked = validateReviewerArtifacts(value, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /scores\.R3.*0, 1, or 2/.test(error)));
});

test("Reviewer text parser accepts one bare JSON document and rejects acceptance prose", () => {
  assert.deepEqual(parseReviewerReturnText('{"pass":false}'), { pass: false });
  assert.throws(
    () => parseReviewerReturnText('steps completed successfully\n```json\n{"pass":false}\n```'),
    /one JSON object without prose/
  );
});
