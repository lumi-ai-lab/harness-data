import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSourceFieldMetadata,
  canonicalizeJson,
  compactDecisionQueryScope,
  executeEvidenceOperations,
  MIN_JOINT_CELL_SUPPORT,
  prepareResearchEvidence,
  prepareSourceFieldInventory,
  rowsSha256,
  validateEvidenceFieldReferences,
} from "../scripts/prepare-research-evidence.mjs";
import { metricQueryFromCard, normalizeMetricQuery } from "../scripts/metric-query-contract.mjs";
import { computeQueryPatch, applyQueryPatch } from "../scripts/fetch-explore.mjs";

function fingerprintJson(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function sourceCard() {
  return {
    id: "c1",
    query: {
      request: {
        metrics: ["profitAmt"],
        statisticPolicy: "SUMMARY",
        time: { startDate: "2026-07-01", endDate: "2026-07-31" },
        dimensions: ["incDate"],
        filters: {},
      },
      comparisons: [],
    },
  };
}

test("rowsSha256 matches Metric CLI RFC 8785 fixture", () => {
  const rows = [{ b: 2, a: "x" }, { a: "y", b: 1 }];
  assert.equal(canonicalizeJson(rows), '[{"a":"x","b":2},{"a":"y","b":1}]');
  assert.equal(rowsSha256(rows), "b33e3daec35e0d408ffa081470a9f4aa52a07350cc41b4fe31526f54aeb28130");
});

test("decision query scope keeps only traceable date and filter identities", () => {
  assert.deepEqual(compactDecisionQueryScope({
    time: { startDate: "2026-07-01", endDate: "2026-07-31" },
    filters: { storeId: ["101001"] },
    metrics: ["profitAmt"],
  }), {
    dateRange: { startDate: "2026-07-01", endDate: "2026-07-31" },
    filters: [{ field: "storeId", values: ["101001"] }],
  });
  assert.equal(compactDecisionQueryScope({ metrics: ["profitAmt"] }), null);
});

test("fixed evidence operations return compact rows and deterministic stats", () => {
  const rows = [
    { 日期: "07-01", 客数: 10, 客单: 20, 毛利额: 100 },
    { 日期: "07-02", 客数: 20, 客单: 18, 毛利额: 300 },
    { 日期: "07-03", 客数: 30, 客单: 16, 毛利额: 200 },
  ];
  const views = executeEvidenceOperations(rows, [
    { id: "top-profit", type: "topN", field: "毛利额", count: 2, fields: ["日期", "客数", "客单", "毛利额"] },
    { id: "balance", type: "compareTopN", sortBy: "毛利额", count: 1, fields: ["客数", "客单"] },
    { id: "all-stats", type: "stats", fields: ["客数", "客单"] },
  ]);
  assert.equal(views["top-profit"].rows[0].sourcePointer, "/1");
  assert.deepEqual(views["top-profit"].rows.map((item) => item.rank), [1, 2]);
  assert.equal(views["top-profit"].rows[0].row.毛利额, 300);
  assert.equal(views.balance.selectedRows[0].rank, 1);
  assert.equal(views.balance.selectedStats.客数.mean, 20);
  assert.equal(views.balance.remainingStats.客数.mean, 20);
  assert.deepEqual(views.balance.selectedStats.客数.comparisonToRemaining, {
    remainingCount: 2,
    remainingMean: 20,
    remainingMeanDisplay: 20,
    meanDelta: 0,
    meanDeltaDisplay: 0,
    direction: "equal",
  });
  assert.equal(views["all-stats"].stats.客单.median, 18);
});

test("compareTopN emits deterministic mean deltas for Researcher citations", () => {
  const rows = [
    { 日期: "selected", 毛利额: 300, 客单价: 17.966 },
    { 日期: "remaining", 毛利额: 100, 客单价: 17.760455 },
  ];
  const views = executeEvidenceOperations(rows, [{
    id: "comparison",
    type: "compareTopN",
    sortBy: "毛利额",
    count: 1,
    fields: ["客单价"],
  }]);
  assert.deepEqual(views.comparison.population, {
    sourceRows: 2,
    whereApplied: false,
    matchedRows: 2,
    selectedCount: 1,
    remainingCount: 1,
  });
  assert.deepEqual(views.comparison.selectedStats.客单价.comparisonToRemaining, {
    remainingCount: 1,
    remainingMean: 17.760455,
    remainingMeanDisplay: 17.76,
    meanDelta: 0.205545,
    meanDeltaDisplay: 0.206,
    direction: "higher",
  });
});

test("ascending and descending evidence sorts always place empty cells last", () => {
  const rows = [
    { id: "null", value: null },
    { id: "undefined" },
    { id: "empty", value: "" },
    { id: "blank", value: "   " },
    { id: "one", value: 100 },
    { id: "two", value: 200 },
    { id: "zero", value: 0 },
  ];
  const views = executeEvidenceOperations(rows, [
    { id: "descending", type: "sort", field: "value", direction: "desc", count: 7, fields: ["id", "value"] },
    { id: "ascending", type: "sort", field: "value", direction: "asc", count: 7, fields: ["id", "value"] },
  ]);
  assert.deepEqual(
    views.descending.rows.map((item) => item.row.id),
    ["two", "one", "zero", "null", "undefined", "empty", "blank"]
  );
  assert.deepEqual(
    views.ascending.rows.map((item) => item.row.id),
    ["zero", "one", "two", "null", "undefined", "empty", "blank"]
  );
  assert.deepEqual(views.descending.rows.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(views.ascending.rows.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7]);
});

test("ordered evidence exposes deterministic rank while project preserves source-order semantics", () => {
  const rows = [
    { id: "a", value: 10 },
    { id: "b", value: 30 },
    { id: "c", value: 20 },
  ];
  const views = executeEvidenceOperations(rows, [
    { id: "top", type: "topN", field: "value", count: 2, fields: ["id", "value"] },
    { id: "bottom", type: "bottomN", field: "value", count: 2, fields: ["id", "value"] },
    { id: "comparison", type: "compareTopN", sortBy: "value", count: 2, fields: ["id", "value"] },
    { id: "source", type: "project", count: 2, fields: ["id", "value"] },
  ]);

  assert.deepEqual(
    views.top.rows.map(({ rank, row }) => ({ rank, id: row.id })),
    [{ rank: 1, id: "b" }, { rank: 2, id: "c" }]
  );
  assert.deepEqual(
    views.bottom.rows.map(({ rank, row }) => ({ rank, id: row.id })),
    [{ rank: 1, id: "a" }, { rank: 2, id: "c" }]
  );
  assert.deepEqual(views.comparison.selectedRows.map((item) => item.rank), [1, 2]);
  assert.equal(Object.hasOwn(views.source.rows[0], "rank"), false);
});

test("compareTopN excludes a null sort cell when five non-empty rows fill count=5", () => {
  const rows = [
    { 日期: "null-day", 客单价: null, 来客数: 999 },
    { 日期: "d1", 客单价: 50, 来客数: 10 },
    { 日期: "d2", 客单价: 40, 来客数: 20 },
    { 日期: "d3", 客单价: 30, 来客数: 30 },
    { 日期: "d4", 客单价: 20, 来客数: 40 },
    { 日期: "d5", 客单价: 10, 来客数: 50 },
  ];
  const views = executeEvidenceOperations(rows, [{
    id: "top-ticket",
    type: "compareTopN",
    sortBy: "客单价",
    count: 5,
    fields: ["日期", "客单价", "来客数"],
  }]);
  assert.equal(
    views["top-ticket"].selectedRows.some((item) => item.row.客单价 == null),
    false
  );
  assert.equal(views["top-ticket"].selectedStats.来客数.mean, 30);
});

test("source metadata profiles null, numeric, zero, and incomplete required rows without exclusion", () => {
  const rows = [
    { required: 1, measure: 0, mixed: null },
    { required: null, measure: "0", mixed: "" },
    { measure: "not-numeric", mixed: "12.5%" },
    { required: 5, measure: 2 },
  ];
  const metadata = buildSourceFieldMetadata(rows, ["required", "mixed"]);
  assert.deepEqual(metadata.profile.fields.required, {
    presentCount: 3,
    missingCount: 1,
    nullCount: 1,
    blankCount: 0,
    numericCount: 2,
    zeroCount: 0,
    nonNumericValueCount: 0,
  });
  assert.deepEqual(metadata.profile.fields.measure, {
    presentCount: 4,
    missingCount: 0,
    nullCount: 0,
    blankCount: 0,
    numericCount: 3,
    zeroCount: 2,
    nonNumericValueCount: 1,
  });
  assert.equal(metadata.dataQuality.completeRequiredRowCount, 0);
  assert.equal(metadata.dataQuality.incompleteRequiredRowCount, 4);
  assert.deepEqual(metadata.dataQuality.incompleteRequiredRows.rows, [
    { sourcePointer: "/0", fields: { mixed: "null" } },
    { sourcePointer: "/1", fields: { required: "null", mixed: "blank" } },
    { sourcePointer: "/2", fields: { required: "missing" } },
    { sourcePointer: "/3", fields: { mixed: "missing" } },
  ]);
  assert.equal(metadata.profile.rowCount, rows.length);
  assert.equal(metadata.fieldCoverage.required.nullCount, 2);
  assert.equal(
    fingerprintJson(metadata),
    fingerprintJson(buildSourceFieldMetadata(rows, ["mixed", "required"]))
  );
});

test("correlation is deterministic, honors where, and reports every pairwise exclusion", () => {
  const rows = [
    { segment: "keep", target: 2, driver: 1, inverse: 4, constant: 7 },
    { segment: "keep", target: 4, driver: 2, inverse: 3, constant: 7 },
    { segment: "keep", target: 6, driver: 3, inverse: 2, constant: 7 },
    { segment: "keep", target: 8, driver: 4, inverse: 1, constant: 7 },
    { segment: "keep", target: null, driver: 5, inverse: 0, constant: 7 },
    { segment: "keep", target: 10, driver: "bad", inverse: "bad", constant: 7 },
    { segment: "keep", target: null, driver: null, inverse: null, constant: null },
    { segment: "drop", target: 999, driver: 999, inverse: 999, constant: 999 },
  ];
  const operations = [{
    id: "relationships",
    type: "correlation",
    targetField: "target",
    fields: ["driver", "inverse", "constant"],
    where: [{ field: "segment", op: "eq", value: "keep" }],
  }];
  const first = executeEvidenceOperations(rows, operations);
  const second = executeEvidenceOperations(rows, operations);
  assert.deepEqual(first, second);
  assert.equal(fingerprintJson(first), fingerprintJson(second));
  assert.deepEqual(first.relationships.population, {
    sourceRows: 8,
    whereApplied: true,
    matchedRows: 7,
  });
  assert.equal(first.relationships.method, "pearson_pairwise_complete");
  assert.deepEqual(first.relationships.interpretation, {
    scope: "observed_matched_sample",
    supportsCausality: false,
    supportsSignificance: false,
  });
  assert.equal(first.relationships.correlations.driver.coefficient, 1);
  assert.deepEqual(first.relationships.correlations.driver.zeroValueSensitivity, {
    applied: false,
    reason: "no_zero_value_pairs",
  });
  assert.equal(first.relationships.correlations.inverse.coefficient, -1);
  assert.equal(first.relationships.correlations.constant.status, "zero_variance");
  assert.equal(first.relationships.correlations.constant.coefficient, null);
  assert.deepEqual(first.relationships.correlations.driver.exclusions, {
    count: 3,
    reasons: {
      targetOnlyNonNumeric: 1,
      fieldOnlyNonNumeric: 1,
      bothNonNumeric: 1,
    },
    cellReasons: {
      target: { missing: 0, null: 2, blank: 0, nonNumeric: 0 },
      field: { missing: 0, null: 1, blank: 0, nonNumeric: 1 },
    },
    sourcePointers: ["/4", "/5", "/6"],
    pointersTruncated: false,
  });
});

test("correlation reports a deterministic zero-value sensitivity population without dropping primary rows", () => {
  const rows = [
    { target: 0, driver: 0 },
    { target: 0, driver: 5 },
    { target: 5, driver: 0 },
    { target: 1, driver: 1 },
    { target: 2, driver: 4 },
    { target: 3, driver: 9 },
  ];
  const view = executeEvidenceOperations(rows, [{
    id: "relationship",
    type: "correlation",
    targetField: "target",
    fields: ["driver"],
  }]).relationship.correlations.driver;
  assert.equal(view.eligibleRows, 6, "the primary coefficient must retain legitimate zero values");
  assert.equal(view.zeroValueSensitivity.applied, true);
  assert.equal(view.zeroValueSensitivity.sourceEligibleRows, 6);
  assert.equal(view.zeroValueSensitivity.eligibleRows, 3);
  assert.deepEqual(view.zeroValueSensitivity.exclusions, {
    count: 3,
    reasons: { targetOnlyZero: 1, fieldOnlyZero: 1, bothZero: 1 },
    sourcePointers: ["/0", "/1", "/2"],
    pointersTruncated: false,
  });
  assert.equal(view.zeroValueSensitivity.status, "ok");
  assert.notEqual(view.coefficient, view.zeroValueSensitivity.coefficient);
});

test("where executes the canonical Planner field/op/value contract for all operators", () => {
  const rows = [{ value: 1 }, { value: 2 }, { value: 3 }];
  const matchedRows = (op, value) => executeEvidenceOperations(rows, [{
    id: `where-${op}`,
    type: "project",
    fields: ["value"],
    count: 10,
    where: [{ field: "value", op, value }],
  }])[`where-${op}`].matchedRows;
  assert.equal(matchedRows("eq", 2), 1);
  assert.equal(matchedRows("ne", 2), 2);
  assert.equal(matchedRows("gt", 2), 1);
  assert.equal(matchedRows("gte", 2), 2);
  assert.equal(matchedRows("lt", 2), 1);
  assert.equal(matchedRows("lte", 2), 2);
  assert.equal(matchedRows("in", [1, 3]), 2);
});

test("quantileBins keeps ties together and returns bounded target statistics", () => {
  const rows = [
    { driver: 1, target: 10 },
    { driver: 1, target: 12 },
    { driver: 2, target: 20 },
    { driver: 3, target: 30 },
    { driver: 4, target: 40 },
    { driver: 5, target: 50 },
    { driver: 6, target: 60 },
    { driver: 7, target: 70 },
    { driver: 8, target: null },
    { driver: "bad", target: 80 },
    { driver: null, target: null },
  ];
  const views = executeEvidenceOperations(rows, [{
    id: "quartiles",
    type: "quantileBins",
    targetField: "target",
    fields: ["driver"],
    binCount: 4,
  }]);
  const grid = views.quartiles.grids.driver;
  assert.equal(views.quartiles.method, "equal_frequency_nearest_rank_ties_together");
  assert.equal(views.quartiles.population.matchedRows, 11);
  assert.deepEqual(grid.cutPoints, [1, 3, 5]);
  assert.equal(grid.actualBinCount, 4);
  assert.deepEqual(grid.bins.map((bin) => bin.rowCount), [2, 2, 2, 2]);
  assert.deepEqual(grid.bins.map((bin) => bin.targetStats.mean), [11, 25, 45, 65]);
  assert.deepEqual(grid.exclusions.reasons, {
    targetOnlyNonNumeric: 1,
    fieldOnlyNonNumeric: 1,
    bothNonNumeric: 1,
  });
  assert.ok(grid.bins.every((bin) => bin.sourcePointers.length <= 5));
});

test("jointQuantileBins finds an observed two-driver cell instead of combining marginal winners", () => {
  const rows = [
    { driver_x: 1, driver_y: 1, target: 0 },
    { driver_x: 1, driver_y: 1, target: 0 },
    { driver_x: 1, driver_y: 1, target: 0 },
    { driver_x: 1, driver_y: 2, target: 120 },
    { driver_x: 1, driver_y: 2, target: 120 },
    { driver_x: 1, driver_y: 2, target: 120 },
    { driver_x: 2, driver_y: 1, target: 110 },
    { driver_x: 2, driver_y: 1, target: 110 },
    { driver_x: 2, driver_y: 1, target: 110 },
    { driver_x: 2, driver_y: 2, target: 20 },
    { driver_x: 2, driver_y: 2, target: 20 },
    { driver_x: 2, driver_y: 2, target: 20 },
  ];
  const views = executeEvidenceOperations(rows, [
    {
      id: "marginals",
      type: "quantileBins",
      targetField: "target",
      fields: ["driver_x", "driver_y"],
      binCount: 2,
    },
    {
      id: "joint",
      type: "jointQuantileBins",
      targetField: "target",
      fields: ["driver_x", "driver_y"],
      direction: "desc",
      binCount: 2,
    },
  ]);
  const xBins = views.marginals.grids.driver_x.bins;
  const yBins = views.marginals.grids.driver_y.bins;
  assert.ok(xBins[1].targetStats.mean > xBins[0].targetStats.mean, "x marginal prefers its high bin");
  assert.ok(yBins[1].targetStats.mean > yBins[0].targetStats.mean, "y marginal prefers its high bin");
  assert.equal(views.joint.grid.observedCellCount, 4);
  assert.equal(Object.hasOwn(views.joint, "axes"), false);
  assert.equal(Object.hasOwn(views.joint, "overallTargetStats"), false);
  assert.equal(views.joint.grid.cells[0].cellId, "Q1×Q2");
  assert.equal(views.joint.grid.cells[0].targetStats.mean, 120);
  assert.deepEqual(views.joint.evaluation.bestObservedByMean.cellIds, ["Q1×Q2"]);
  assert.deepEqual(views.joint.evaluation.bestObservedByMedian.cellIds, ["Q1×Q2"]);
  assert.equal(views.joint.evaluation.status, "ok");
  assert.equal(views.joint.evaluation.support.status, "sufficient");
  assert.equal(views.joint.evaluation.stability.status, "mean_median_agree");
  assert.equal(views.joint.interpretation.supportsGlobalOptimum, false);
  assert.deepEqual(views.joint.decisionBrief, {
    answerOrder: ["supportedCandidates", "rawObservedWinners", "stabilityAndLimits"],
    answerStatus: "supported_observed_winner_mean_median_agree",
    recommendedClaim: "在最低支持记录数为3的口径下，均值与中位数均指向driver_x1、driver_y2（3条记录，target均值120、中位数120），可作为样本内优先观察的支持合格组合。经营上，可先把该支持合格组合作为观察区间，并持续核对后续同类记录；低支持组合仅用于跟踪，不直接设为经营基准。",
    targetField: "target",
    driverFields: ["driver_x", "driver_y"],
    direction: "desc",
    population: { eligibleRows: 12, excludedRows: 0 },
    minimumSupportRowCount: 3,
    supportedCandidates: {
      status: "available",
      meanMedianSameCell: true,
      byMean: {
        criterion: "mean",
        tiedCellCount: 1,
        cellId: "Q1×Q2",
        coordinates: {
          driver_x: { ordinal: 1, label: "Q1", min: 1, max: 1 },
          driver_y: { ordinal: 2, label: "Q2", min: 2, max: 2 },
        },
        rowCount: 3,
        supportStatus: "sufficient",
        targetStats: { meanDisplay: 120, medianDisplay: 120 },
      },
      byMedian: {
        criterion: "median",
        tiedCellCount: 1,
        cellId: "Q1×Q2",
        coordinates: {
          driver_x: { ordinal: 1, label: "Q1", min: 1, max: 1 },
          driver_y: { ordinal: 2, label: "Q2", min: 2, max: 2 },
        },
        rowCount: 3,
        supportStatus: "sufficient",
        targetStats: { meanDisplay: 120, medianDisplay: 120 },
      },
    },
    rawObservedWinners: {
      supportSufficient: true,
      meanMedianSameCell: true,
      byMean: {
        criterion: "mean",
        tiedCellCount: 1,
        cellId: "Q1×Q2",
        coordinates: {
          driver_x: { ordinal: 1, label: "Q1", min: 1, max: 1 },
          driver_y: { ordinal: 2, label: "Q2", min: 2, max: 2 },
        },
        rowCount: 3,
        supportStatus: "sufficient",
        targetStats: { meanDisplay: 120, medianDisplay: 120 },
      },
      byMedian: {
        criterion: "median",
        tiedCellCount: 1,
        cellId: "Q1×Q2",
        coordinates: {
          driver_x: { ordinal: 1, label: "Q1", min: 1, max: 1 },
          driver_y: { ordinal: 2, label: "Q2", min: 2, max: 2 },
        },
        rowCount: 3,
        supportStatus: "sufficient",
        targetStats: { meanDisplay: 120, medianDisplay: 120 },
      },
    },
    stabilityAndLimits: {
      supportedCandidateMeanMedianSameCell: true,
      rawObservedMeanMedianSameCell: true,
      rawObservedWinnerSupportSufficient: true,
      supportsCausality: false,
      supportsInterpolation: false,
      supportsUnobservedCombinations: false,
      supportsGlobalOptimum: false,
    },
  });

  const ascending = executeEvidenceOperations(rows, [{
    id: "joint-low",
    type: "jointQuantileBins",
    targetField: "target",
    fields: ["driver_x", "driver_y"],
    direction: "asc",
    binCount: 2,
  }])["joint-low"];
  assert.deepEqual(ascending.evaluation.bestObservedByMean.cellIds, ["Q1×Q1"]);
});

test("jointQuantileBins withholds ok from a sparse winner and returns a supported candidate", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ({ x: 1, y: 1, target: 80 })),
    ...Array.from({ length: 3 }, () => ({ x: 1, y: 2, target: 10 })),
    ...Array.from({ length: 3 }, () => ({ x: 2, y: 1, target: 20 })),
    { x: 2, y: 2, target: 100 },
  ];
  const view = executeEvidenceOperations(rows, [{
    id: "sparse-winner",
    type: "jointQuantileBins",
    targetField: "target",
    fields: ["x", "y"],
    direction: "desc",
    binCount: 2,
  }])["sparse-winner"];

  assert.equal(MIN_JOINT_CELL_SUPPORT, 3);
  assert.equal(view.evaluation.status, "insufficient_winner_support");
  assert.deepEqual(view.evaluation.bestObservedByMean.cellIds, ["Q2×Q2"]);
  assert.deepEqual(view.evaluation.support, {
    status: "insufficient_winner_support",
    minimumCellRowCount: 3,
    winnerCells: [{ cellId: "Q2×Q2", rowCount: 1, status: "low" }],
  });
  assert.deepEqual(view.evaluation.stability, {
    status: "not_assessable_low_support",
    sameBestCells: null,
  });
  assert.equal(view.evaluation.bestSupportedCandidates.status, "available");
  assert.deepEqual(view.evaluation.bestSupportedCandidates.bestByMean.cellIds, ["Q1×Q1"]);
  assert.deepEqual(view.evaluation.bestSupportedCandidates.bestByMedian.cellIds, ["Q1×Q1"]);
  assert.equal(view.evaluation.bestSupportedCandidates.sameBestCells, true);
  assert.equal(view.grid.cells.find((cell) => cell.cellId === "Q2×Q2").support.status, "low");
  assert.equal(view.grid.cells.find((cell) => cell.cellId === "Q1×Q1").support.status, "sufficient");
  assert.equal(
    view.decisionBrief.answerStatus,
    "observed_winner_support_insufficient_one_supported_candidate"
  );
  assert.equal(view.decisionBrief.minimumSupportRowCount, 3);
  assert.equal(view.decisionBrief.supportedCandidates.byMean.cellId, "Q1×Q1");
  assert.equal(view.decisionBrief.supportedCandidates.byMean.rowCount, 3);
  assert.equal(view.decisionBrief.rawObservedWinners.byMean.cellId, "Q2×Q2");
  assert.equal(view.decisionBrief.rawObservedWinners.byMean.rowCount, 1);
  assert.deepEqual(
    view.decisionBrief.stabilityAndLimits,
    {
      supportedCandidateMeanMedianSameCell: true,
      rawObservedMeanMedianSameCell: true,
      rawObservedWinnerSupportSufficient: false,
      supportsCausality: false,
      supportsInterpolation: false,
      supportsUnobservedCombinations: false,
      supportsGlobalOptimum: false,
    }
  );
  assert.match(
    view.decisionBrief.recommendedClaim,
    /可优先参考x1、y1（3条记录，target均值80、中位数80）[\s\S]*仅作为低支持边界/
  );

  const twoRowWinner = executeEvidenceOperations([
    ...rows,
    { x: 2, y: 2, target: 100 },
  ], [{
    id: "two-row-winner",
    type: "jointQuantileBins",
    targetField: "target",
    fields: ["x", "y"],
    direction: "desc",
    binCount: 2,
  }])["two-row-winner"];
  assert.equal(twoRowWinner.evaluation.status, "insufficient_winner_support");
  assert.deepEqual(twoRowWinner.evaluation.support.winnerCells, [
    { cellId: "Q2×Q2", rowCount: 2, status: "low" },
  ]);
  assert.equal(twoRowWinner.evaluation.stability.status, "not_assessable_low_support");
});

