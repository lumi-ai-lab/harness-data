import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResearcherReturnSchema,
  researcherContrastPolicy,
  researcherExpectedFromAssignment,
  researcherReturnPaths,
  validateResearcherAnalysisRequirements,
  validateResearcherCompletionContent,
  validateResearcherArtifacts,
  validateResearcherReturn,
} from "../scripts/researcher-return.mjs";

test("persisted typed requirements derive contrast policy only from bound operations", () => {
  const taskFor = (type) => ({
    analysisContractVersion: 1,
    evidencePlan: { operations: [{ id: "view", type }] },
    analysisRequirements: [{
      id: "answer",
      question: "回答通用子问题",
      evidenceViewIds: ["view"],
      targetRubric: ["R1"],
    }],
  });
  for (const type of ["project", "sort", "topN", "bottomN"]) {
    assert.equal(researcherContrastPolicy(taskFor(type)).required, false, type);
  }
  for (const type of [
    "stats",
    "range",
    "subsetStats",
    "compare",
    "compareTopN",
    "groupBy",
    "correlation",
    "quantileBins",
    "jointQuantileBins",
  ]) {
    assert.equal(researcherContrastPolicy(taskFor(type)).required, true, type);
  }
  assert.deepEqual(researcherContrastPolicy({ evidencePlan: { operations: [] } }), {
    ok: true,
    errors: [],
    required: true,
    source: "legacy",
  });
});

async function seedResearcherSession(t, mode = "reuse_entry", taskOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "html-report-researcher-return-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  const task = {
    id: "drill-1",
    fromCardId: "card-1",
    goal: "找出毛利额最高的日期",
    status: "pending",
    evidencePlan: {
      mode,
      reason: mode === "reuse_entry" ? "已有字段足够" : "需要新增维度",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top-profit", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
    ...(mode === "new_query" ? { evidenceGap: { type: "missing_dimension", reason: "需要品类维度" } } : { evidenceGap: null }),
    ...taskOverrides,
  };
  const paths = researcherReturnPaths({ sessionDir: session, taskId: task.id });
  await mkdir(join(session, "analysis", "evidence"), { recursive: true });
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await writeFile(paths.resultPath, JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(paths.tasksPath, JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [task] }));
  const assignment = [
    `按 report-researcher 处理 taskId=${task.id}`,
    `SESSION=${session}`,
    `result.json=${paths.resultPath}`,
    `完整 task 对象: ${JSON.stringify(task)}`,
    "用户问题: 哪一天毛利最好？",
    `evidencePath=${paths.evidencePath}`,
  ].join("\n");
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, session, task, paths, assignment };
}

function completion(expected) {
  const value = {
    taskId: expected.taskId,
    status: "ok",
    evidenceModeUsed: expected.mode,
    evidencePath: expected.evidencePath,
    sectionPath: expected.sectionPath,
    summaryPath: expected.summaryPath,
    summary: "2026-07-05 的毛利额为 3470.74。",
    noData: false,
    evidencePointers: ["/views/top-profit"],
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: Array.isArray(expected.analysisRequirements) && expected.analysisRequirements.length
        ? false
        : true,
      answersGoal: true,
      queryJustified: expected.mode === "new_query" ? true : null,
    },
    suggestedDeeper: [],
  };
  if (Array.isArray(expected.analysisRequirements) && expected.analysisRequirements.length) {
    value.findings = expected.analysisRequirements.map((requirement) => ({
      requirementId: requirement.id,
      claim: "2026-07-05 的毛利额为 3470.74。",
      evidencePointers: ["/views/top-profit"],
    }));
    value.summary = value.findings.map((finding) => finding.claim).join(" ");
  }
  return value;
}

