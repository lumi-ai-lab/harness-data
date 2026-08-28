import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildEditorPlanSchema,
  compileEditorArtifacts,
  EDITOR_PLANNER_SYSTEM_PROMPT,
  editorPlannerExpectedFromAssignment,
  isEditorPlannerAssignment,
  loadEditorPlannerInput,
  normalizeEditorPlan,
  persistEditorSourceInventory,
  persistEditorWriterReturn,
  validateEditorPlan,
} from "../scripts/editor-plan-contract.mjs";
import { persistEditorSourceInventory as persistKernelSourceInventory } from "../../../../../packages/html-report-kernel/src/editor/source-inventory-cache.mjs";
import { materializeEditorPlan } from "../scripts/editor-plan.mjs";

function inputFixture({ empty = false } = {}) {
  return {
    version: 1,
    producer: "editor-plan-contract.mjs",
    userQuestion: "在哪一种观测组合下结果更好，相关因素如何变化？",
    title: "组合效果分析",
    cards: [{
      id: "card-a",
      title: "样本明细",
      analysisFocus: "观察因素与结果",
      queryCoverage: {
        metrics: ["metric-a", "metric-b", "metric-c"],
        statisticPolicy: "SUMMARY",
        dimensions: ["period-key"],
        time: { startDate: "2026-01-01", endDate: "2026-01-31", grain: null },
        filters: { "entity-key": ["entity-a"] },
        scopes: null,
        measureFilters: [],
        comparisons: [],
      },
      writer: {
        summary: "观测值 98765 仅存在于 Writer 摘要，不能复制进 main。",
        findings: [{ statement: "起点", evidence: ["entry.json#/4"] }],
        recommendations: ["继续比较"],
      },
      source: {
        cardId: "card-a",
        status: "available",
        rowCount: empty ? 0 : 31,
        rowsSha256: "a".repeat(64),
        empty,
        fieldInventoryStatus: empty ? "unverifiable_empty_source" : "validated",
        availableFields: empty ? [] : ["period_key", "factor_a", "factor_b", "outcome_c"],
        profile: {},
        dataQuality: {},
      },
    }],
  };
}

function reusePlan() {
  return {
    version: 1,
    noDeeperReason: null,
    answerRequirements: [],
    tasks: [{
      fromCardId: "card-a",
      goal: "识别结果较好的记录并判断样本内因素关联",
      gap: "起点分析没有形成组合比较与关联证据",
      mode: "reuse_entry",
      reason: "现有明细已经包含记录维度、候选因素与结果字段",
      evidenceGap: null,
      candidateIndicators: [],
      candidateDims: [],
      operations: [
        {
          id: "best-records",
          type: "compareTopN",
          sortBy: "outcome_c",
          fields: ["period_key", "factor_a", "factor_b", "outcome_c"],
          count: 5,
          direction: "desc",
        },
        {
          id: "factor-links",
          type: "correlation",
          targetField: "outcome_c",
          fields: ["factor_a", "factor_b"],
        },
      ],
      requirements: [
        {
          id: "answer-record",
          question: "哪一条已观察记录的结果更好，并与其余记录有何差异？",
          capability: "comparison",
          evidenceViewIds: ["best-records"],
          targetRubric: ["R1", "R5"],
        },
        {
          id: "answer-association",
          question: "候选因素与结果在当前查询样本内呈现何种关联？",
          capability: "association",
          evidenceViewIds: ["factor-links"],
          targetRubric: ["R5"],
        },
      ],
      successCriteria: "每个子问题都有对应确定性 view 和可追溯结论",
      hint: "只解释已观察样本，不升级为因果或通用阈值",
    }],
  };
}

function newQueryPlan() {
  const plan = reusePlan();
  const task = plan.tasks[0];
  task.mode = "new_query";
  task.reason = "当前明细缺少回答结构问题所需的新维度";
  task.evidenceGap = { type: "missing_dimension", reason: "需要新增分组维度" };
  task.candidateDims = ["prospective-dimension"];
  task.operations = [{
    id: "new-groups",
    type: "groupBy",
    groupField: "future_group_field",
    fields: ["future_outcome_field"],
  }];
  task.requirements = [{
    id: "answer-groups",
    question: "新增维度下的组间结果如何比较？",
    capability: "structural_breakdown",
    evidenceViewIds: ["new-groups"],
    targetRubric: ["R3", "R5"],
  }];
  return plan;
}

test("Planner marker accepts one exact Pi Task prefix and rejects loose lookalikes", () => {
  assert.equal(isEditorPlannerAssignment("HTML_REPORT_EDITOR_PLAN_V1\nSESSION=/tmp/session"), true);
  assert.equal(isEditorPlannerAssignment("Task: HTML_REPORT_EDITOR_PLAN_V1\nSESSION=/tmp/session"), true);
  assert.equal(isEditorPlannerAssignment("  Task: HTML_REPORT_EDITOR_PLAN_V1\nSESSION=/tmp/session"), true);
  assert.equal(isEditorPlannerAssignment('<file name="/tmp/task.md">\nTask: HTML_REPORT_EDITOR_PLAN_V1\nSESSION=/tmp/session\n</file>'), true);
  assert.equal(isEditorPlannerAssignment('<file name="/tmp/task.md">\nHTML_REPORT_EDITOR_PLAN_V1\nSESSION=/tmp/session\n</file>'), true);
  assert.equal(isEditorPlannerAssignment("Task: Task: HTML_REPORT_EDITOR_PLAN_V1"), false);
  assert.equal(isEditorPlannerAssignment("Task:  HTML_REPORT_EDITOR_PLAN_V1"), false);
  assert.equal(isEditorPlannerAssignment("Task: HTML_REPORT_EDITOR_PLAN_V1 extra"), false);
  assert.equal(isEditorPlannerAssignment("prefix HTML_REPORT_EDITOR_PLAN_V1"), false);
  assert.equal(isEditorPlannerAssignment('<file name="/tmp/task.md">\nprefix\nHTML_REPORT_EDITOR_PLAN_V1\n</file>'), false);
  assert.equal(isEditorPlannerAssignment("HTML_REPORT_EDITOR_PLAN_V1_SUFFIX"), false);
});

