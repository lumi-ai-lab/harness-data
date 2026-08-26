import test from "node:test";
import assert from "node:assert/strict";
import { buildCaptionEvidence } from "../evidence/prepare-card-caption-evidence.mjs";
import {
  captionPointerBudget,
  captionViewPointer,
  defaultCaptionPointers,
  validateCaptionSubmission,
  validateCaptionSubmissionDetailed,
} from "./submit-card-caption.mjs";

const COLUMN_LABELS = {
  saleAmt: "销售额",
  receiveWeight: "进货重量",
  scmStoreProfitRate: "供应链到店毛利率",
  profitRate: "门店毛利率",
  fullLinkStoreProfitRate: "全链路到店毛利率",
  manageAreaId: "管理区域",
  saleAmt同比增长率: "销售额同比增长率",
  profitRate同比增长率: "门店毛利率同比增长率",
  fullLinkStoreProfitRate同比增长率: "全链路到店毛利率同比增长率",
};

function sampleEvidence() {
  return buildCaptionEvidence({
    cardId: "overall_manage_area_store_day",
    query: {
      metrics: ["saleAmt", "receiveWeight", "scmStoreProfitRate", "profitRate", "fullLinkStoreProfitRate"],
      dimensions: ["manageAreaId"],
      time: { startDate: "2026-08-01", endDate: "2026-08-20" },
      comparisons: ["YOY"],
    },
    columnLabels: COLUMN_LABELS,
    rows: [
      { manageAreaId: "香港区", saleAmt: 49845.44, "saleAmt同比增长率": -5.3, receiveWeight: 2089.33, scmStoreProfitRate: 0.0739, profitRate: 0.2834, "profitRate同比增长率": -4.16, fullLinkStoreProfitRate: 0.3363 },
      { manageAreaId: "澳门区", saleAmt: 28598.99, "saleAmt同比增长率": 1.46, receiveWeight: 1572.96, scmStoreProfitRate: 0.074, profitRate: 0.1621, "profitRate同比增长率": -31.31, fullLinkStoreProfitRate: 0.2241, "fullLinkStoreProfitRate同比增长率": -23.17 },
      { manageAreaId: "南京区", saleAmt: 14760.42, receiveWeight: 1200, scmStoreProfitRate: 0.08, profitRate: 0.2132, fullLinkStoreProfitRate: 0.25 },
      { manageAreaId: "武汉区", saleAmt: 12182.68, receiveWeight: 1100, scmStoreProfitRate: 0.079, profitRate: 0.19, fullLinkStoreProfitRate: 0.24 },
      { manageAreaId: "天津区", saleAmt: 12420.7, "saleAmt同比增长率": -13.71, receiveWeight: 1090, scmStoreProfitRate: 0.078, profitRate: 0.185, fullLinkStoreProfitRate: 0.241 },
      { manageAreaId: "合肥区", saleAmt: 12433.45, "saleAmt同比增长率": -13.04, receiveWeight: 1080, scmStoreProfitRate: 0.077, profitRate: 0.1782, fullLinkStoreProfitRate: 0.242 },
      { manageAreaId: "郑州区", saleAmt: 13000, receiveWeight: 1807.75, scmStoreProfitRate: 0.081, profitRate: 0.2, fullLinkStoreProfitRate: 0.26 },
      { manageAreaId: "粤西区", saleAmt: 13100, receiveWeight: 782.49, scmStoreProfitRate: 0.1272, profitRate: 0.2, fullLinkStoreProfitRate: 0.2982 },
      { manageAreaId: "粤东区", saleAmt: 13200, receiveWeight: 885.13, scmStoreProfitRate: 0.1228, profitRate: 0.201, fullLinkStoreProfitRate: 0.2981 },
      { manageAreaId: "华东区", saleAmt: 13300, receiveWeight: 1015.67, scmStoreProfitRate: 0.0907, profitRate: 0.2075, fullLinkStoreProfitRate: 0.27 },
      { manageAreaId: "西安区", saleAmt: 13400, receiveWeight: 1200, scmStoreProfitRate: 0.0687, profitRate: 0.186, fullLinkStoreProfitRate: 0.2363 },
      { manageAreaId: "重庆区", saleAmt: 13500, receiveWeight: 1210, scmStoreProfitRate: 0.07, profitRate: 0.1758, fullLinkStoreProfitRate: 0.2386 },
    ],
  });
}