async function writeValidArtifacts(expected, value, section = "# 结论\n\n2026-07-05 的毛利额为 3470.74。\n\n证据：`/views/top-profit`\n") {
  await writeFile(expected.evidencePath, JSON.stringify({
    taskId: expected.taskId,
    evidenceMode: expected.mode,
    source: {
      empty: false,
      queryCoverage: { startDate: "2026-07-01", endDate: "2026-07-27", filterDimUniqueCodeList: [{ dimFieldIdList: ["101001"] }] },
    },
    views: {
      "top-profit": {
        type: "topN",
        matchedRows: 1,
        returnedRows: 1,
        rows: [{ row: { 日期: "2026-07-05", 毛利额: 3470.74 } }],
      },
    },
  }));
  await writeFile(expected.sectionPath, section);
  await writeFile(expected.summaryPath, JSON.stringify(value));
}

test("Researcher assignment is resolved from the persisted task and exact SESSION paths", async (t) => {
  const seeded = await seedResearcherSession(t);
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  assert.equal(expected.taskId, "drill-1");
  assert.equal(expected.mode, "reuse_entry");
  assert.equal(expected.evidencePath, seeded.paths.evidencePath);

  const forged = researcherExpectedFromAssignment(
    seeded.assignment.replace('"mode":"reuse_entry"', '"mode":"new_query"'),
    { sessionDir: seeded.session }
  );
  assert.match(forged.error, /task 对象.*不一致/);
});

test("Researcher assignment accepts the complete task object as multiline JSON", async (t) => {
  const seeded = await seedResearcherSession(t);
  const multilineAssignment = seeded.assignment.replace(
    `完整 task 对象: ${JSON.stringify(seeded.task)}`,
    `完整 task 对象:\n${JSON.stringify(seeded.task, null, 2)}`
  );
  const expected = researcherExpectedFromAssignment(multilineAssignment, { sessionDir: seeded.session });
  assert.equal(expected.error, undefined);
  assert.equal(expected.taskId, seeded.task.id);
  assert.equal(expected.mode, "reuse_entry");
  assert.deepEqual(expected.task, seeded.task);
});

test("Researcher assignment rejects relative and dot-segment SESSION artifact paths", async (t) => {
  const seeded = await seedResearcherSession(t);
  const cases = [
    {
      name: "relative SESSION",
      value: seeded.assignment.replace(`SESSION=${seeded.session}`, "SESSION=.harness/state/html-report/s1"),
    },
    {
      name: "relative result.json",
      value: seeded.assignment.replace(`result.json=${seeded.paths.resultPath}`, "result.json=./result.json"),
    },
    {
      name: "relative evidencePath",
      value: seeded.assignment.replace(`evidencePath=${seeded.paths.evidencePath}`, "evidencePath=analysis/evidence/drill-1.json"),
    },
    {
      name: "dot-segment SESSION",
      value: seeded.assignment.replace(`SESSION=${seeded.session}`, `SESSION=${seeded.session}/../s1`),
    },
    {
      name: "dot-segment result.json",
      value: seeded.assignment.replace(
        `result.json=${seeded.paths.resultPath}`,
        `result.json=${seeded.session}/analysis/../result.json`
      ),
    },
    {
      name: "dot-segment evidencePath",
      value: seeded.assignment.replace(
        `evidencePath=${seeded.paths.evidencePath}`,
        `evidencePath=${seeded.session}/analysis/evidence/../evidence/drill-1.json`
      ),
    },
  ];

  for (const entry of cases) {
    const checked = researcherExpectedFromAssignment(entry.value, { sessionDir: seeded.session });
    assert.match(checked.error, /无 dot-segment 的规范绝对路径/, entry.name);
  }
});