test("typed Editor plan compiles deterministic tasks/main with one traceable Writer finding and no raw rows", () => {
  const input = inputFixture();
  const plan = reusePlan();
  assert.equal(validateEditorPlan(plan, input).ok, true);
  const first = compileEditorArtifacts(plan, input);
  const second = compileEditorArtifacts(structuredClone(plan), structuredClone(input));
  assert.deepEqual(first, second);
  assert.deepEqual(first.tasks.tasks[0].evidencePlan.requiredColumns, [
    "period_key",
    "factor_a",
    "factor_b",
    "outcome_c",
  ]);
  assert.deepEqual(first.tasks.tasks[0].targetRubric, ["R1", "R5"]);
  assert.equal(first.tasks.tasks[0].analysisRequirements[0].capability, "comparison");
  assert.match(first.main, /## 待 B3 Researcher 结论/);
  assert.doesNotMatch(first.main, /98765/);
  assert.match(first.main, /起点；evidence: entry\.json#\/4/);
  assert.doesNotMatch(first.main, /\|<table\b/i);
  assert.match(first.main, /entry\.json#\/4/);
});

test("reuse_entry rejects unknown inventory fields, operation aliases, duplicate source tasks, and mismatched capabilities", () => {
  const input = inputFixture();
  const unknown = reusePlan();
  unknown.tasks[0].operations[0].fields.push("not_in_inventory");
  assert.match(validateEditorPlan(unknown, input).errors.join("\n"), /not in source\.availableFields/);

  const unknownTarget = reusePlan();
  unknownTarget.tasks[0].operations[1].targetField = "not_in_inventory";
  assert.match(validateEditorPlan(unknownTarget, input).errors.join("\n"), /not in source\.availableFields/);

  const alias = reusePlan();
  alias.tasks[0].operations[0].field = alias.tasks[0].operations[0].sortBy;
  delete alias.tasks[0].operations[0].sortBy;
  assert.match(validateEditorPlan(alias, input).errors.join("\n"), /missing, extra, or aliased keys/);

  const duplicate = reusePlan();
  duplicate.tasks.push(structuredClone(duplicate.tasks[0]));
  assert.match(validateEditorPlan(duplicate, input).errors.join("\n"), /duplicates a reuse_entry task/);

  const mismatch = reusePlan();
  mismatch.tasks[0].requirements[1].evidenceViewIds = ["best-records"];
  assert.match(validateEditorPlan(mismatch, input).errors.join("\n"), /association.*not supported|association requires/);

  const shallowComparison = reusePlan();
  shallowComparison.tasks[0].operations = [{
    id: "ranked-records",
    type: "topN",
    field: "outcome_c",
    fields: ["period_key", "factor_a", "outcome_c"],
    count: 3,
  }];
  shallowComparison.tasks[0].requirements = [{
    id: "answer-ranking",
    question: "列出结果靠前的观测记录",
    capability: "comparison",
    evidenceViewIds: ["ranked-records"],
    targetRubric: ["R1"],
  }];
  assert.match(validateEditorPlan(shallowComparison, input).errors.join("\n"), /comparison.*not supported/);
  shallowComparison.tasks[0].requirements[0].capability = "ranking";
  assert.equal(validateEditorPlan(shallowComparison, input).ok, true);

  const contaminatedModeFields = reusePlan();
  contaminatedModeFields.tasks[0].evidenceGap = {
    type: "missing_comparison",
    reason: "已有明细仍需派生对照视图",
  };
  contaminatedModeFields.tasks[0].candidateIndicators = ["metric-a"];
  contaminatedModeFields.tasks[0].candidateDims = ["period-key"];
  assert.match(
    validateEditorPlan(contaminatedModeFields, input).errors.join("\n"),
    /reuse_entry evidenceGap must be null[\s\S]*candidate lists must be empty/
  );

  const loweredGate = reusePlan();
  loweredGate.tasks[0].requirements[0].minScore = 1;
  assert.match(validateEditorPlan(loweredGate, input).errors.join("\n"), /missing or extra keys/);

  const selfCorrelation = reusePlan();
  selfCorrelation.tasks[0].operations[1].fields.push("outcome_c");
  assert.match(validateEditorPlan(selfCorrelation, input).errors.join("\n"), /exclude targetField/);

  const mergeableBins = reusePlan();
  mergeableBins.tasks[0].operations = [
    {
      id: "factor-a-bins",
      type: "quantileBins",
      targetField: "outcome_c",
      fields: ["factor_a"],
      binCount: 4,
    },
    {
      id: "factor-b-bins",
      type: "quantileBins",
      targetField: "outcome_c",
      fields: ["factor_b"],
    },
  ];
  mergeableBins.tasks[0].requirements = [{
    id: "answer-gradients",
    question: "不同因素区间的结果梯度如何比较？",
    capability: "structural_breakdown",
    evidenceViewIds: ["factor-a-bins", "factor-b-bins"],
    targetRubric: ["R3", "R5"],
  }];
  assert.match(validateEditorPlan(mergeableBins, input).errors.join("\n"), /must merge fields\[\]/);

  const duplicateOperation = reusePlan();
  duplicateOperation.tasks[0].operations.push({
    ...structuredClone(duplicateOperation.tasks[0].operations[1]),
    id: "factor-links-copy",
  });
  assert.match(validateEditorPlan(duplicateOperation, input).errors.join("\n"), /duplicates operation/);
});

test("one consolidated source task accepts up to six operations but never a duplicate source task", () => {
  const input = inputFixture();
  const plan = reusePlan();
  plan.tasks[0].operations = [
    { id: "rows", type: "project", fields: ["period_key"] },
    { id: "ranked", type: "sort", field: "outcome_c", fields: ["factor_a", "outcome_c"], count: 5 },
    { id: "summary", type: "stats", fields: ["factor_a", "outcome_c"] },
    { id: "bounds", type: "range", fields: ["factor_b", "outcome_c"] },
    { id: "groups", type: "groupBy", groupField: "period_key", fields: ["outcome_c"] },
    { id: "links", type: "correlation", targetField: "outcome_c", fields: ["factor_a", "factor_b"] },
  ];
  plan.tasks[0].requirements = [
    {
      id: "records",
      question: "哪些观测记录进入结果排序？",
      capability: "ranking",
      evidenceViewIds: ["rows", "ranked"],
      targetRubric: ["R1"],
    },
    {
      id: "basic-distribution",
      question: "观测字段的基础分布如何？",
      capability: "distribution",
      evidenceViewIds: ["summary", "bounds"],
      targetRubric: ["R1"],
    },
    {
      id: "structural-groups",
      question: "不同组的结果结构有何差异？",
      capability: "structural_breakdown",
      evidenceViewIds: ["groups"],
      targetRubric: ["R3", "R5"],
    },
    {
      id: "observed-links",
      question: "因素与结果在样本内有何关联？",
      capability: "association",
      evidenceViewIds: ["links"],
      targetRubric: ["R5"],
    },
  ];
  assert.deepEqual(validateEditorPlan(plan, input).errors, []);

  const seventhOperation = structuredClone(plan);
  seventhOperation.tasks[0].operations.push({
    id: "bottom",
    type: "bottomN",
    field: "outcome_c",
    fields: ["period_key", "outcome_c"],
    count: 3,
  });
  assert.match(validateEditorPlan(seventhOperation, input).errors.join("\n"), /operations must contain 1-6 items/);

  const duplicateSource = structuredClone(plan);
  duplicateSource.tasks.push(structuredClone(plan.tasks[0]));
  assert.match(validateEditorPlan(duplicateSource, input).errors.join("\n"), /duplicates a reuse_entry task/);
});

test("Planner normalization merges provably equivalent views and rewrites requirement foreign keys", () => {
  const plan = reusePlan();
  plan.tasks[0].operations = [
    {
      id: "first-bins",
      type: "quantileBins",
      targetField: "outcome_c",
      fields: ["factor_a"],
      binCount: 4,
    },
    {
      id: "second-bins",
      type: "quantileBins",
      targetField: "outcome_c",
      fields: ["factor_b"],
    },
  ];
  plan.tasks[0].requirements = [
    {
      id: "first-gradient",
      question: "第一个因素的区间梯度如何？",
      capability: "structural_breakdown",
      evidenceViewIds: ["first-bins"],
      targetRubric: ["R3", "R5"],
    },
    {
      id: "second-gradient",
      question: "第二个因素的区间梯度如何？",
      capability: "structural_breakdown",
      evidenceViewIds: ["second-bins"],
      targetRubric: ["R3", "R5"],
    },
  ];
  const canonical = normalizeEditorPlan(plan);
  assert.notEqual(canonical, plan);
  assert.equal(plan.tasks[0].operations.length, 2, "normalization must not mutate the typed return");
  assert.deepEqual(canonical.tasks[0].operations, [{
    id: "first-bins",
    type: "quantileBins",
    targetField: "outcome_c",
    fields: ["factor_a", "factor_b"],
    binCount: 4,
  }]);
  assert.deepEqual(
    canonical.tasks[0].requirements.map((requirement) => requirement.evidenceViewIds),
    [["first-bins"], ["first-bins"]]
  );
  assert.equal(validateEditorPlan(canonical, inputFixture()).ok, true);
});

test("Planner normalization compacts record-only compareTopN into equivalent topN", () => {
  const plan = reusePlan();
  plan.tasks[0].operations = [{
    id: "best-record",
    type: "compareTopN",
    sortBy: "outcome_c",
    fields: ["period_key"],
    count: 1,
    direction: "desc",
    where: [{ field: "factor_a", op: "gt", value: 0 }],
  }];
  plan.tasks[0].requirements = [{
    id: "record-answer",
    question: "哪条已观测记录最高？",
    capability: "ranking",
    evidenceViewIds: ["best-record"],
    targetRubric: ["R2"],
  }];
  const normalized = normalizeEditorPlan(plan);
  assert.deepEqual(normalized.tasks[0].operations, [{
    id: "best-record",
    type: "topN",
    field: "outcome_c",
    fields: ["period_key", "outcome_c"],
    count: 1,
    direction: "desc",
    where: [{ field: "factor_a", op: "gt", value: 0 }],
  }]);

  const invalidPlan = structuredClone(plan);
  invalidPlan.tasks[0].operations[0].unexpected = true;
  const invalidNormalized = normalizeEditorPlan(invalidPlan);
  assert.equal(invalidNormalized.tasks[0].operations[0].unexpected, true);
  assert.equal(validateEditorPlan(invalidNormalized, inputFixture()).ok, false);

  plan.tasks[0].requirements[0].capability = "comparison";
  assert.deepEqual(normalizeEditorPlan(plan).tasks[0].operations[0], plan.tasks[0].operations[0]);

  plan.tasks[0].requirements.unshift({
    id: "record-answer-too",
    question: "哪条已观测记录最高？",
    capability: "ranking",
    evidenceViewIds: ["best-record"],
    targetRubric: ["R2"],
  });
  assert.deepEqual(normalizeEditorPlan(plan).tasks[0].operations[0], plan.tasks[0].operations[0]);
});

test("Planner normalization canonicalizes an exact rank sortBy alias without accepting ambiguous keys", () => {
  const plan = reusePlan();
  plan.tasks[0].operations = [{
    id: "top-records",
    type: "topN",
    sortBy: "outcome_c",
    fields: ["period_key", "factor_a", "outcome_c"],
    count: 5,
    direction: "desc",
  }];
  plan.tasks[0].requirements = [{
    id: "record-answer",
    question: "结果最高的已观察记录是什么？",
    capability: "ranking",
    evidenceViewIds: ["top-records"],
    targetRubric: ["R1", "R2"],
  }];
  assert.match(validateEditorPlan(plan, inputFixture()).errors.join("\n"), /missing, extra, or aliased keys/);
  const normalized = normalizeEditorPlan(plan);
  assert.deepEqual(normalized.tasks[0].operations, [{
    id: "top-records",
    type: "topN",
    field: "outcome_c",
    fields: ["period_key", "factor_a", "outcome_c"],
    count: 5,
    direction: "desc",
  }]);
  assert.equal(validateEditorPlan(normalized, inputFixture()).ok, true);
  assert.equal(plan.tasks[0].operations[0].field, undefined, "normalization must not mutate the Planner return");

  const ambiguous = structuredClone(plan);
  ambiguous.tasks[0].operations[0].field = "factor_a";
  const ambiguousNormalized = normalizeEditorPlan(ambiguous);
  assert.equal(ambiguousNormalized.tasks[0].operations[0].sortBy, "outcome_c");
  assert.equal(ambiguousNormalized.tasks[0].operations[0].field, "factor_a");
  assert.equal(validateEditorPlan(ambiguousNormalized, inputFixture()).ok, false);

  const extra = structuredClone(plan);
  extra.tasks[0].operations[0].unexpected = true;
  assert.equal(normalizeEditorPlan(extra).tasks[0].operations[0].unexpected, true);
  assert.equal(validateEditorPlan(normalizeEditorPlan(extra), inputFixture()).ok, false);
});

test("Planner normalization removes an explicitly repeated target from exact driver-field contracts", () => {
  const plan = reusePlan();
  plan.tasks[0].operations = [{
    id: "joint-balance",
    type: "jointQuantileBins",
    targetField: "outcome_c",
    fields: ["factor_a", "factor_b", "outcome_c"],
    direction: "desc",
    binCount: 5,
  }];
  plan.tasks[0].requirements = [{
    id: "answer-joint",
    question: "两个因素的哪个已观测组合区间对应更好的结果？",
    capability: "joint_tradeoff",
    evidenceViewIds: ["joint-balance"],
    targetRubric: ["R1", "R3", "R5"],
  }];

  assert.match(validateEditorPlan(plan, inputFixture()).errors.join("\n"), /exclude targetField/);
  const normalized = normalizeEditorPlan(plan);
  assert.deepEqual(normalized.tasks[0].operations[0].fields, ["factor_a", "factor_b"]);
  assert.equal(validateEditorPlan(normalized, inputFixture()).ok, true);
  assert.deepEqual(
    plan.tasks[0].operations[0].fields,
    ["factor_a", "factor_b", "outcome_c"],
    "normalization must not mutate the Planner return"
  );

  const extra = structuredClone(plan);
  extra.tasks[0].operations[0].unexpected = true;
  const extraNormalized = normalizeEditorPlan(extra);
  assert.deepEqual(extraNormalized.tasks[0].operations[0].fields, ["factor_a", "factor_b", "outcome_c"]);
  assert.equal(validateEditorPlan(extraNormalized, inputFixture()).ok, false);

  const wrongArity = structuredClone(plan);
  wrongArity.tasks[0].operations[0].fields = ["factor_a", "outcome_c"];
  const wrongArityNormalized = normalizeEditorPlan(wrongArity);
  assert.deepEqual(wrongArityNormalized.tasks[0].operations[0].fields, ["factor_a"]);
  assert.match(
    validateEditorPlan(wrongArityNormalized, inputFixture()).errors.join("\n"),
    /exactly two driver fields/
  );

  const duplicateTarget = structuredClone(plan);
  duplicateTarget.tasks[0].operations[0].fields.push("outcome_c");
  assert.deepEqual(
    normalizeEditorPlan(duplicateTarget).tasks[0].operations[0].fields,
    ["factor_a", "factor_b", "outcome_c", "outcome_c"]
  );
  assert.match(
    validateEditorPlan(normalizeEditorPlan(duplicateTarget), inputFixture()).errors.join("\n"),
    /unique string array/
  );

  const tooManyFields = structuredClone(plan);
  tooManyFields.tasks[0].operations[0].fields = [
    ...Array.from({ length: 20 }, (_, index) => `driver_${index + 1}`),
    "outcome_c",
  ];
  assert.equal(normalizeEditorPlan(tooManyFields).tasks[0].operations[0].fields.length, 21);
  assert.match(
    validateEditorPlan(normalizeEditorPlan(tooManyFields), inputFixture()).errors.join("\n"),
    /unique string array/
  );
});

test("target-field normalization is generic and never creates an empty driver contract", () => {
  for (const variant of [
    { type: "correlation", capability: "association", targetRubric: ["R5"] },
    { type: "quantileBins", capability: "structural_breakdown", targetRubric: ["R3", "R5"] },
  ]) {
    const plan = reusePlan();
    plan.tasks[0].operations = [{
      id: `${variant.type}-view`,
      type: variant.type,
      targetField: "outcome_c",
      fields: ["factor_a", "outcome_c"],
    }];
    plan.tasks[0].requirements = [{
      id: `${variant.type}-answer`,
      question: "当前样本中的因素与结果呈现什么结构？",
      capability: variant.capability,
      evidenceViewIds: [`${variant.type}-view`],
      targetRubric: variant.targetRubric,
    }];

    assert.match(validateEditorPlan(plan, inputFixture()).errors.join("\n"), /exclude targetField/);
    const normalized = normalizeEditorPlan(plan);
    assert.deepEqual(normalized.tasks[0].operations[0].fields, ["factor_a"]);
    assert.equal(validateEditorPlan(normalized, inputFixture()).ok, true);
    assert.deepEqual(plan.tasks[0].operations[0].fields, ["factor_a", "outcome_c"]);

    const targetOnly = structuredClone(plan);
    targetOnly.tasks[0].operations[0].fields = ["outcome_c"];
    const targetOnlyNormalized = normalizeEditorPlan(targetOnly);
    assert.deepEqual(targetOnlyNormalized.tasks[0].operations[0].fields, []);
    assert.match(
      validateEditorPlan(targetOnlyNormalized, inputFixture()).errors.join("\n"),
      /unique string array/
    );
  }

  const analysisOnly = reusePlan();
  analysisOnly.tasks[0].operations = [{
    id: "association-only",
    type: "correlation",
    targetField: "outcome_c",
    fields: ["factor_a"],
  }];
  analysisOnly.tasks[0].requirements = [{
    id: "association-answer",
    question: "因素和结果在当前样本内有何关联？",
    capability: "association",
    evidenceViewIds: ["association-only"],
    targetRubric: ["R5"],
  }];
  assert.equal(validateEditorPlan(analysisOnly, inputFixture()).ok, true);
  assert.deepEqual(
    compileEditorArtifacts(analysisOnly, inputFixture()).tasks.tasks[0].evidencePlan.requiredColumns,
    ["factor_a", "outcome_c"]
  );
});

test("normalization keeps analysis views partitioned by target and joint driver pair", () => {
  const plan = reusePlan();
  plan.tasks[0].operations = [
    {
      id: "outcome-bins",
      type: "quantileBins",
      targetField: "outcome_c",
      fields: ["factor_a"],
      binCount: 4,
    },
    {
      id: "factor-b-bins",
      type: "quantileBins",
      targetField: "factor_b",
      fields: ["factor_a"],
      binCount: 4,
    },
    {
      id: "joint-a",
      type: "jointQuantileBins",
      targetField: "outcome_c",
      fields: ["factor_a", "factor_b"],
      direction: "desc",
    },
    {
      id: "joint-b",
      type: "jointQuantileBins",
      targetField: "outcome_c",
      fields: ["period_key", "factor_b"],
      direction: "desc",
    },
  ];
  plan.tasks[0].requirements = plan.tasks[0].operations.map((operation, index) => ({
    id: `partitioned-answer-${index + 1}`,
    question: `第 ${index + 1} 个结构视图回答什么？`,
    capability: "structural_breakdown",
    evidenceViewIds: [operation.id],
    targetRubric: ["R3", "R5"],
  }));

  const normalized = normalizeEditorPlan(plan);
  assert.deepEqual(
    normalized.tasks[0].operations.map((operation) => operation.id),
    ["outcome-bins", "factor-b-bins", "joint-a", "joint-b"]
  );
  assert.deepEqual(
    normalized.tasks[0].requirements.map((requirement) => requirement.evidenceViewIds),
    [["outcome-bins"], ["factor-b-bins"], ["joint-a"], ["joint-b"]]
  );
  assert.equal(validateEditorPlan(normalized, inputFixture()).ok, true);
});

test("jointQuantileBins is a strict two-driver observed-combination contract", () => {
  const plan = reusePlan();
  plan.tasks[0].operations = [{
    id: "joint-balance",
    type: "jointQuantileBins",
    targetField: "outcome_c",
    fields: ["factor_a", "factor_b"],
    direction: "desc",
    binCount: 4,
  }];
  plan.tasks[0].requirements = [{
    id: "answer-joint",
    question: "两个因素的哪个已观测组合区间对应更好的结果？",
    capability: "joint_tradeoff",
    evidenceViewIds: ["joint-balance"],
    targetRubric: ["R1", "R5"],
  }];
  assert.match(validateEditorPlan(plan, inputFixture()).errors.join("\n"), /targetRubric must include R3/);
  plan.tasks[0].requirements[0].targetRubric.push("R3");
  assert.equal(validateEditorPlan(plan, inputFixture()).ok, true);

  const jointWithQualityBoundary = structuredClone(plan);
  jointWithQualityBoundary.tasks[0].requirements.push({
    id: "answer-joint-quality",
    question: "联合视图的完整性边界是否影响解释？",
    capability: "data_quality",
    evidenceViewIds: ["joint-balance"],
    targetRubric: ["R4", "R6"],
  });
  assert.equal(validateEditorPlan(jointWithQualityBoundary, inputFixture()).ok, true);
  const compiledJoint = compileEditorArtifacts(jointWithQualityBoundary, inputFixture()).tasks.tasks[0];
  assert.deepEqual(compiledJoint.targetRubric, ["R1", "R3", "R4", "R5", "R6"]);
  assert.deepEqual(compiledJoint.analysisRequirements[1].targetRubric, ["R4", "R6"]);
  const shallowJointWithQuality = structuredClone(jointWithQualityBoundary);
  shallowJointWithQuality.tasks[0].requirements[0].targetRubric = ["R1", "R5"];
  assert.match(
    validateEditorPlan(shallowJointWithQuality, inputFixture()).errors.join("\n"),
    /targetRubric must include R3/
  );

  const missingDirection = structuredClone(plan);
  delete missingDirection.tasks[0].operations[0].direction;
  assert.match(validateEditorPlan(missingDirection, inputFixture()).errors.join("\n"), /missing, extra, or aliased keys/);

  const wrongArity = structuredClone(plan);
  wrongArity.tasks[0].operations[0].fields = ["factor_a"];
  assert.match(validateEditorPlan(wrongArity, inputFixture()).errors.join("\n"), /exactly two driver fields/);

  const tooManyBins = structuredClone(plan);
  tooManyBins.tasks[0].operations[0].binCount = 6;
  assert.match(validateEditorPlan(tooManyBins, inputFixture()).errors.join("\n"), /binCount must be at most 5/);

  const selfTarget = structuredClone(plan);
  selfTarget.tasks[0].operations[0].fields[1] = "outcome_c";
  assert.match(validateEditorPlan(selfTarget, inputFixture()).errors.join("\n"), /exclude targetField/);
});

test("generic balance and trade-off questions cannot pass with a one-sided maximum plan", () => {
  const input = inputFixture();
  input.userQuestion = "两个候选因素如何权衡，哪个已观测组合更合适？";
  const shallow = reusePlan();
  assert.match(
    validateEditorPlan(shallow, input).errors.join("\n"),
    /requires a joint_tradeoff requirement/
  );

  const joint = reusePlan();
  joint.tasks[0].operations = [{
    id: "joint-decision",
    type: "jointQuantileBins",
    targetField: "outcome_c",
    fields: ["factor_a", "factor_b"],
    direction: "desc",
  }];
  joint.tasks[0].requirements = [{
    id: "answer-joint-decision",
    question: "哪个两个因素的已观测组合区间对应更好的结果？",
    capability: "joint_tradeoff",
    evidenceViewIds: ["joint-decision"],
    targetRubric: ["R1", "R3", "R5"],
  }];
  assert.deepEqual(validateEditorPlan(joint, input).errors, []);
});

test("capability, structural views, and material query gaps enforce generic rubric floors", () => {
  const association = reusePlan();
  association.tasks[0].requirements[1].targetRubric = ["R1"];
  assert.match(validateEditorPlan(association, inputFixture()).errors.join("\n"), /include R5/);

  const basicDistribution = reusePlan();
  basicDistribution.tasks[0].operations = [{
    id: "basic-stats",
    type: "stats",
    fields: ["factor_a", "outcome_c"],
  }];
  basicDistribution.tasks[0].requirements = [{
    id: "answer-basic-distribution",
    question: "现有样本的基础分布如何？",
    capability: "distribution",
    evidenceViewIds: ["basic-stats"],
    targetRubric: ["R1"],
  }];
  assert.equal(validateEditorPlan(basicDistribution, inputFixture()).ok, true);

  const structuralDistribution = reusePlan();
  structuralDistribution.tasks[0].operations = [{
    id: "factor-bins",
    type: "quantileBins",
    targetField: "outcome_c",
    fields: ["factor_a"],
  }];
  structuralDistribution.tasks[0].requirements = [{
    id: "answer-structure",
    question: "不同区间的结果结构如何？",
    capability: "structural_breakdown",
    evidenceViewIds: ["factor-bins"],
    targetRubric: ["R3"],
  }];
  assert.match(validateEditorPlan(structuralDistribution, inputFixture()).errors.join("\n"), /include R5/);
  structuralDistribution.tasks[0].requirements[0].targetRubric.push("R5");
  assert.equal(validateEditorPlan(structuralDistribution, inputFixture()).ok, true);

  const structuralWithQualityBoundary = structuredClone(structuralDistribution);
  structuralWithQualityBoundary.tasks[0].requirements.push({
    id: "answer-structure-quality",
    question: "结构视图中的完整性边界是否影响解释？",
    capability: "data_quality",
    evidenceViewIds: ["factor-bins"],
    targetRubric: ["R4", "R6"],
  });
  assert.equal(validateEditorPlan(structuralWithQualityBoundary, inputFixture()).ok, true);
  structuralWithQualityBoundary.tasks[0].requirements[0].targetRubric = ["R1"];
  assert.match(
    validateEditorPlan(structuralWithQualityBoundary, inputFixture()).errors.join("\n"),
    /targetRubric must include R3[\s\S]*targetRubric must include R5/
  );

  const indicatorQuery = newQueryPlan();
  indicatorQuery.tasks[0].evidenceGap = {
    types: ["missing_dimension", "missing_indicator"],
    reason: "需要新增分组维度与结果指标",
  };
  indicatorQuery.tasks[0].candidateIndicators = ["prospective-indicator"];
  assert.match(validateEditorPlan(indicatorQuery, inputFixture()).errors.join("\n"), /include R4/);
  indicatorQuery.tasks[0].requirements[0].targetRubric.push("R4");
  assert.equal(validateEditorPlan(indicatorQuery, inputFixture()).ok, true);
});

test("empty reuse sources require a field-free project and no-data coverage", () => {
  const input = inputFixture({ empty: true });
  const plan = reusePlan();
  plan.tasks[0].operations = [{ id: "empty-result", type: "project", fields: [] }];
  plan.tasks[0].requirements = [{
    id: "answer-empty",
    question: "确认范围内是否返回匹配明细？",
    capability: "no_data",
    evidenceViewIds: ["empty-result"],
    targetRubric: ["R1", "R4"],
  }];
  assert.deepEqual(validateEditorPlan(plan, input).errors, []);
  const invalid = structuredClone(plan);
  invalid.tasks[0].operations[0].fields = ["guessed_field"];
  assert.match(validateEditorPlan(invalid, input).errors.join("\n"), /field-free project/);
});

test("new_query accepts prospective fields only with a typed material gap and required candidates", () => {
  const input = inputFixture();
  const plan = newQueryPlan();
  assert.deepEqual(validateEditorPlan(plan, input).errors, []);

  const missingCandidate = structuredClone(plan);
  missingCandidate.tasks[0].candidateDims = [];
  assert.match(validateEditorPlan(missingCandidate, input).errors.join("\n"), /requires candidateDims/);
  const badGap = structuredClone(plan);
  badGap.tasks[0].evidenceGap = null;
  assert.match(validateEditorPlan(badGap, input).errors.join("\n"), /valid typed evidenceGap/);
});

test("empty task plans are allowed only when every source is zero-row with typed no_data coverage", () => {
  const input = inputFixture();
  const writerFindingBypass = {
    version: 1,
    tasks: [],
    answerRequirements: [{
      id: "direct-record",
      question: "指定记录是什么？",
      capability: "record",
      coverage: { kind: "writer_finding", cardId: "card-a", findingIndex: 0 },
    }],
    noDeeperReason: "Writer 已给出题面要求的单条记录",
  };
  assert.match(
    validateEditorPlan(writerFindingBypass, input).errors.join("\n"),
    /every Planner source.*zero-row[\s\S]*coverage\.kind must be empty_source/
  );
  assert.equal(validateEditorPlan({ ...writerFindingBypass, noDeeperReason: null }, input).ok, false);
  assert.match(
    validateEditorPlan({ version: 1, tasks: [], noDeeperReason: "仅凭文字声称完整" }, input).errors.join("\n"),
    /answerRequirements/
  );

  const emptyInput = inputFixture({ empty: true });
  emptyInput.userQuestion = "确认范围内是否有匹配明细？";
  const noData = {
    version: 1,
    tasks: [],
    answerRequirements: [{
      id: "direct-no-data",
      question: "确认范围内是否有匹配明细？",
      capability: "no_data",
      coverage: { kind: "empty_source", cardId: "card-a", findingIndex: null },
    }],
    noDeeperReason: "已验证的零行源直接回答无数据问题",
  };
  assert.equal(validateEditorPlan(noData, emptyInput).ok, true);
  assert.deepEqual(
    compileEditorArtifacts(noData, emptyInput).tasks.editorial.directAnswerRequirements,
    noData.answerRequirements,
    "the machine-checkable zero-row proof must remain in tasks.json for audit"
  );
  assert.match(
    validateEditorPlan(noData, input).errors.join("\n"),
    /every Planner source.*zero-row[\s\S]*requires a validated zero-row source/
  );

  const twoEmptySources = structuredClone(emptyInput);
  const secondCard = structuredClone(twoEmptySources.cards[0]);
  secondCard.id = "card-b";
  secondCard.source.cardId = "card-b";
  twoEmptySources.cards.push(secondCard);
  assert.match(
    validateEditorPlan(noData, twoEmptySources).errors.join("\n"),
    /typed no_data coverage.*missing card=card-b/
  );
  const completeNoData = structuredClone(noData);
  completeNoData.answerRequirements.push({
    id: "direct-no-data-b",
    question: "另一个确认范围内是否有匹配明细？",
    capability: "no_data",
    coverage: { kind: "empty_source", cardId: "card-b", findingIndex: null },
  });
  assert.equal(validateEditorPlan(completeNoData, twoEmptySources).ok, true);

  const wrongCapability = structuredClone(noData);
  wrongCapability.answerRequirements[0].capability = "distribution";
  assert.match(validateEditorPlan(wrongCapability, emptyInput).errors.join("\n"), /prove only capability=no_data/);

  const schema = buildEditorPlanSchema(input);
  assert.equal(schema.type, "object");
  assert.deepEqual(
    schema.properties.noDeeperReason.oneOf,
    [{ type: "null" }, { type: "string" }],
    "null must stay first so Pi tool-argument coercion preserves JSON null"
  );
  assert.deepEqual(schema.oneOf[0].properties.noDeeperReason, { type: "null" });
  assert.equal(schema.oneOf[0].properties.tasks.minItems, 1);
  assert.equal(schema.oneOf[0].properties.answerRequirements.maxItems, 0);
  assert.equal(schema.oneOf[1].properties.noDeeperReason.minLength, 1);
  assert.equal(schema.oneOf[1].properties.tasks.maxItems, 0);
  assert.equal(schema.oneOf[1].properties.answerRequirements.minItems, 1);
  assert.equal(schema.properties.tasks.items.properties.operations.items.type, "object");
  assert.equal(schema.properties.tasks.items.properties.operations.maxItems, 6);
  assert.equal(
    schema.properties.answerRequirements.items.properties.coverage.properties.kind.const,
    "empty_source"
  );
  assert.equal(schema.properties.answerRequirements.items.properties.capability.const, "no_data");
  assert.deepEqual(
    schema.properties.answerRequirements.items.properties.coverage.properties.findingIndex,
    { type: "null" }
  );
  assert.equal(
    Object.hasOwn(schema.properties.tasks.items.properties.requirements.items.properties, "minScore"),
    false,
    "Planner must not be able to lower the fixed score-2 quality gate"
  );
  const [reuseBranch, newQueryBranch] = schema.properties.tasks.items.oneOf;
  assert.equal(reuseBranch.properties.mode.const, "reuse_entry");
  assert.deepEqual(reuseBranch.properties.evidenceGap, { type: "null" });
  assert.equal(reuseBranch.properties.candidateIndicators.maxItems, 0);
  assert.equal(reuseBranch.properties.candidateDims.maxItems, 0);
  assert.equal(newQueryBranch.properties.mode.const, "new_query");
  assert.ok(newQueryBranch.properties.evidenceGap.oneOf, "new_query must expose the typed non-null gap schema");
  assert.ok(JSON.stringify(schema).length < 10_000, "Planner schema must remain compact enough for child startup");
  const nodes = [schema];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== "object") continue;
    assert.equal(Array.isArray(node.type), false, "Planner schema must avoid provider-incompatible union type arrays");
    nodes.push(...Object.values(node));
  }
});

test("semantic validation fails closed for malformed nested Planner values", () => {
  const malformed = reusePlan();
  malformed.tasks[0].candidateIndicators = null;
  malformed.tasks[0].candidateDims = "not-an-array";
  malformed.tasks[0].operations = [null];
  malformed.tasks[0].requirements = null;
  let checked;
  assert.doesNotThrow(() => {
    checked = validateEditorPlan(malformed, inputFixture());
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("\n"), /candidateIndicators|operations|requirements/);
});

test("Planner cache is result-fingerprinted and builds compact authoritative input", async () => {
  assert.equal(persistEditorSourceInventory, persistKernelSourceInventory);
  const session = await mkdtemp(join(tmpdir(), "html-report-editor-plan-cache-"));
  const resultPath = join(session, "result.json");
  const rowsSha256 = "b".repeat(64);
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    title: "中性报告",
    userQuestion: "比较观测组合",
    cards: [{
      id: "card-a",
      title: "中性卡片",
      analysisFocus: "中性分析",
      query: {
        request: {
          metrics: ["metric-a"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-01-01", endDate: "2026-01-31" },
          dimensions: ["period-key"],
          filters: {},
        },
        comparisons: [],
      },
    }],
  }));
  persistEditorSourceInventory(resultPath, {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    mode: "source_fields",
    sources: [{
      cardId: "card-a",
      status: "available",
      rowCount: 1,
      rowsSha256,
      empty: false,
      fieldInventoryStatus: "validated",
      availableFields: ["period_key", "metric_value"],
      profile: {},
      dataQuality: {},
    }],
  });
  persistEditorWriterReturn(resultPath, {
    cardId: "card-a",
    fetchStatus: "success",
    dataPath: join(session, "data", "cards", "card-a", "entry.json"),
    metaPath: join(session, "data", "cards", "card-a", "entry.meta.json"),
    analysis: {
      summary: "已取得明细",
      findings: [{ statement: "起点", evidence: ["entry.json#/0"] }],
      recommendations: ["继续比较"],
    },
  });
  const input = loadEditorPlannerInput(resultPath);
  assert.equal(input.userQuestion, "比较观测组合");
  assert.deepEqual(input.cards[0].source.availableFields, ["period_key", "metric_value"]);
  const expected = editorPlannerExpectedFromAssignment(
    `HTML_REPORT_EDITOR_PLAN_V1\nSESSION=${session}\nresult.json=${resultPath}`,
    { sessionDir: session }
  );
  assert.equal(Object.hasOwn(expected, "error"), false);
  assert.match(expected.assignment, /COMPACT EDITOR INPUT JSON/);
  assert.match(EDITOR_PLANNER_SYSTEM_PROMPT, /one silent pass: gap -> mode -> smallest operations -> requirements -> verify -> submit/i);
  assert.match(EDITOR_PLANNER_SYSTEM_PROMPT, /Do not translate or restate input\/schema, compare alternatives/i);
  const planningContract = expected.assignment.slice(expected.assignment.indexOf("PLANNING CONTRACT:"));
  assert.ok(planningContract.length < 4_500, `Planner contract must stay compact; received ${planningContract.length} chars`);
  assert.match(planningContract, /tasks=\[\][\s\S]*every source is a validated zero-row source[\s\S]*capability=no_data[\s\S]*empty_source/i);
  assert.match(planningContract, /Writer row finding[\s\S]*never bypasses B3[\s\S]*non-empty sources/i);
  assert.match(planningContract, /at most six non-overlapping operations[\s\S]*single consolidated task for one source/i);
  assert.match(planningContract, /Reuse available rows[\s\S]*use new_query only for a material missing indicator/i);
  assert.match(planningContract, /Derived analysis over available fields is reuse_entry, not an evidenceGap/i);
  assert.match(planningContract, /copy source\.availableFields names verbatim/i);
  assert.match(expected.assignment, /comparison=compare\|compareTopN/);
  assert.match(expected.assignment, /structural_breakdown=groupBy\|quantileBins\|jointQuantileBins/);
  assert.match(expected.assignment, /joint_tradeoff=jointQuantileBins/);
  assert.match(planningContract, /sort\/topN\/bottomN require field \(never sortBy\)/);
  assert.match(planningContract, /subsetStats\/compare\/compareTopN require sortBy \(never field\)/);
  assert.match(planningContract, /sort\/topN\/bottomN select records[\s\S]*compare\/compareTopN compare selected versus remaining rows/i);
  assert.match(planningContract, /B2 already contains the full detail table/);
  assert.match(planningContract, /Requirements ask for decisions or interpretations, not row enumeration/);
  assert.match(expected.assignment, /missing\/null\/blank exclusions or zero-value sensitivity/);
  assert.match(expected.assignment, /Never label reliability high\/low without explicit threshold metadata/);
  assert.match(expected.assignment, /R1=directly answer the user question/);
  assert.match(expected.assignment, /R7=faithfulness to the confirmed scope/);
  assert.match(expected.assignment, /fixed score-2 quality gate/);
  assert.match(expected.assignment, /Required rubric floor: comparison=>R5; basic distribution stats\/range=>no automatic R3\/R5 floor; association=>R5; groupBy\/quantileBins\/jointQuantileBins=>R3\+R5/);
  assert.match(expected.assignment, /separate quantileBins winners cannot prove it/);
  assert.match(expected.assignment, /use jointQuantileBins with direction=desc/);
  assert.match(
    expected.assignment,
    /balance\/trade-off\/best point[\s\S]*words alone do not request dates, records, or ranking[\s\S]*never add sort\/topN\/bottomN or a ranking requirement unless the user explicitly asks/i
  );
  assert.match(expected.assignment, /best observed complete-case cells, never a global optimum/);
  assert.doesNotMatch(planningContract, /Exact operation key contract/);
  assert.doesNotMatch(planningContract, /Every requirements\[\]\.evidenceViewIds item must exactly equal/);
  assert.doesNotMatch(planningContract, /reuse_entry requires evidenceGap=null, candidateIndicators=\[\], and candidateDims=\[\]/);
  assert.doesNotMatch(planningContract, /Merge operations with the same type/);

  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [{ id: "card-a", query: { request: {}, comparisons: [] } }], title: "changed" }));
  assert.throws(() => loadEditorPlannerInput(resultPath), /stale|provenance/);
});