function allCellPointers(evidence) {
  const pointers = [];
  for (const [id, view] of Object.entries(evidence.views)) {
    for (let i = 0; i < (view.rows || []).length; i++) {
      pointers.push(`/views/${id}/rows/${i}/metricValue`);
    }
  }
  return pointers;
}

test("captionViewPointer folds cell paths to the view", () => {
  assert.equal(
    captionViewPointer("/views/topN-saleAmt-manageAreaId"),
    "/views/topN-saleAmt-manageAreaId",
  );
  assert.equal(
    captionViewPointer("/views/topN-saleAmt-manageAreaId/rows/0/metricValue"),
    "/views/topN-saleAmt-manageAreaId",
  );
  assert.equal(
    captionViewPointer("/evidence/views/topN-saleAmt-manageAreaId/rows/0/row/销售额同比增长率"),
    "/views/topN-saleAmt-manageAreaId",
  );
});

test("10 views plus many row-level pointers fold and pass", () => {
  const evidence = sampleEvidence();
  const viewCount = Object.keys(evidence.views).length;
  assert.equal(viewCount, 10);
  assert.equal(captionPointerBudget(evidence), 10);

  const cellPointers = allCellPointers(evidence);
  assert.ok(cellPointers.length > viewCount);

  const submitted = validateCaptionSubmission({
    paragraphs: ["香港区销售额 49845.44。"],
    pointers: cellPointers,
  }, evidence);
  assert.equal(submitted.pointers.length, viewCount);
  assert.deepEqual(new Set(submitted.pointers), new Set(defaultCaptionPointers(evidence)));
});

test("multiple cells in one view count as one pointer", () => {
  const evidence = sampleEvidence();
  const submitted = validateCaptionSubmission({
    paragraphs: ["香港区销售额 49845.44。"],
    pointers: [
      "/views/topN-saleAmt-manageAreaId/rows/0/metricValue",
      "/views/topN-saleAmt-manageAreaId/rows/1/metricValue",
      "/views/topN-saleAmt-manageAreaId/rows/2/metricValue",
    ],
  }, evidence);
  assert.deepEqual(submitted.pointers, ["/views/topN-saleAmt-manageAreaId"]);
});

test("empty pointers default to one pointer per view", () => {
  const evidence = sampleEvidence();
  const submitted = validateCaptionSubmission({
    paragraphs: ["香港区销售额 49845.44。"],
    pointers: [],
  }, evidence);
  assert.deepEqual(submitted.pointers, defaultCaptionPointers(evidence));
  assert.equal(submitted.pointers.length, captionPointerBudget(evidence));
});

test("unknown view still fails before fold", () => {
  const evidence = sampleEvidence();
  assert.throws(
    () => validateCaptionSubmission({
      paragraphs: ["香港区销售额 49845.44。"],
      pointers: ["/views/not-a-real-view"],
    }, evidence),
    /does not resolve/,
  );
});

test("missing row still fails before fold", () => {
  const evidence = sampleEvidence();
  assert.throws(
    () => validateCaptionSubmission({
      paragraphs: ["香港区销售额 49845.44。"],
      pointers: ["/views/topN-saleAmt-manageAreaId/rows/99/metricValue"],
    }, evidence),
    /does not resolve/,
  );
});

test("invented number is still rejected", () => {
  const evidence = sampleEvidence();
  const detailed = validateCaptionSubmissionDetailed({
    paragraphs: ["销售额 9999。"],
    pointers: ["/views/topN-saleAmt-manageAreaId"],
  }, evidence);
  assert.equal(detailed.violations.some((item) => item.rule === "NUMBER_NOT_IN_EVIDENCE"), true);
});
