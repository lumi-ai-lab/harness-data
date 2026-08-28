import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResearcherSubmission,
  submitResearchFindings,
} from "../scripts/submit-research-findings.mjs";

function fixture(root) {
  const session = join(root, "session");
  const task = {
    id: "generic-task",
    analysisContractVersion: 1,
    evidencePlan: {
      mode: "reuse_entry",
      operations: [
        { id: "rank/view", type: "compareTopN" },
        { id: "association", type: "correlation" },
      ],
    },
    analysisRequirements: [
      { id: "profile", question: "比较", capability: "comparison", evidenceViewIds: ["rank/view"], targetRubric: ["R1", "R5"] },
      { id: "relation", question: "关联", capability: "association", evidenceViewIds: ["association"], targetRubric: ["R5"] },
    ],
  };
  const expected = {
    taskId: task.id,
    mode: "reuse_entry",
    evidencePath: join(session, "analysis", "evidence", "generic-task.json"),
    sectionPath: join(session, "analysis", "sections", "explore-generic-task.md"),
    summaryPath: join(session, "analysis", "sections", "explore-generic-task.summary.json"),
    task,
    analysisRequirements: task.analysisRequirements,
  };
  const evidence = {
    taskId: task.id,
    evidenceMode: "reuse_entry",
    source: { empty: false, queryCoverage: {} },
    views: {
      "rank/view": {
        type: "compareTopN",
        population: { selectedCount: 2, remainingCount: 1 },
        selectedStats: { metric: { count: 2, numericCount: 2, mean: 12 } },
        remainingStats: { metric: { count: 1, numericCount: 1, mean: 8 } },
      },
      association: {
        type: "correlation",
        population: { matchedRows: 3 },
        interpretation: { supportsCausality: false },
        correlations: { factor: { status: "ok", coefficient: 0.5, eligibleRows: 3 } },
      },
    },
  };
  const params = {
    findings: [
      { requirementId: "profile", claim: "选中样本数为2、指标均值为12，其余样本数为1、指标均值为8。", evidencePointers: ["/views/rank~1view"] },
      { requirementId: "relation", claim: "当前查询样本内观察相关系数为0.5，有效样本数为3。", evidencePointers: ["/views/association"] },
    ],
    suggestedDeeper: [],
  };
  return { expected, evidence, params };
}

test("typed Researcher submit renders citations and owns the complete envelope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "submit-research-findings-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { expected, evidence, params } = fixture(root);
  const built = buildResearcherSubmission(expected, evidence, params);
  assert.equal(
    built.section,
    "- 选中样本数为2、指标均值为12，其余样本数为1、指标均值为8。\n  证据：`/views/rank~1view`\n" +
    "- 当前查询样本内观察相关系数为0.5，有效样本数为3。\n  证据：`/views/association`"
  );
  assert.equal(built.researcherReturn.summary, params.findings.map((item) => item.claim).join(" "));
  assert.deepEqual(built.researcherReturn.evidencePointers, ["/views/rank~1view", "/views/association"]);
  assert.deepEqual(built.researcherReturn.selfCheck, {
    modeCompliant: true,
    evidenceTraceable: true,
    hasContrastOrBreakdown: true,
    answersGoal: true,
    queryJustified: null,
  });

  const submitted = await submitResearchFindings(expected, evidence, params);
  assert.deepEqual(
    JSON.parse(await readFile(expected.summaryPath, "utf8")),
    submitted.researcherReturn
  );
  assert.equal(await readFile(expected.sectionPath, "utf8"), built.section);
  assert.deepEqual(
    await submitResearchFindings(expected, evidence, params),
    submitted,
    "an exact replay must be idempotent"
  );
});

test("typed Researcher submit rejects missing requirements, wrong views, and unsupported prose", () => {
  const { expected, evidence, params } = fixture("/tmp/unused-submit-research-findings");
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: params.findings.slice(0, 1),
    }),
    /exactly one item for each/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        { ...params.findings[0], evidencePointers: ["/views/association"] },
        params.findings[1],
      ],
    }),
    /outside requirement profile evidenceViewIds/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        params.findings[0],
        { ...params.findings[1], claim: "相关系数0.5影响更大。" },
      ],
    }),
    /causality|sample-scoped/
  );
});