test("Researcher schema pins task, mode, and all completion paths", async (t) => {
  const seeded = await seedResearcherSession(t);
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const schema = buildResearcherReturnSchema(expected);
  const ok = schema.oneOf[0].properties;
  assert.equal(ok.taskId.const, "drill-1");
  assert.equal(ok.evidenceModeUsed.const, "reuse_entry");
  assert.equal(ok.evidencePath.const, seeded.paths.evidencePath);
  assert.equal(ok.sectionPath.const, seeded.paths.sectionPath);
  assert.equal(ok.summaryPath.const, seeded.paths.summaryPath);
  assert.equal(ok.selfCheck.properties.queryJustified.const, null);
  assert.equal(ok.evidencePointers.items.pattern, "^/views/");
  assert.equal(ok.evidencePointers.maxItems, 24);

  const badPointer = completion(expected);
  badPointer.evidencePointers = ["/views-forged/top-profit"];
  assert.ok(validateResearcherReturn(badPointer, expected).errors.some((error) => /\/views\//.test(error)));
});

test("Researcher artifact validation accepts exact cited evidence without a copied table", async (t) => {
  const seeded = await seedResearcherSession(t);
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const value = completion(expected);
  await writeValidArtifacts(expected, value);
  assert.deepEqual(validateResearcherReturn(value, expected), { ok: true, errors: [] });
  assert.deepEqual(validateResearcherArtifacts(value, expected), { ok: true, errors: [] });
});

test("Researcher completion content preflight validates tables, pointers, and exact cited numbers without I/O", () => {
  const evidence = {
    source: {
      queryCoverage: {
        startDate: "2026-07-01",
        endDate: "2026-07-27",
        filterDimUniqueCodeList: [{ dimFieldIdList: ["101001"] }],
      },
    },
    views: {
      "top-profit": {
        returnedRows: 1,
        rows: [{ row: { 日期: "2026-07-05", 毛利额: 3470.74 } }],
      },
      unrelated: { value: 470 },
    },
  };
  const section = [
    "# 门店101001结论",
    "",
    "2026-07-05 的毛利额为 3470.74。",
    "",
    "证据：`/views/top-profit`",
  ].join("\n");

  assert.deepEqual(
    validateResearcherCompletionContent({ evidence, section, summary: "2026-07-05 的毛利额为 3470.74。" }),
    { ok: true, errors: [] }
  );

  const chinesePointer = "/views/top-profit/rows/0/row/毛利额";
  const chineseEvidence = {
    source: { queryCoverage: {} },
    views: { "top-profit": { rows: [{ row: { 毛利额: 3470.74 } }] } },
  };
  assert.deepEqual(
    validateResearcherCompletionContent({
      evidence: chineseEvidence,
      section: `毛利额为 3470.74（\`${chinesePointer}\`）。`,
    }),
    { ok: true, errors: [] },
    "RFC 6901 array segments and Chinese field names must be preserved"
  );
  const bracketPointer = validateResearcherCompletionContent({
    evidence: chineseEvidence,
    section: "毛利额为 3470.74（`/views/top-profit/rows[0]/row/毛利额`）。",
  });
  assert.ok(bracketPointer.errors.some((error) => /does not resolve/.test(error)));

  const table = validateResearcherCompletionContent({
    evidence,
    section: `${section}\n\n日期 | 毛利额\n--- | ---:\n2026-07-05 | 3470.74`,
  });
  assert.ok(table.errors.some((error) => /Markdown table/.test(error)));

  const unresolved = validateResearcherCompletionContent({
    evidence,
    section: "结论见 `/views/missing`。",
  });
  assert.ok(unresolved.errors.some((error) => /does not resolve/.test(error)));

  const absentFromSection = validateResearcherCompletionContent({
    evidence,
    section: "2026-07-05 的毛利额为 3470.74。",
    evidencePointers: ["/views/top-profit"],
  });
  assert.ok(absentFromSection.errors.some((error) => /section does not cite/.test(error)));

  const uncitedNumber = validateResearcherCompletionContent({
    evidence,
    section,
    summary: "客数均值为 470。",
    evidencePointers: ["/views/top-profit"],
  });
  assert.ok(uncitedNumber.errors.some((error) => /470/.test(error)));

  const comparisonEvidence = {
    source: { queryCoverage: {} },
    views: {
      comparison: {
        selectedStats: {
          客单价: {
            mean: 17.966,
            comparisonToRemaining: {
              remainingCount: 23,
              remainingMean: 17.760455,
              remainingMeanDisplay: 17.76,
              meanDelta: 0.205545,
              meanDeltaDisplay: 0.206,
              direction: "higher",
            },
          },
        },
      },
    },
  };
  assert.deepEqual(
    validateResearcherCompletionContent({
      evidence: comparisonEvidence,
      section: "高毛利样本客单价均值高出 0.206，其余样本数为 23。证据：`/views/comparison/selectedStats`",
    }),
    { ok: true, errors: [] },
    "script-produced meanDelta must be traceable through the selectedStats parent pointer"
  );

  const untraceablePercentage = validateResearcherCompletionContent({
    evidence: comparisonEvidence,
    section: "高毛利样本客单价显著高出 0.206（1.2%）。证据：`/views/comparison/selectedStats`",
  });
  assert.ok(untraceablePercentage.errors.some((error) => /1\.2%/.test(error)));

  const unsupportedSignificance = validateResearcherCompletionContent({
    evidence: comparisonEvidence,
    section: "高毛利样本客单价显著高出 0.206。证据：`/views/comparison/selectedStats`",
  });
  assert.ok(unsupportedSignificance.errors.some((error) => /significance without cited/.test(error)));

  const unscopedCorrelation = validateResearcherCompletionContent({
    evidence: comparisonEvidence,
    section: "客单价相关性为 0.206。证据：`/views/comparison/selectedStats`",
  });
  assert.ok(unscopedCorrelation.errors.some((error) => /sample-scoped/.test(error)));
  assert.deepEqual(
    validateResearcherCompletionContent({
      evidence: comparisonEvidence,
      section: "样本内客单价相关性为 0.206，但不能证明因果。证据：`/views/comparison/selectedStats`",
    }),
    { ok: true, errors: [] }
  );
  for (const causalClaim of [
    "样本内客单价相关性为 0.206，影响更大。证据：`/views/comparison/selectedStats`",
    "样本内客单价相关性为 0.206，共同推高结果。证据：`/views/comparison/selectedStats`",
  ]) {
    const checked = validateResearcherCompletionContent({
      evidence: comparisonEvidence,
      section: causalClaim,
    });
    assert.ok(checked.errors.some((error) => /causality without cited causal evidence/.test(error)));
  }

  const mixedPopulationEvidence = {
    source: { queryCoverage: {} },
    views: {
      relationship: {
        type: "correlation",
        correlations: {
          first: {
            eligibleRows: 3,
            zeroValueSensitivity: { applied: true, eligibleRows: 2 },
          },
          second: { eligibleRows: 2, zeroValueSensitivity: { applied: false } },
        },
      },
    },
  };
  const blanketExclusion = validateResearcherCompletionContent({
    evidence: mixedPopulationEvidence,
    section: "上述异常样本已排除。证据：`/views/relationship`",
  });
  assert.ok(blanketExclusion.errors.some((error) => /blanket exclusion claim/.test(error)));

  const significanceEvidence = structuredClone(comparisonEvidence);
  significanceEvidence.views.comparison.selectedStats.pValue = 0.01;
  assert.deepEqual(
    validateResearcherCompletionContent({
      evidence: significanceEvidence,
      section: "样本内差异显著，p 值为 0.01。证据：`/views/comparison/selectedStats`",
    }),
    { ok: true, errors: [] }
  );

  for (const summary of [
    "表明高分位日的来客数与客单价同时偏高。",
    "意味着来客数与客单价存在联动。",
    "高分位日的来客数与客单价同时偏高。",
  ]) {
    const inferredSummary = validateResearcherCompletionContent({
      evidence: comparisonEvidence,
      section: "高毛利样本客单价均值高出 0.206。证据：`/views/comparison/selectedStats`",
      summary,
      evidencePointers: ["/views/comparison/selectedStats"],
    });
    assert.deepEqual(
      inferredSummary,
      { ok: true, errors: [] },
      `generic evidence contract must not force a fixed safe prose vocabulary: ${summary}`
    );
  }
});

test("analysisRequirements are generic, view-bound, rubric-valid, and backward compatible", async (t) => {
  const legacy = await seedResearcherSession(t);
  const legacyExpected = researcherExpectedFromAssignment(legacy.assignment, { sessionDir: legacy.session });
  const legacySchema = buildResearcherReturnSchema(legacyExpected).oneOf[0];
  assert.equal("findings" in legacySchema.properties, false);
  assert.equal(legacySchema.required.includes("findings"), false);

  const requirements = [
    {
      id: "answer-balance",
      question: "样本中可观察到什么平衡特征？",
      evidenceViewIds: ["top-profit"],
      targetRubric: ["R3", "R5"],
      minScore: 2,
    },
    {
      id: "state-boundary",
      question: "结论适用边界是什么？",
      evidenceViewIds: ["top-profit"],
      targetRubric: ["R5"],
    },
  ];
  const seeded = await seedResearcherSession(t, "reuse_entry", {
    analysisContractVersion: 1,
    analysisRequirements: requirements,
  });
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  assert.equal(expected.error, undefined);
  assert.deepEqual(expected.analysisRequirements, requirements);

  const schema = buildResearcherReturnSchema(expected).oneOf[0];
  assert.ok(schema.required.includes("findings"));
  assert.equal(schema.properties.findings.maxItems, 12);
  assert.equal(schema.properties.findings.items.properties.evidencePointers.maxItems, 6);
  assert.deepEqual(
    schema.properties.findings.items.properties.requirementId.enum,
    ["answer-balance", "state-boundary"]
  );

  const value = completion(expected);
  await writeValidArtifacts(expected, value);
  assert.deepEqual(validateResearcherReturn(value, expected), { ok: true, errors: [] });
  assert.deepEqual(validateResearcherArtifacts(value, expected), { ok: true, errors: [] });

  const uncovered = structuredClone(value);
  uncovered.findings = uncovered.findings.slice(0, 1);
  const uncoveredCheck = validateResearcherReturn(uncovered, expected);
  assert.ok(uncoveredCheck.errors.some((error) => /not covered.*state-boundary/.test(error)));

  const wrongView = structuredClone(value);
  wrongView.findings[0].evidencePointers = ["/views/unassigned"];
  wrongView.evidencePointers.push("/views/unassigned");
  const wrongViewCheck = validateResearcherReturn(wrongView, expected);
  assert.ok(wrongViewCheck.errors.some((error) => /outside requirement.*evidenceViewIds/.test(error)));

  const rewrittenSummary = structuredClone(value);
  rewrittenSummary.summary = "2026-07-05 的毛利额约为 3470.7。";
  await writeValidArtifacts(expected, rewrittenSummary);
  const rewrittenSummaryCheck = validateResearcherArtifacts(rewrittenSummary, expected);
  assert.ok(rewrittenSummaryCheck.errors.some((error) => /concatenate findings.*without rewriting/.test(error)));

  const invalidTask = structuredClone(seeded.task);
  invalidTask.analysisRequirements = [{
    ...requirements[0],
    evidenceViewIds: ["missing-view"],
    targetRubric: ["R8"],
    minScore: 3,
  }];
  const invalid = validateResearcherAnalysisRequirements(invalidTask);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => /unknown evidencePlan operation/.test(error)));
  assert.ok(invalid.errors.some((error) => /R1-R7/.test(error)));
  assert.ok(invalid.errors.some((error) => /minScore/.test(error)));

  for (const analysisRequirements of [undefined, []]) {
    const currentTask = { ...seeded.task, analysisRequirements };
    const checked = validateResearcherAnalysisRequirements(currentTask);
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.some((error) => /non-empty array.*current analysis contract/.test(error)));
  }

  const explicitNull = structuredClone(seeded.task);
  explicitNull.analysisRequirements[0].minScore = null;
  const nullCheck = validateResearcherAnalysisRequirements(explicitNull);
  assert.equal(nullCheck.ok, false);
  assert.ok(nullCheck.errors.some((error) => /minScore must be 1 or 2/.test(error)));
  delete explicitNull.analysisContractVersion;
  const legacyNullCheck = validateResearcherAnalysisRequirements(explicitNull);
  assert.equal(legacyNullCheck.ok, false, "explicit null is invalid even on an otherwise legacy task");
  assert.ok(legacyNullCheck.errors.some((error) => /minScore must be 1 or 2/.test(error)));
});