test("jointQuantileBins uses one complete-case population and exposes deterministic display values", () => {
  const rows = [
    { x: 1, y: 1, target: 10.111 },
    { x: 2, y: 2, target: 20.222 },
    { x: null, y: 3, target: 30 },
    { x: 4, y: "bad", target: 40 },
    { x: 5, y: 5, target: null },
  ];
  const view = executeEvidenceOperations(rows, [{
    id: "joint",
    type: "jointQuantileBins",
    targetField: "target",
    fields: ["x", "y"],
    direction: "desc",
    binCount: 2,
  }]).joint;
  assert.equal(view.population.matchedRows, 5);
  assert.equal(view.population.eligibleRows, 2);
  assert.equal(view.population.excludedRows, 3);
  assert.deepEqual(view.population.exclusions.cellReasons, {
    target: { missing: 0, null: 1, blank: 0, nonNumeric: 0 },
    x: { missing: 0, null: 1, blank: 0, nonNumeric: 0 },
    y: { missing: 0, null: 0, blank: 0, nonNumeric: 1 },
  });
  assert.ok(view.grid.cells.every((cell) => cell.comparisonToOverall.overallMeanDisplay === 15.17));
  assert.ok(view.grid.cells.every((cell) => Object.keys(cell.targetStats).every((key) =>
    ["count", "numericCount", "mean", "median", "display"].includes(key)
  )));
  assert.ok(view.grid.cells.every((cell) => cell.sourcePointers.length <= 5));
});