test("typed Researcher submit rejects hollow claims without an exact machine fact", () => {
  const { expected, evidence, params } = fixture("/tmp/unused-submit-research-hollow");
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        { ...params.findings[0], claim: "选中样本表现值得继续关注。" },
        params.findings[1],
      ],
    }),
    /machine-verifiable fact.*profile/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        { ...params.findings[0], claim: "compareTopN 视图已经生成。" },
        params.findings[1],
      ],
    }),
    /machine-verifiable fact.*profile/
  );

  const wrongShape = structuredClone(evidence);
  wrongShape.views["rank/view"] = {
    type: "topN",
    matchedRows: 2,
    returnedRows: 2,
    rows: [],
  };
  assert.throws(
    () => buildResearcherSubmission(expected, wrongShape, params),
    /machine-verifiable fact.*profile/
  );
});

test("typed Researcher fact roles reject one-sided comparison and incomplete association", () => {
  const { expected, evidence, params } = fixture("/tmp/unused-submit-research-roles");
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        {
          ...params.findings[0],
          claim: "选中样本数为2、指标均值为12。",
        },
        params.findings[1],
      ],
    }),
    /machine-verifiable fact.*profile/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        params.findings[0],
        {
          ...params.findings[1],
          claim: "当前查询样本内观察相关系数为0.5。",
        },
      ],
    }),
    /machine-verifiable fact.*relation/
  );
});

test("typed Researcher structural and joint-tradeoff roles require real contrast and support", () => {
  const { expected, evidence } = fixture("/tmp/unused-submit-research-structural");
  expected.task.evidencePlan.operations = [{ id: "groups", type: "groupBy" }];
  expected.task.analysisRequirements = [{
    id: "structure",
    question: "比较结构单元",
    capability: "structural_breakdown",
    evidenceViewIds: ["groups"],
    targetRubric: ["R3", "R5"],
  }];
  expected.analysisRequirements = expected.task.analysisRequirements;
  evidence.views = {
    groups: {
      type: "groupBy",
      groupCount: 2,
      groups: [
        { value: "A组", rowCount: 2, stats: { metric: { count: 2, numericCount: 2, mean: 12 } } },
        { value: "B组", rowCount: 1, stats: { metric: { count: 1, numericCount: 1, mean: 8 } } },
      ],
    },
  };
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      findings: [{
        requirementId: "structure",
        claim: "A组指标均值为12。",
        evidencePointers: ["/views/groups"],
      }],
      suggestedDeeper: [],
    }),
    /machine-verifiable fact.*structure/
  );
  assert.equal(
    buildResearcherSubmission(expected, evidence, {
      findings: [{
        requirementId: "structure",
        claim: "A组指标均值为12，B组指标均值为8。",
        evidencePointers: ["/views/groups"],
      }],
      suggestedDeeper: [],
    }).researcherReturn.selfCheck.answersGoal,
    true
  );

  expected.task.evidencePlan.operations = [{ id: "joint", type: "jointQuantileBins" }];
  expected.task.analysisRequirements = [{
    id: "tradeoff",
    question: "识别两个因素的最佳已观测组合",
    capability: "joint_tradeoff",
    evidenceViewIds: ["joint"],
    targetRubric: ["R1", "R3", "R5"],
  }];
  expected.analysisRequirements = expected.task.analysisRequirements;
  evidence.views = {
    joint: {
      type: "jointQuantileBins",
      decisionBrief: {
        answerOrder: ["supportedCandidates", "rawObservedWinners", "stabilityAndLimits"],
        answerStatus: "supported_observed_winner_mean_median_agree",
        minimumSupportRowCount: 3,
        supportedCandidates: {
          status: "available",
          byMean: { cellId: "Q2×Q2", rowCount: 4, targetStats: { meanDisplay: 20 } },
        },
        rawObservedWinners: {
          supportSufficient: true,
          byMean: { cellId: "Q2×Q2", rowCount: 4, targetStats: { meanDisplay: 20 } },
        },
        stabilityAndLimits: { stableSinglePoint: true, supportsGlobalOptimum: false },
      },
      grid: {
        observedCellCount: 2,
        cells: [
          {
            cellId: "Q2×Q2",
            coordinates: { left: { ordinal: 2 }, right: { ordinal: 2 } },
            rowCount: 4,
            targetStats: { count: 4, numericCount: 4, mean: 20, median: 19 },
          },
          {
            cellId: "Q1×Q1",
            coordinates: { left: { ordinal: 1 }, right: { ordinal: 1 } },
            rowCount: 5,
            targetStats: { count: 5, numericCount: 5, mean: 10, median: 10 },
          },
        ],
      },
      evaluation: {
        status: "ok",
        bestObservedByMean: { value: 20, cellIds: ["Q2×Q2"] },
        bestObservedByMedian: { value: 19, cellIds: ["Q2×Q2"] },
        support: { minimumCellRowCount: 3 },
      },
    },
  };
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      findings: [{
        requirementId: "tradeoff",
        claim: "最佳已观测单元Q2×Q2的目标均值为20。",
        evidencePointers: ["/views/joint/decisionBrief"],
      }],
      suggestedDeeper: [],
    }),
    /machine-verifiable fact.*tradeoff/
  );
  assert.equal(
    buildResearcherSubmission(expected, evidence, {
      findings: [{
        requirementId: "tradeoff",
        claim: "最佳已观测单元Q2×Q2的目标均值为20，单元行数为4，最小支持行数为3。",
        evidencePointers: ["/views/joint/decisionBrief"],
      }],
      suggestedDeeper: [],
    }).researcherReturn.selfCheck.answersGoal,
    true
  );
});