test("requirement findings must appear in the section and trace numbers to their own pointers", async (t) => {
  const seeded = await seedResearcherSession(t, "reuse_entry", {
    analysisContractVersion: 1,
    analysisRequirements: [{
      id: "answer",
      question: "回答业务问题",
      evidenceViewIds: ["top-profit"],
      targetRubric: ["R3"],
    }],
  });
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const value = completion(expected);
  value.findings[0].claim = "2026-07-05 的毛利额为 9999。";
  const section = "2026-07-05 的毛利额为 9999。\n\n证据：`/views/top-profit`\n";
  await writeValidArtifacts(expected, value, section);
  const untraceable = validateResearcherArtifacts(value, expected);
  assert.ok(untraceable.errors.some((error) => /findings\[0\].*9999/.test(error)));

  value.findings[0].claim = "2026-07-05 的毛利额为 3470.74。";
  await writeValidArtifacts(expected, value, "结论另见证据：`/views/top-profit`\n");
  const absent = validateResearcherArtifacts(value, expected);
  assert.ok(absent.errors.some((error) => /does not contain findings\[0\]\.claim verbatim/.test(error)));

  value.findings[0].claim = "门店 101001 的已观察记录纳入本次结论。";
  await writeValidArtifacts(
    expected,
    value,
    "门店 101001 的已观察记录纳入本次结论。\n\n证据：`/views/top-profit`\n"
  );
  const borrowedScopeNumber = validateResearcherArtifacts(value, expected);
  assert.ok(
    borrowedScopeNumber.errors.some((error) => /findings\[0\].*101001/.test(error)),
    "a finding must not borrow a coincidentally matching number from source.queryCoverage"
  );
});