test("jointQuantileBins keeps the Researcher grid compact while preserving best-cell evidence", () => {
  const rows = [];
  for (let x = 1; x <= 5; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      rows.push({ x, y, target: x * 100 + y });
    }
  }
  const view = executeEvidenceOperations(rows, [{
    id: "compact-joint",
    type: "jointQuantileBins",
    targetField: "target",
    fields: ["x", "y"],
    direction: "desc",
    binCount: 5,
  }])["compact-joint"];
  assert.equal(view.grid.observedCellCount, 25);
  assert.equal(view.grid.returnedCellCount, 2);
  assert.equal(view.grid.truncated, true);
  assert.equal(Object.hasOwn(view.grid, "selectionPolicy"), false);
  assert.deepEqual(Object.keys(view.grid).sort(), ["cells", "observedCellCount", "returnedCellCount", "truncated"]);
  assert.ok(view.grid.cells.length <= 4);
  assert.equal(view.evaluation.status, "insufficient_winner_support");
  assert.equal(view.evaluation.bestSupportedCandidates.status, "unavailable");
  assert.equal(
    view.decisionBrief.answerStatus,
    "observed_winner_support_insufficient_no_supported_candidate"
  );
  assert.equal(view.decisionBrief.supportedCandidates.byMean, null);
  assert.equal(view.decisionBrief.supportedCandidates.byMedian, null);
  for (const evaluation of [
    view.evaluation.bestObservedByMean,
    view.evaluation.bestObservedByMedian,
  ]) {
    assert.ok(
      evaluation.cellIds.some((cellId) =>
        view.grid.cells.some((cell) => cell.cellId === cellId)
      ),
      "a mean/median best-cell representative must survive compaction"
    );
  }
});

