import test from "node:test";
import assert from "node:assert/strict";
import {
  metricQueryFromCard,
  normalizeMetricQuery,
  queryHasMeasures,
} from "./metric-query-contract.mjs";

const TIME = { grain: "DAY", startDate: "2026-08-01", endDate: "2026-08-20" };
const FILTERS = { manageAreaId: ["CN18"] };
const OVERALL_MEASURES = [
  { metric: "saleAmt", statisticPolicy: "SUMMARY" },
  { metric: "saleAmt", statisticPolicy: "SALES_STORE_DAY_AVG" },
  { metric: "saleDays", statisticPolicy: "SUMMARY" },
  { metric: "receiveWeight", statisticPolicy: "SALES_STORE_DAY_AVG" },
  { metric: "scmStoreProfitRate", statisticPolicy: "SALES_STORE_DAY_AVG" },
  { metric: "profitRate", statisticPolicy: "SALES_STORE_DAY_AVG" },
  { metric: "fullLinkStoreProfitRate", statisticPolicy: "SALES_STORE_DAY_AVG" },
];

function overallCard(overrides = {}) {
  return {
    id: "overall_manage_area",
    query: {
      request: {
        metrics: [
          "saleAmt",
          "saleDays",
          "receiveWeight",
          "scmStoreProfitRate",
          "profitRate",
          "fullLinkStoreProfitRate",
        ],
        statisticPolicy: "AUTO",
        measures: OVERALL_MEASURES,
        time: TIME,
        dimensions: ["manageAreaId"],
        filters: FILTERS,
        pageNo: 1,
        pageSize: 500,
        ...overrides.request,
      },
      comparisons: ["YOY"],
      ...overrides.query,
    },
  };
}

test("overall_manage_area measures + AUTO + YOY normalizes", () => {
  const query = metricQueryFromCard(overallCard());
  assert.equal(query.statisticPolicy, "AUTO");
  assert.deepEqual(query.comparisons, ["YOY"]);
  assert.equal(query.measures.length, 7);
  assert.deepEqual(query.measures[0], { metric: "saleAmt", statisticPolicy: "SUMMARY" });
  assert.deepEqual(query.measures[1], { metric: "saleAmt", statisticPolicy: "SALES_STORE_DAY_AVG" });
  assert.equal(queryHasMeasures(query), true);
  assert.equal(query.pageSize, 500);
  assert.equal(query.pageNo, 1);
});

test("measures without metrics derives unique metric codes", () => {
  const query = normalizeMetricQuery({
    statisticPolicy: "AUTO",
    measures: [
      { metric: "saleAmt", statisticPolicy: "SUMMARY" },
      { metric: "saleAmt", statisticPolicy: "SALES_STORE_DAY_AVG" },
    ],
    time: TIME,
    dimensions: ["manageAreaId"],
    filters: {},
  });
  assert.deepEqual(query.metrics, ["saleAmt"]);
});

test("unknown request fields still fail closed", () => {
  assert.throws(
    () => metricQueryFromCard(overallCard({ request: { foo: 1 } })),
    /unsupported fields: foo/,
  );
});

test("legacy indicatorFieldList is still rejected", () => {
  assert.throws(
    () => normalizeMetricQuery({
      indicatorFieldList: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      time: TIME,
      dimensions: ["manageAreaId"],
      filters: {},
    }),
    /LEGACY_INDICATORS_PAYLOAD_UNSUPPORTED/,
  );
});

test("AUTO without measures rejects comparisons", () => {
  assert.throws(
    () => normalizeMetricQuery({
      metrics: ["saleAmt"],
      statisticPolicy: "AUTO",
      time: TIME,
      dimensions: ["manageAreaId"],
      filters: {},
      comparisons: ["YOY"],
    }),
    /AUTO does not support comparisons unless query.measures is present/,
  );
});

test("measures cannot combine with measureFilters", () => {
  assert.throws(
    () => normalizeMetricQuery({
      statisticPolicy: "AUTO",
      measures: [{ metric: "saleAmt", statisticPolicy: "SUMMARY" }],
      measureFilters: [{ metric: "saleAmt", operator: ">", value: "1" }],
      time: TIME,
      dimensions: ["manageAreaId"],
      filters: {},
    }),
    /cannot be combined with query.measureFilters/,
  );
});

test("measure local filters are normalized", () => {
  const query = normalizeMetricQuery({
    statisticPolicy: "AUTO",
    measures: [{
      metric: "receiveWeight",
      statisticPolicy: "SALES_STORE_DAY_AVG",
      filters: { categoryLevel1Id: ["13", "10"] },
    }],
    time: TIME,
    dimensions: ["manageAreaId"],
    filters: {},
  });
  assert.deepEqual(query.measures[0].filters.categoryLevel1Id, ["10", "13"]);
});

test("single-policy query without measures is unchanged", () => {
  const query = normalizeMetricQuery({
    metrics: ["saleAmt"],
    statisticPolicy: "SUMMARY",
    time: TIME,
    dimensions: ["manageAreaId"],
    filters: FILTERS,
  });
  assert.equal(queryHasMeasures(query), false);
  assert.equal(query.measures, undefined);
  assert.deepEqual(query.metrics, ["saleAmt"]);
});