test("Researcher artifact validation rejects Markdown tables and model-rounded numbers", async (t) => {
  const seeded = await seedResearcherSession(t);
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const value = completion(expected);
  value.summary = "高客单组客数均值为 470。";
  await writeValidArtifacts(
    expected,
    value,
    "# 结论\n\n高客单组客数均值为 470。\n\n日期 | 毛利额\n--- | ---:\n2026-07-05 | 3470.74\n\n`/views/top-profit`\n"
  );
  const checked = validateResearcherArtifacts(value, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /Markdown table/.test(error)));
  assert.ok(checked.errors.some((error) => /470/.test(error)));
});

test("non-ok Researcher responses cannot leave fake completion artifacts", async (t) => {
  const seeded = await seedResearcherSession(t);
  const expected = researcherExpectedFromAssignment(seeded.assignment, { sessionDir: seeded.session });
  const value = {
    taskId: expected.taskId,
    status: "needs_evidence_plan",
    evidenceModeUsed: expected.mode,
    evidenceGap: {
      type: "missing_operation",
      reason: "需要 compare view",
      requiredOperations: [{ type: "compare" }],
    },
  };
  assert.deepEqual(validateResearcherArtifacts(value, expected), { ok: true, errors: [] });
  await writeFile(expected.sectionPath, "fake");
  const checked = validateResearcherArtifacts(value, expected);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => /must not leave completion artifact/.test(error)));
});