test("typed Researcher self-check does not call a record-only view a contrast", () => {
  const { expected, evidence } = fixture("/tmp/unused-submit-research-record-only");
  expected.task.evidencePlan.operations = [{ id: "record", type: "topN" }];
  expected.task.analysisRequirements = [{
    id: "record-answer",
    question: "返回已观测记录",
    capability: "record",
    evidenceViewIds: ["record"],
    targetRubric: ["R1"],
  }];
  expected.analysisRequirements = expected.task.analysisRequirements;
  evidence.views = {
    record: {
      type: "topN",
      matchedRows: 4,
      returnedRows: 1,
      rows: [{ sourcePointer: "/0", row: { category: "北区" } }],
    },
  };
  const built = buildResearcherSubmission(expected, evidence, {
    findings: [{
      requirementId: "record-answer",
      claim: "已观测类别为北区。",
      evidencePointers: ["/views/record"],
    }],
    suggestedDeeper: [],
  });
  assert.equal(built.researcherReturn.selfCheck.answersGoal, true);
  assert.equal(built.researcherReturn.selfCheck.hasContrastOrBreakdown, false);
});

test("typed Researcher accepts cited ordinal language only when ordered evidence exposes rank", () => {
  const { expected, evidence } = fixture("/tmp/unused-submit-research-ranked-records");
  expected.task.evidencePlan.operations = [{ id: "ranked", type: "topN" }];
  expected.task.analysisRequirements = [{
    id: "ranking-answer",
    question: "返回明确要求的排序记录",
    capability: "ranking",
    evidenceViewIds: ["ranked"],
    targetRubric: ["R1"],
  }];
  expected.analysisRequirements = expected.task.analysisRequirements;
  evidence.views = {
    ranked: {
      type: "topN",
      matchedRows: 3,
      returnedRows: 2,
      rows: [
        { rank: 1, sourcePointer: "/1", row: { category: "乙", metric: 30 } },
        { rank: 2, sourcePointer: "/2", row: { category: "丙", metric: 20 } },
      ],
    },
  };

  const built = buildResearcherSubmission(expected, evidence, {
    findings: [{
      requirementId: "ranking-answer",
      claim: "第1名乙的指标为30，第2名丙的指标为20。",
      evidencePointers: ["/views/ranked"],
    }],
    suggestedDeeper: [],
  });
  assert.equal(built.researcherReturn.selfCheck.answersGoal, true);
});