test("jointQuantileBins reserves a distinct median winner before tied mean cells fill the cap", () => {
  const rows = [];
  for (let x = 1; x <= 5; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      const isMeanWinner = x === 1 || (x === 5 && y === 5);
      const targets = x === 5 && y === 5
        ? [50, 125, 125]
        : Array(3).fill(isMeanWinner ? 100 : 0);
      for (const target of targets) rows.push({ x, y, target });
    }
  }
  const view = executeEvidenceOperations(rows, [{
    id: "tied-joint",
    type: "jointQuantileBins",
    targetField: "target",
    fields: ["x", "y"],
    direction: "desc",
    binCount: 5,
  }])["tied-joint"];
  assert.equal(view.evaluation.bestObservedByMean.cellIds.length, 6);
  assert.equal(view.evaluation.bestObservedByMedian.cellIds.length, 1);
  assert.equal(view.grid.cells.length, 2);
  assert.ok(view.grid.cells.some((cell) =>
    view.evaluation.bestObservedByMedian.cellIds.includes(cell.cellId)
  ));
});

test("field preflight returns every missing required, where, sort, projection, and group field", () => {
  const rows = [{ date: "2026-07-01", profit: 100 }];
  assert.throws(
    () => validateEvidenceFieldReferences(rows, {
      requiredColumns: ["customer", "profit"],
      operations: [
        {
          id: "rank",
          type: "topN",
          field: "profitAmt",
          fields: ["date", "customer"],
          where: [{ field: "store", op: "eq", value: "A" }],
        },
        {
          id: "compare",
          type: "compareTopN",
          sortBy: "margin",
          fields: ["guest", "profit"],
        },
        {
          id: "groups",
          type: "groupBy",
          groupField: "category",
          fields: ["profit"],
          where: [{ field: "region", op: "eq", value: "east" }],
        },
        {
          id: "sorted",
          type: "sort",
          field: "sortMetric",
          fields: ["date"],
        },
      ],
    }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_FIELD_MISMATCH");
      assert.deepEqual(error.details.availableFields, ["date", "profit"]);
      assert.deepEqual(
        error.details.missingFields.map((item) => item.field),
        ["category", "customer", "guest", "margin", "profitAmt", "region", "sortMetric", "store"]
      );
      assert.deepEqual(
        error.details.missingFields.find((item) => item.field === "customer").references,
        ["evidencePlan.operations[0].fields", "evidencePlan.requiredColumns"]
      );
      assert.deepEqual(
        error.details.missingFields.find((item) => item.field === "store").references,
        ["evidencePlan.operations[0].where[0].field"]
      );
      return true;
    }
  );
});