test("materializer validates before writing and delegates one deterministic finalization", async () => {
  const session = await mkdtemp(join(tmpdir(), "html-report-editor-materialize-"));
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, "{}\n");
  const calls = [];
  const output = await materializeEditorPlan(resultPath, reusePlan(), {
    input: inputFixture(),
    finalizeEditorStage: async (path) => {
      calls.push(path);
      const tasksPath = join(session, "analysis", "tasks.json");
      const document = JSON.parse(await readFile(tasksPath, "utf8"));
      document.tasks = document.tasks.map((task) => ({
        ...task,
        analysisContractVersion: 1,
      }));
      await writeFile(tasksPath, `${JSON.stringify(document, null, 2)}\n`);
      return {
        ok: true,
        evidence: {
          prepared: [{ taskId: "drill-001", evidencePath: join(session, "analysis", "evidence", "drill-001.json") }],
          deferred: [],
        },
      };
    },
  });
  assert.deepEqual(calls, [resultPath]);
  assert.equal(output.taskCount, 1);
  assert.equal(output.researchTasks.length, 1);
  assert.equal(output.researchTasks[0].task.id, "drill-001");
  assert.equal(output.researchTasks[0].task.analysisContractVersion, 1);
  assert.equal(output.researchTasks[0].evidencePath, join(session, "analysis", "evidence", "drill-001.json"));
  const persistedTask = JSON.parse(
    await readFile(join(session, "analysis", "tasks.json"), "utf8")
  ).tasks[0];
  assert.deepEqual(output.researchTasks[0].task, persistedTask);
  assert.match(await readFile(join(session, "analysis", "main.md"), "utf8"), /待 B3 Researcher 结论/);

  // P2-2 regression: main.md must render date and filter scope from new queryCoverage structure
  assert.match(await readFile(join(session, "analysis", "main.md"), "utf8"), /日期 2026-01-01 至 2026-01-31/);
  assert.match(await readFile(join(session, "analysis", "main.md"), "utf8"), /筛选 entity-key=entity-a/);

  const newQuerySession = await mkdtemp(join(tmpdir(), "html-report-editor-materialize-new-query-"));
  const newQueryResult = join(newQuerySession, "result.json");
  await writeFile(newQueryResult, "{}\n");
  const newQueryOutput = await materializeEditorPlan(newQueryResult, newQueryPlan(), {
    input: inputFixture(),
    finalizeEditorStage: async () => ({
      ok: true,
      evidence: {
        prepared: [],
        deferred: [{ taskId: "drill-001", evidenceMode: "new_query" }],
      },
    }),
  });
  assert.equal(
    newQueryOutput.researchTasks[0].evidencePath,
    join(newQuerySession, "analysis", "evidence", "drill-001.json")
  );

  const badSession = await mkdtemp(join(tmpdir(), "html-report-editor-materialize-bad-"));
  const badResult = join(badSession, "result.json");
  await writeFile(badResult, "{}\n");
  const invalid = reusePlan();
  invalid.tasks[0].operations[0].fields.push("unknown_field");
  await assert.rejects(
    materializeEditorPlan(badResult, invalid, { input: inputFixture(), finalizeEditorStage: async () => ({ ok: true }) }),
    /Planner return is invalid/
  );
  await assert.rejects(readFile(join(badSession, "analysis", "tasks.json")), /ENOENT/);
});

test("Planner implementation contains no fixed business-test literals", async () => {
  const paths = [
    new URL("../scripts/editor-plan-contract.mjs", import.meta.url),
    new URL("../scripts/editor-plan.mjs", import.meta.url),
    new URL("../scripts/prepare-research-evidence.mjs", import.meta.url),
    new URL("../scripts/submit-research-findings.mjs", import.meta.url),
    new URL("../scripts/finalize-research-stage.mjs", import.meta.url),
    new URL("../../../extensions/report-researcher-guard/guard.mjs", import.meta.url),
    new URL("../../../extensions/report-researcher-guard/index.mjs", import.meta.url),
    new URL("../agents/report-researcher.md", import.meta.url),
    new URL("../../../agents/report-researcher.md", import.meta.url),
  ];
  const source = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
  for (const literal of [
    "101001",
    "custNum",
    "perCustAmt",
    "profitAmt",
    "debug-store-balance",
    "客数",
    "客流",
    "客单",
    "毛利",
  ]) {
    assert.equal(source.includes(literal), false, `unexpected fixed literal: ${literal}`);
  }
});