test("typed Researcher self-check accepts an exact no_data count without claiming contrast", () => {
  const { expected, evidence } = fixture("/tmp/unused-submit-research-no-data");
  expected.task.evidencePlan.operations = [{ id: "empty", type: "project" }];
  expected.task.analysisRequirements = [{
    id: "empty-answer",
    question: "说明无数据边界",
    capability: "no_data",
    evidenceViewIds: ["empty"],
    targetRubric: ["R1"],
  }];
  expected.analysisRequirements = expected.task.analysisRequirements;
  evidence.source.empty = true;
  evidence.views = {
    empty: { type: "project", matchedRows: 0, returnedRows: 0, rows: [] },
  };
  const built = buildResearcherSubmission(expected, evidence, {
    findings: [{
      requirementId: "empty-answer",
      claim: "当前可用记录数为0。",
      evidencePointers: ["/views/empty"],
    }],
    suggestedDeeper: [],
  });
  assert.equal(built.researcherReturn.noData, true);
  assert.equal(built.researcherReturn.selfCheck.answersGoal, true);
  assert.equal(built.researcherReturn.selfCheck.hasContrastOrBreakdown, false);
});

test("typed Researcher submit enforces final-schema limits before writing", () => {
  const { expected, evidence, params } = fixture("/tmp/unused-submit-research-limits");
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      suggestedDeeper: ["one", "two", "three", "four"],
    }),
    /at most 3 items/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        { ...params.findings[0], claim: "甲".repeat(2401) },
        params.findings[1],
      ],
    }),
    /at most 2400 characters/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, evidence, {
      ...params,
      findings: [
        { ...params.findings[0], claim: "甲".repeat(1200) },
        { ...params.findings[1], claim: "乙".repeat(1200) },
      ],
    }),
    /summary must contain at most 2400 characters/
  );
});

test("typed Researcher submit rejects mismatched evidence identity", () => {
  const { expected, evidence, params } = fixture("/tmp/unused-submit-research-identity");
  assert.throws(
    () => buildResearcherSubmission(expected, { ...evidence, taskId: "another-task" }, params),
    /evidence taskId does not match/
  );
  assert.throws(
    () => buildResearcherSubmission(expected, { ...evidence, evidenceMode: "new_query" }, params),
    /evidenceMode does not match/
  );
  const { taskId: _taskId, ...withoutTaskId } = evidence;
  assert.throws(
    () => buildResearcherSubmission(expected, withoutTaskId, params),
    /evidence taskId does not match/
  );
});

test("typed Researcher claims must remain one plain Markdown line", () => {
  const { expected, evidence, params } = fixture("/tmp/unused-submit-research-claim-shape");
  for (const claim of [
    "结论。\n### 注入标题",
    "结论。\u2028注入分行",
    "### 块级标题",
    "<div>块级 HTML</div>",
  ]) {
    assert.throws(
      () => buildResearcherSubmission(expected, evidence, {
        ...params,
        findings: [{ ...params.findings[0], claim }, params.findings[1]],
      }),
      /one line|Markdown or HTML block/
    );
  }
});

test("typed Researcher submit recovers either matching single artifact without overwriting", async (t) => {
  for (const existingSide of ["section", "summary"]) {
    await t.test(existingSide, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `submit-research-single-${existingSide}-`));
      t.after(async () => rm(root, { recursive: true, force: true }));
      const { expected, evidence, params } = fixture(root);
      const built = buildResearcherSubmission(expected, evidence, params);
      const summaryContent = `${JSON.stringify(built.researcherReturn, null, 2)}\n`;
      await mkdir(join(root, "session", "analysis", "sections"), { recursive: true });
      if (existingSide === "section") await writeFile(expected.sectionPath, built.section);
      else await writeFile(expected.summaryPath, summaryContent);

      await submitResearchFindings(expected, evidence, params);
      assert.equal(await readFile(expected.sectionPath, "utf8"), built.section);
      assert.equal(await readFile(expected.summaryPath, "utf8"), summaryContent);
    });
  }
});

test("typed Researcher submit fails closed on conflicting artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "submit-research-conflict-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { expected, evidence, params } = fixture(root);
  await mkdir(join(root, "session", "analysis", "sections"), { recursive: true });
  await writeFile(expected.sectionPath, "user-owned conflicting content");
  await assert.rejects(
    () => submitResearchFindings(expected, evidence, params),
    /completion artifact conflicts/
  );
  assert.equal(await readFile(expected.sectionPath, "utf8"), "user-owned conflicting content");
  await assert.rejects(() => readFile(expected.summaryPath, "utf8"), { code: "ENOENT" });
});