test("field preflight preserves valid zero-row evidence with an unverifiable schema", () => {
  assert.deepEqual(
    validateEvidenceFieldReferences([], {
      requiredColumns: ["日维度", "门店毛利额"],
      operations: [{
        id: "empty-rank",
        type: "topN",
        field: "门店毛利额",
        fields: ["日维度", "门店毛利额"],
        where: [{ field: "门店", op: "eq", value: "A" }],
      }],
    }),
    {
      validation: "unverifiable_empty_source",
      availableFields: [],
      missingFields: [],
    }
  );
  const views = executeEvidenceOperations([], [{
    id: "empty-rank",
    type: "topN",
    field: "门店毛利额",
    fields: ["日维度", "门店毛利额"],
    where: [{ field: "门店", op: "eq", value: "A" }],
  }]);
  assert.equal(views["empty-rank"].matchedRows, 0);
  assert.equal(views["empty-rank"].returnedRows, 0);
  assert.deepEqual(views["empty-rank"].rows, []);
});

test("field preflight follows the same empty sort/group fallback as operation execution", () => {
  assert.throws(
    () => validateEvidenceFieldReferences([{ present: 1 }], {
      operations: [
        {
          id: "compare-fallback",
          type: "compare",
          sortBy: "",
          field: "missingSortFallback",
          fields: ["present"],
        },
        {
          id: "group-fallback",
          type: "groupBy",
          groupField: "",
          field: "missingGroupFallback",
          fields: ["present"],
        },
      ],
    }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_FIELD_MISMATCH");
      assert.deepEqual(error.details.missingFields, [
        {
          field: "missingGroupFallback",
          references: ["evidencePlan.operations[1].field"],
        },
        {
          field: "missingSortFallback",
          references: ["evidencePlan.operations[0].field"],
        },
      ]);
      return true;
    }
  );
});

