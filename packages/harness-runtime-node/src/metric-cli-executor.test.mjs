import test from "node:test";
import assert from "node:assert/strict";
import { buildMetricExecuteArgs } from "./metric-cli-executor.mjs";

const TIME = { grain: "DAY", startDate: "2026-08-01", endDate: "2026-08-20" };

test("measures query uses --measures-json and --yoy without AUTO payload", () => {
  const args = buildMetricExecuteArgs({
    metrics: ["saleAmt"],
    statisticPolicy: "AUTO",
    measures: [
      { metric: "saleAmt", statisticPolicy: "SUMMARY" },
      { metric: "saleAmt", statisticPolicy: "SALES_STORE_DAY_AVG" },
    ],
    time: TIME,
    dimensions: ["manageAreaId"],
    filters: { manageAreaId: ["CN18", "CN01"] },
    comparisons: ["YOY"],
    pageSize: 500,
  });
  assert.equal(args.includes("--payload-json"), false);
  assert.equal(args.includes("--statistic-policy"), false);
  assert.equal(args.includes("--metric"), false);
  const jsonIndex = args.indexOf("--measures-json");
  assert.ok(jsonIndex >= 0);
  assert.deepEqual(JSON.parse(args[jsonIndex + 1]), [
    { metric: "saleAmt", statisticPolicy: "SUMMARY" },
    { metric: "saleAmt", statisticPolicy: "SALES_STORE_DAY_AVG" },
  ]);
  assert.ok(args.includes("--yoy"));
  assert.ok(args.includes("--agg-dim"));
  assert.equal(args[args.indexOf("--agg-dim") + 1], "manageAreaId");
  assert.ok(args.includes("--filter"));
  assert.equal(args[args.indexOf("--filter") + 1], "manageAreaId=CN01,CN18");
  assert.equal(args[args.indexOf("--start-date") + 1], "2026-08-01");
  assert.equal(args[args.indexOf("--output") + 1], "envelope");
  assert.equal(args.includes("--single-page"), false);
});

test("single-policy query still uses --payload-json", () => {
  const args = buildMetricExecuteArgs({
    metrics: ["saleAmt"],
    statisticPolicy: "SUMMARY",
    time: TIME,
    dimensions: ["manageAreaId"],
    filters: {},
    comparisons: ["YOY"],
  });
  assert.ok(args.includes("--payload-json"));
  assert.equal(args.includes("--measures-json"), false);
  const payload = JSON.parse(args[args.indexOf("--payload-json") + 1]);
  assert.equal(payload.statisticPolicy, "SUMMARY");
  assert.equal("comparisons" in payload, false);
  assert.ok(args.includes("--yoy"));
});