test("field preflight validates correlation and quantile target and driver references", () => {
  assert.throws(
    () => validateEvidenceFieldReferences([{ present: 1 }], {
      operations: [
        {
          id: "correlation",
          type: "correlation",
          targetField: "missingTarget",
          fields: ["missingDriver", "present"],
        },
        {
          id: "quantiles",
          type: "quantileBins",
          targetField: "present",
          fields: ["missingBinField"],
        },
      ],
    }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_FIELD_MISMATCH");
      assert.deepEqual(error.details.missingFields, [
        {
          field: "missingBinField",
          references: ["evidencePlan.operations[1].fields"],
        },
        {
          field: "missingDriver",
          references: ["evidencePlan.operations[0].fields"],
        },
        {
          field: "missingTarget",
          references: ["evidencePlan.operations[0].targetField"],
        },
      ]);
      return true;
    }
  );
});

test("source field inventory validates Writer data without changing minimal CLI metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-source-fields-"));
  const session = join(root, ".harness", "state", "html-report", "inventory");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(cardDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const rows = [
    { 毛利额: 100, 日维度: "2026-07-01", 来客数: 0 },
    { 日维度: "2026-07-02", 来客数: null, 毛利额: 200 },
  ];
  const meta = { rowCount: rows.length, rowsSha256: rowsSha256(rows) };
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [sourceCard(), { id: "c2", query: { request: {}, comparisons: [] } }],
  }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify(meta));

  const inventory = await prepareSourceFieldInventory(resultPath);
  assert.equal(inventory.mode, "source_fields");
  assert.deepEqual(inventory.sources, [
    {
      cardId: "c1",
      status: "available",
      rowCount: 2,
      rowsSha256: meta.rowsSha256,
      empty: false,
      fieldInventoryStatus: "validated",
      availableFields: ["日维度", "来客数", "毛利额"],
      profile: {
        rowCount: 2,
        fieldCount: 3,
        fields: {
          日维度: {
            presentCount: 2,
            missingCount: 0,
            nullCount: 0,
            blankCount: 0,
            numericCount: 0,
            zeroCount: 0,
            nonNumericValueCount: 2,
          },
          来客数: {
            presentCount: 2,
            missingCount: 0,
            nullCount: 1,
            blankCount: 0,
            numericCount: 1,
            zeroCount: 1,
            nonNumericValueCount: 0,
          },
          毛利额: {
            presentCount: 2,
            missingCount: 0,
            nullCount: 0,
            blankCount: 0,
            numericCount: 2,
            zeroCount: 0,
            nonNumericValueCount: 0,
          },
        },
      },
      dataQuality: {
        completenessBasis: "all_available_fields",
        completeRequiredRowCount: 1,
        incompleteRequiredRowCount: 1,
        incompleteByField: {
          来客数: { missingCount: 0, nullCount: 1, blankCount: 0 },
        },
      },
    },
    {
      cardId: "c2",
      status: "unavailable",
      reason: "writer_data_unavailable",
      availableFields: [],
      profile: null,
      dataQuality: null,
    },
  ]);
  assert.equal(Object.hasOwn(inventory.sources[0], "rows"), false);
  assert.equal(Object.hasOwn(inventory.sources[0], "dataPath"), false);
  assert.equal(Object.hasOwn(inventory.sources[0], "metaPath"), false);
  assert.equal(JSON.stringify(inventory).includes("2026-07-01"), false);
  assert.deepEqual(JSON.parse(await readFile(join(cardDir, "entry.meta.json"), "utf8")), meta);
});

test("source field inventory rejects dot-segment card ids before reading data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-source-fields-dot-id-"));
  const session = join(root, "session");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "data"), { recursive: true });
  const rows = [{ leaked: true }];
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [{ id: "..", query: { request: {}, comparisons: [] } }],
  }));
  await writeFile(join(session, "data", "entry.json"), JSON.stringify(rows));
  await writeFile(join(session, "data", "entry.meta.json"), JSON.stringify({
    rowCount: 1,
    rowsSha256: rowsSha256(rows),
  }));

  await assert.rejects(
    () => prepareSourceFieldInventory(join(session, "result.json")),
    /cardId must not be a dot path segment/
  );
});

test("source field inventory refuses Writer data symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-source-fields-symlink-"));
  const session = join(root, "session");
  const cardDir = join(session, "data", "cards", "c1");
  const external = join(root, "external");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(cardDir, { recursive: true });
  await mkdir(external, { recursive: true });
  const rows = [{ externalSecretField: "not-returned" }];
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [sourceCard()],
  }));
  await writeFile(join(external, "entry.json"), JSON.stringify(rows));
  await writeFile(join(external, "entry.meta.json"), JSON.stringify({
    rowCount: 1,
    rowsSha256: rowsSha256(rows),
  }));
  await symlink(join(external, "entry.json"), join(cardDir, "entry.json"));
  await symlink(join(external, "entry.meta.json"), join(cardDir, "entry.meta.json"));

  await assert.rejects(
    () => prepareSourceFieldInventory(join(session, "result.json")),
    /must not use symbolic links/
  );
});

test("field inventory and evidence preparation reject Writer artifacts older than result.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-source-fields-stale-"));
  const session = join(root, "session");
  const cardDir = join(session, "data", "cards", "c1");
  const analysisDir = join(session, "analysis");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(cardDir, { recursive: true });
  await mkdir(analysisDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const entryPath = join(cardDir, "entry.json");
  const metaPath = join(cardDir, "entry.meta.json");
  const rows = [{ 日期: "2026-07-01", 毛利额: 100 }];
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [sourceCard()] }));
  await writeFile(entryPath, JSON.stringify(rows));
  await writeFile(metaPath, JSON.stringify({ rowCount: 1, rowsSha256: rowsSha256(rows) }));
  await writeFile(join(analysisDir, "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "stale-source",
      fromCardId: "c1",
      goal: "验证陈旧 Writer 证据会被拒绝",
      evidencePlan: {
        mode: "reuse_entry",
        operations: [{ id: "rows", type: "project", fields: ["日期", "毛利额"] }],
      },
    }],
  }));
  const staleTime = new Date(Date.now() - 10_000);
  await Promise.all([
    utimes(entryPath, staleTime, staleTime),
    utimes(metaPath, staleTime, staleTime),
  ]);

  await assert.rejects(
    () => prepareSourceFieldInventory(resultPath),
    /Writer artifacts.*older than.*result\.json/
  );
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "stale-source" }),
    /source artifacts.*older than.*result\.json/
  );
});

test("prepareResearchEvidence reuses Writer entry without explore files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-evidence-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const taskPath = join(session, "analysis", "tasks.json");
  const rows = [
    { 日期: "2026-07-01", 毛利额: 100 },
    { 日期: "2026-07-02", 毛利额: 200 },
  ];
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [sourceCard()] }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 2, rowsSha256: rowsSha256(rows) }));
  await writeFile(taskPath, JSON.stringify({
    version: 2,
    tasks: [{
      id: "balance-1",
      fromCardId: "c1",
      goal: "找出毛利额最高的日期",
      evidencePlan: {
        mode: "reuse_entry",
        reason: "现有字段足够",
        operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
      },
    }],
  }));

  const output = await prepareResearchEvidence(resultPath, { taskPath, taskId: "balance-1" });
  assert.equal(output.evidenceMode, "reuse_entry");
  assert.equal(output.source.kind, "writer_entry");
  assert.equal(output.views.top.rows[0].sourcePointer, "/1");
  const persisted = JSON.parse(await readFile(output.evidencePath, "utf8"));
  assert.equal(persisted.producer, "prepare-research-evidence.mjs");
  assert.equal(persisted.source.rowsSha256, rowsSha256(rows));
  assert.equal(
    persisted.source.fieldMetadataSha256,
    fingerprintJson(buildSourceFieldMetadata(rows))
  );
  assert.equal(persisted.operationPlanSha256, fingerprintJson([{
    id: "top",
    type: "topN",
    field: "毛利额",
    count: 1,
    fields: ["日期", "毛利额"],
  }]));
  assert.equal(persisted.viewsSha256, fingerprintJson(persisted.views));
  await assert.rejects(() => readFile(join(session, "data", "explore", "balance-1.json")));

  await writeFile(resultPath, JSON.stringify({ cards: [sourceCard()] }));
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "balance-1" }),
    /result\.status must be confirmed/
  );
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [{ id: "c1" }] }));
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "balance-1" }),
    /invalid canonical query/
  );
});

test("prepareResearchEvidence rejects a Writer hash mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-evidence-hash-"));
  const session = join(root, ".harness", "state", "html-report", "s2");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const taskPath = join(session, "analysis", "tasks.json");
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [sourceCard()] }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify([{ value: 1 }]));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 1, rowsSha256: "a".repeat(64) }));
  await writeFile(taskPath, JSON.stringify({ version: 2, tasks: [{
    id: "t1",
    fromCardId: "c1",
    goal: "验证 Writer hash",
    evidencePlan: { mode: "reuse_entry", operations: [{ type: "stats", fields: ["value"] }] },
  }] }));
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskPath, taskId: "t1" }),
    /rowsSha256 mismatch/
  );
});

test("prepareResearchEvidence builds new_query evidence only from a material hashed explore result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-evidence-new-query-"));
  const session = join(root, ".harness", "state", "html-report", "s3");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const exploreDir = join(session, "data", "explore");
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(exploreDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const taskPath = join(session, "analysis", "tasks.json");
  const rows = [
    { 门店: "A", 销售额: 120 },
    { 门店: "B", 销售额: 80 },
  ];
  const metaPath = join(exploreDir, "drill-1.meta.json");
  const queryShape = {
    dimensions: ["storeId"],
  };
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [sourceCard()] }));
  await writeFile(join(exploreDir, "drill-1.json"), JSON.stringify(rows));
  const sourceQuery = metricQueryFromCard(sourceCard());
  const candidateQuery = normalizeMetricQuery({ ...sourceQuery, ...queryShape });
  const queryPatch = computeQueryPatch(sourceQuery, candidateQuery);
  await writeFile(metaPath, JSON.stringify({
    producer: "fetch-explore.mjs",
    producerVersion: 3,
    cacheContractVersion: 3,
    status: "ok",
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
    queryDelta: { material: true, changedKeys: ["dimensions"] },
    queryPatch,
    queryPatchSha256: fingerprintJson(queryPatch),
    sourceQuerySha256: fingerprintJson(sourceQuery),
    executedQuerySha256: fingerprintJson(candidateQuery),
  }));
  await writeFile(taskPath, JSON.stringify({
    version: 2,
    tasks: [{
      id: "drill-1",
      fromCardId: "c1",
      goal: "按门店拆解销售额",
      evidenceGap: { type: "missing_dimension", reason: "需要门店维度" },
      evidencePlan: {
        mode: "new_query",
        requiredColumns: ["门店", "销售额"],
        operations: [{ id: "rank", type: "topN", field: "销售额", count: 2, fields: ["门店", "销售额"] }],
      },
    }],
  }));

  const output = await prepareResearchEvidence(resultPath, { taskId: "drill-1" });
  assert.equal(output.evidenceMode, "new_query");
  assert.equal(output.source.kind, "explore_query");
  assert.equal(output.views.rank.rows[0].row.门店, "A");
  assert.equal(output.source.fieldCoverage.销售额.numericCount, 2);

  const taskDocument = JSON.parse(await readFile(taskPath, "utf8"));
  const savedGap = taskDocument.tasks[0].evidenceGap;
  delete taskDocument.tasks[0].evidenceGap;
  await writeFile(taskPath, JSON.stringify(taskDocument));
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "drill-1" }),
    /new_query.*requires.*evidenceGap/
  );
  taskDocument.tasks[0].evidenceGap = savedGap;
  await writeFile(taskPath, JSON.stringify(taskDocument));

  await writeFile(metaPath, JSON.stringify({
    producer: "fetch-explore.mjs",
    producerVersion: 3,
    cacheContractVersion: 3,
    status: "ok",
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
    queryDelta: { material: false, changedKeys: [] },
    queryPatch: {},
    queryPatchSha256: fingerprintJson({}),
    sourceQuerySha256: fingerprintJson(sourceQuery),
    executedQuerySha256: fingerprintJson(sourceQuery),
  }));
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "drill-1" }),
    /material query delta/
  );
});

test("prepareResearchEvidence rejects task, mode, and operations overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-evidence-overrides-"));
  const session = join(root, ".harness", "state", "html-report", "s4");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const taskPath = join(session, "analysis", "tasks.json");
  const rows = [{ value: 7 }];
  const operations = [{ id: "stats", type: "stats", fields: ["value"] }];
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [sourceCard()] }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 1, rowsSha256: rowsSha256(rows) }));
  await writeFile(taskPath, JSON.stringify({
    version: 2,
    tasks: [{ id: "t1", fromCardId: "c1", goal: "验证任务覆盖保护", evidencePlan: { mode: "reuse_entry", operations } }],
  }));

  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "t1", taskPath: join(session, "analysis", "shadow-tasks.json") }),
    /task file is fixed/
  );
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "t1", mode: "new_query" }),
    /mode override is forbidden/
  );
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, {
      taskId: "t1",
      operations: [{ id: "rank", type: "topN", field: "value", count: 1 }],
    }),
    /operations override is forbidden/
  );
  await writeFile(taskPath, JSON.stringify({
    version: 1,
    tasks: [{ id: "t1", fromCardId: "c1", goal: "验证任务覆盖保护", evidencePlan: { mode: "reuse_entry", operations } }],
  }));
  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "t1" }),
    /version must be exactly 2/
  );
});

test("prepareResearchEvidence rejects missing requiredColumns before model handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-evidence-columns-"));
  const session = join(root, ".harness", "state", "html-report", "s5");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  const resultPath = join(session, "result.json");
  const rows = [{ 已有字段: 1 }];
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [sourceCard()] }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 1, rowsSha256: rowsSha256(rows) }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "t1",
      fromCardId: "c1",
      goal: "验证字段预检",
      evidencePlan: {
        mode: "reuse_entry",
        requiredColumns: ["缺失字段"],
        operations: [{ type: "stats", fields: ["已有字段"] }],
      },
    }],
  }));

  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "t1" }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_FIELD_MISMATCH");
      assert.deepEqual(error.details.availableFields, ["已有字段"]);
      assert.deepEqual(error.details.missingFields, [{
        field: "缺失字段",
        references: ["evidencePlan.requiredColumns"],
      }]);
      return true;
    }
  );
});

test("prepareResearchEvidence rejects task ids that collide after sanitization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-evidence-collision-"));
  const session = join(root, ".harness", "state", "html-report", "s6");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [
      { id: "a/b", evidencePlan: { mode: "reuse_entry", operations: [] } },
      { id: "a_b", evidencePlan: { mode: "reuse_entry", operations: [] } },
    ],
  }));

  await assert.rejects(
    () => prepareResearchEvidence(resultPath, { taskId: "a/b" }),
    /collide after sanitization/
  );
});

test("fixed evidence operations reject unknown types and oversized row views", () => {
  const rows = [{ value: 1 }];
  assert.throws(
    () => executeEvidenceOperations(rows, [{ id: "unknown", type: "eval", fields: ["value"] }]),
    /unsupported evidence operation/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{ id: "too-many", type: "topN", field: "value", count: 51 }]),
    /exceeds cap 50/
  );
});

test("new evidence primitives reject malformed parameters and where clauses", () => {
  const rows = [{ target: 1, driver: 2 }];
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "fields-shape",
      type: "correlation",
      targetField: "target",
      fields: "driver",
    }]),
    /requires non-empty fields\[\]/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "bad-bin-count",
      type: "quantileBins",
      targetField: "target",
      fields: ["driver"],
      binCount: 1,
    }]),
    /binCount must be an integer from 2 to 10/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "empty-where",
      type: "correlation",
      targetField: "target",
      fields: ["driver"],
      where: [],
    }]),
    /where must be a non-empty array/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "missing-where-value",
      type: "correlation",
      targetField: "target",
      fields: ["driver"],
      where: [{ field: "driver", op: "gte" }],
    }]),
    /where\[0\] requires value/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "legacy-where",
      type: "correlation",
      targetField: "target",
      fields: ["driver"],
      where: [{ field: "driver", operator: "gte", value: 1 }],
    }]),
    /requires op/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "scalar-in",
      type: "correlation",
      targetField: "target",
      fields: ["driver"],
      where: [{ field: "driver", op: "in", value: 1 }],
    }]),
    /op=in requires a non-empty array value/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "array-eq",
      type: "correlation",
      targetField: "target",
      fields: ["driver"],
      where: [{ field: "driver", op: "eq", value: [1] }],
    }]),
    /op=eq requires a scalar value/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "self-correlation",
      type: "correlation",
      targetField: "target",
      fields: ["target"],
    }]),
    /fields\[\] must not contain targetField/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "joint-one-field",
      type: "jointQuantileBins",
      targetField: "target",
      fields: ["driver"],
      direction: "desc",
    }]),
    /requires exactly two driver fields/
  );
  assert.throws(
    () => executeEvidenceOperations([{ target: 1, left: 2, right: 3 }], [{
      id: "joint-no-direction",
      type: "jointQuantileBins",
      targetField: "target",
      fields: ["left", "right"],
    }]),
    /requires direction asc or desc/
  );
  assert.throws(
    () => executeEvidenceOperations([{ target: 1, left: 2, right: 3 }], [{
      id: "joint-too-many-bins",
      type: "jointQuantileBins",
      targetField: "target",
      fields: ["left", "right"],
      direction: "desc",
      binCount: 6,
    }]),
    /binCount must be at most 5/
  );
  assert.throws(
    () => executeEvidenceOperations(rows, [{
      id: "self-bins",
      type: "quantileBins",
      targetField: "target",
      fields: ["target"],
    }]),
    /fields\[\] must not contain targetField/
  );
  assert.throws(
    () => executeEvidenceOperations([{
      target: 1,
      ...Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field-${index}`, index])),
    }], [{
      id: "too-many-fields",
      type: "correlation",
      targetField: "target",
      fields: Array.from({ length: 21 }, (_, index) => `field-${index}`),
    }]),
    /fields\[\] count 21 exceeds cap 20/
  );
});
