import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCaptionAxis, captionPrefixes, captionViewId, sortDimensionColumns } from "../scripts/caption-dims.mjs";
import {
  buildCaptionEvidence,
  prepareCardCaptionEvidence,
} from "../scripts/prepare-card-caption-evidence.mjs";
import {
  captionCitesDataNumber,
  captionPointerBudget,
  collectQueryTimeDateComponents,
  defaultCaptionPointers,
  extractCaptionTokens,
  normalizeCaptionToolInput,
  validateCaptionSubmission,
  validateCaptionSubmissionDetailed,
  writeCardCaption,
  violationsPathFor,
} from "../scripts/submit-card-caption.mjs";

test("caption axis keeps three in-group dims and drops the rest", () => {
  const built = buildCaptionAxis([
    "storeId",
    "cityId",
    "manageAreaId",
    "sapArea2Id",
    "totalArea",
    "incDate",
  ]);
  assert.deepEqual(built.axis, ["sapArea2Id", "manageAreaId", "cityId"]);
  assert.deepEqual(built.droppedDimensions, ["totalArea", "incDate", "storeId"]);
  assert.deepEqual(captionPrefixes(built.axis), [
    ["sapArea2Id"],
    ["sapArea2Id", "manageAreaId"],
    ["sapArea2Id", "manageAreaId", "cityId"],
  ]);
});

test("caption axis flattens groups then keeps only three steps", () => {
  const built = buildCaptionAxis([
    "bizDate",
    "bizWeek",
    "manageAreaId",
    "storeId",
    "categoryLevel1Id",
    "dcId",
  ]);
  assert.deepEqual(built.axis, ["bizDate", "bizWeek", "manageAreaId"]);
  assert.ok(built.droppedDimensions.includes("dcId"));
  assert.ok(built.droppedDimensions.includes("storeId"));
  assert.ok(built.droppedDimensions.includes("categoryLevel1Id"));
});

test("sortDimensionColumns keeps all dims with two-level group/dim priority (no caps)", () => {
  // Same input as the caption axis test, but no truncation.
  const sorted = sortDimensionColumns([
    "storeId",
    "cityId",
    "manageAreaId",
    "sapArea2Id",
    "totalArea",
    "incDate",
  ]);
  assert.deepEqual(sorted, [
    "sapArea2Id",
    "manageAreaId",
    "cityId",
    "storeId",
    "totalArea",
    "incDate",
  ]);
});

test("sortDimensionColumns orders groups then dims within group across multiple groups", () => {
  const sorted = sortDimensionColumns([
    "articleId",
    "storeId",
    "bizWeek",
    "categoryLevel1Id",
    "cityId",
  ]);
  // date group first (bizWeek), then store group (cityId, storeId),
  // then sku group (categoryLevel1Id, articleId).
  assert.deepEqual(sorted, [
    "bizWeek",
    "cityId",
    "storeId",
    "categoryLevel1Id",
    "articleId",
  ]);
});

test("sortDimensionColumns passes unknown codes through at the end", () => {
  const sorted = sortDimensionColumns(["customDim", "bizDate", "storeId"]);
  assert.deepEqual(sorted, ["bizDate", "storeId", "customDim"]);
});

test("topN/bottomN compare existing cells and do not sum a coarser prefix", () => {
  const evidence = buildCaptionEvidence({
    cardId: "regional-category",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId", "categoryLevel1Id"],
      time: { startDate: "2026-08-01", endDate: "2026-08-10" },
      comparisons: ["YOY"],
    },
    rows: [
      { manageAreaId: "CN01", categoryLevel1Id: "10", saleAmt: 1000, saleAmt同比增长率: -1.2 },
      { manageAreaId: "CN01", categoryLevel1Id: "12", saleAmt: 100, saleAmt同比增长率: 4 },
      { manageAreaId: "CN04", categoryLevel1Id: "10", saleAmt: 800, saleAmt同比增长率: 2 },
      { manageAreaId: "CN04", categoryLevel1Id: "13", saleAmt: 700, saleAmt同比增长率: 3 },
    ],
  });
  const areaTop = evidence.views["topN-saleAmt-manageAreaId"];
  assert.equal(areaTop.rows[0].key.manageAreaId, "CN01");
  assert.equal(areaTop.rows[0].metricValue, 1000);
  assert.equal(areaTop.rows[0].row.categoryLevel1Id, "10");
  assert.equal(areaTop.rows[0].row.saleAmt同比增长率, -1.2);
  assert.equal(areaTop.rows[1].key.manageAreaId, "CN04");
  assert.equal(areaTop.rows[1].metricValue, 800);
  assert.equal(areaTop.rows.every((row) => row.metricValue !== 1100 && row.metricValue !== 1500), true);

  const cellTop = evidence.views["topN-saleAmt-manageAreaId+categoryLevel1Id"];
  assert.deepEqual(cellTop.rows.map((row) => row.metricValue), [1000, 800, 700]);
  const areaBottom = evidence.views["bottomN-saleAmt-manageAreaId"];
  assert.equal(areaBottom.rows[0].metricValue, 100);
  assert.equal(areaBottom.rows[0].row.categoryLevel1Id, "12");
});

test("caption tokens ignore identifiers like CN01 and keep dates whole", () => {
  const tokens = extractCaptionTokens("CN01 在 2026-08-01 为 1000，不是 1100。");
  assert.deepEqual(tokens.dates, ["2026-08-01"]);
  assert.deepEqual(tokens.numbers, ["1000", "1100"]);
});

test("caption tokens strip Chinese dates so year digits are not extracted", () => {
  const tokens = extractCaptionTokens("2026年8月1日至8月10日销售额为1000。");
  assert.deepEqual(tokens.numbers, ["1000"]);
  assert.ok(!tokens.numbers.includes("2026"), "2026 must be stripped as part of Chinese date");
});

test("caption tokens do not strip standalone year without month and day", () => {
  const tokens = extractCaptionTokens("2019同期销售额为1000。");
  assert.ok(tokens.numbers.includes("2019"), "standalone 2019 must not be stripped");
  assert.ok(tokens.numbers.includes("1000"));
});

test("caption tokens treat thousands separators as one number", () => {
  const tokens = extractCaptionTokens("CN01以4,484,024居首，CN20为1,313,823。");
  assert.deepEqual(tokens.numbers, ["4484024", "1313823"]);
});

test("caption input coerces JSON-string arrays and fills omitted pointers from views", () => {
  const evidence = buildCaptionEvidence({
    cardId: "one",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const filled = normalizeCaptionToolInput({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
  }, evidence);
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.input.pointers, defaultCaptionPointers(evidence));
  assert.ok(filled.input.pointers.includes("/views/topN-saleAmt-manageAreaId"));

  const coerced = normalizeCaptionToolInput({
    paragraphs: JSON.stringify(["销售额最高的是 CN01 的 1000。"]),
    pointers: JSON.stringify(["/views/topN-saleAmt-manageAreaId"]),
  }, evidence);
  assert.equal(coerced.ok, true);
  assert.deepEqual(coerced.input.paragraphs, ["销售额最高的是 CN01 的 1000。"]);
  assert.deepEqual(coerced.input.pointers, ["/views/topN-saleAmt-manageAreaId"]);

  const accepted = validateCaptionSubmission({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
  }, evidence);
  assert.match(accepted.markdown, /1000/);
  assert.equal(captionCitesDataNumber(["统计区间2026-08-01至2026-08-10，按"], evidence), false);
  assert.equal(captionCitesDataNumber(["销售额最高的是 CN01 的 1000。"], evidence), true);
});

test("submit_card_caption rejects numbers that are not in the evidence packet", () => {
  const evidence = buildCaptionEvidence({
    cardId: "one",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /1000/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["合计 1100 最好。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /1100/);
});

test("submit_card_caption allows packet numbers from views that were not pointed at", () => {
  const evidence = buildCaptionEvidence({
    cardId: "two-grain",
    query: {
      metrics: ["custNum"],
      statisticPolicy: "SUMMARY",
      dimensions: ["sapArea2Id", "categoryLevel1Id"],
    },
    rows: [
      { sapArea2Id: "CN01", categoryLevel1Id: "10", custNum: 4184247 },
      { sapArea2Id: "CN18", categoryLevel1Id: "10", custNum: 3657229 },
      { sapArea2Id: "CN01", categoryLevel1Id: "13", custNum: 1671664 },
      { sapArea2Id: "CN20", categoryLevel1Id: "10", custNum: 1303753 },
    ],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["CN20 客数为 1303753。"],
    pointers: ["/views/topN-custNum-sapArea2Id+categoryLevel1Id"],
  }, evidence);
  assert.match(ok.markdown, /1303753/);
});

test("submit_card_caption accepts /evidence/views/... as the same pointer", () => {
  const evidence = buildCaptionEvidence({
    cardId: "one",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
    pointers: ["/evidence/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /1000/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
    pointers: [
      "/views/topN-saleAmt-manageAreaId",
      "/evidence/views/topN-saleAmt-manageAreaId",
    ],
  }, evidence), /pointers must be unique/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
    pointers: ["/packet/views/topN-saleAmt-manageAreaId"],
  }, evidence), /pointers\[0\] must be a \/views\/... JSON pointer/);
});

test("submit_card_caption accepts abs and Rate x100 forms from cited nodes", () => {
  const evidence = buildCaptionEvidence({
    cardId: "rates",
    query: {
      metrics: ["unknowLostRate", "saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{
      manageAreaId: "CN01",
      unknowLostRate: 0.0863,
      unknowLostRate同比增长率: -0.82,
      saleAmt: 1000,
    }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["CN01 未知流失率 8.63%，同比下降 0.82%。"],
    pointers: ["/views/topN-unknowLostRate-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /8\.63/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["销售额写成 100000。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /100000/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["同比写成 82。"],
    pointers: ["/views/topN-unknowLostRate-manageAreaId/rows/0"],
  }, evidence), /82/);
});

test("submit_card_caption accepts query.time dates and shortened decimals", () => {
  const evidence = buildCaptionEvidence({
    cardId: "store-day",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SALES_STORE_DAY_AVG",
      dimensions: ["manageAreaId"],
      time: { startDate: "2026-08-01", endDate: "2026-08-10" },
    },
    rows: [{ manageAreaId: "CN04", saleAmt: 49458.9353 }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["本卡统计 2026-08-01 至 2026-08-10。CN04 日均 49458.94。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /2026-08-01/);
  assert.match(ok.markdown, /49458\.94/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["窗口写成 2026-07-01。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: date 2026-07-01/);
  // 49459 is the correct round-half-up of 49458.9353, so it is accepted.
  // 49460 is neither a rounding nor truncation of 49458.9353, so it is rejected.
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["销售额写成 49460。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 49460/);
});

test("submit_card_caption strips abbreviated MM-DD date ranges", () => {
  const evidence = buildCaptionEvidence({
    cardId: "abbrev-date",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SALES_STORE_DAY_AVG",
      dimensions: ["manageAreaId"],
      time: { startDate: "2026-08-01", endDate: "2026-08-10" },
    },
    rows: [{ manageAreaId: "CN04", saleAmt: 49458.94 }],
  });
  // Writer uses "2026-08-01 至 08-10" (abbreviated second date)
  const ok = validateCaptionSubmission({
    paragraphs: ["2026-08-01 至 08-10 期间，CN04 日均 49458.94。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /49458\.94/);
  // Both dates abbreviated (no full ISO at all)
  const both = validateCaptionSubmission({
    paragraphs: ["08-01 至 08-10 期间，CN04 日均 49458.94。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(both.markdown, /49458\.94/);
});

test("collectQueryTimeDateComponents adds year/month/day numbers to allowed set", () => {
  const evidence = {
    query: { time: { startDate: "2026-08-01", endDate: "2026-08-10" } },
  };
  const numbers = new Set();
  collectQueryTimeDateComponents(evidence, numbers);
  assert.ok(numbers.has("2026"), "year");
  assert.ok(numbers.has("8"), "month without leading zero");
  assert.ok(numbers.has("08"), "month with leading zero");
  assert.ok(numbers.has("1"), "day without leading zero");
  assert.ok(numbers.has("01"), "day with leading zero");
  assert.ok(numbers.has("10"), "end date day");
});

test("submit_card_caption allows date components not caught by date regex", () => {
  // Reproduces the real failure: Writer wrote "2026年8月1日至10日"
  // CHINESE_DATE_TOKEN strips "2026年8月1日" but not the abbreviated "10日"
  // Without the date-component whitelist, "10" would be rejected.
  const evidence = buildCaptionEvidence({
    cardId: "store-day-avg",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SALES_STORE_DAY_AVG",
      dimensions: ["manageAreaId"],
      time: { startDate: "2026-08-01", endDate: "2026-08-10" },
    },
    rows: [{ manageAreaId: "CN04", saleAmt: 49458.94 }],
  });
  // "至10日" — the "10" is endDate's day, not a data value
  const ok = validateCaptionSubmission({
    paragraphs: ["统计周期为2026年8月1日至10日，CN04 日均 49458.94。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /49458\.94/);
  // "至10号" — another natural variant
  const ok2 = validateCaptionSubmission({
    paragraphs: ["统计周期为2026年8月1日至10号，CN04 日均 49458.94。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok2.markdown, /49458\.94/);
  // Still rejects fabricated numbers not in evidence or dates
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["CN04 日均 49460。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 49460/);
});

test("submit_card_caption uses decimal half-up not Number.toFixed", () => {
  const evidence = buildCaptionEvidence({
    cardId: "store-order",
    query: {
      metrics: ["storeOrderAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", storeOrderAmt: 26494489.185 }],
  });
  // Evidence rounds 26494489.185 → 26494489.19 (half-up on digit strings, not toFixed)
  const ok = validateCaptionSubmission({
    paragraphs: ["CN01 订货额 26,494,489.19。"],
    pointers: ["/views/topN-storeOrderAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /26,494,489\.19/);
  // Same integer part is accepted (integer-part rule)
  const same = validateCaptionSubmission({
    paragraphs: ["订货额 26494489.18。"],
    pointers: ["/views/topN-storeOrderAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(same.markdown, /26494489\.18/);
  // Different integer part is rejected
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["订货额写成 26494490.99。"],
    pointers: ["/views/topN-storeOrderAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 26494490\.99/);
});

test("submit_card_caption accepts wan/yi display forms of the same cell", () => {
  const evidence = buildCaptionEvidence({
    cardId: "regional-overview",
    query: {
      metrics: ["saleAmt", "custNum", "preProfitAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["sapArea2Id"],
    },
    rows: [{
      sapArea2Id: "CN01",
      saleAmt: 135758451.57,
      custNum: 5864373,
      preProfitAmt: 64637912.6018,
      saleAmt同比增长率: -11.54,
    }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["CN01 销售额 1.358 亿元、客流 586.4 万、税前利润 6463.8 万元，同比 -11.54%。"],
    pointers: [
      "/views/topN-saleAmt-sapArea2Id/rows/0",
      "/views/topN-custNum-sapArea2Id/rows/0",
      "/views/topN-preProfitAmt-sapArea2Id/rows/0",
    ],
  }, evidence);
  assert.match(ok.markdown, /1\.358 亿元/);
  assert.match(ok.markdown, /586\.4 万/);
  assert.match(ok.markdown, /6463\.8 万元/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["同比写成 0.001154。"],
    pointers: ["/views/topN-saleAmt-sapArea2Id/rows/0"],
  }, evidence), /caption rejected: number 0\.001154/);
});

test("submit_card_caption rejects numbers with a different integer part", () => {
  const evidence = buildCaptionEvidence({
    cardId: "per-cust",
    query: {
      metrics: ["perCustAmt"],
      statisticPolicy: "SALES_STORE_DAY_AVG",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN22", perCustAmt: 14.48 }],
  });
  // Same integer part (14) is now accepted — LLM may truncate or mis-transcribe decimals
  const ok = validateCaptionSubmission({
    paragraphs: ["CN22 客单价 14.89。"],
    pointers: ["/views/topN-perCustAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /14\.89/);
  // Different integer part (15) is rejected
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["CN22 客单价 15.89。"],
    pointers: ["/views/topN-perCustAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 15\.89/);
  // Carry rounding still accepted (9.995 → 10 in evidence, caption writes 10.00)
  const carry = buildCaptionEvidence({
    cardId: "carry",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", saleAmt: 9.995 }],
  });
  const carryOk = validateCaptionSubmission({
    paragraphs: ["CN01 为 10.00。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, carry);
  assert.match(carryOk.markdown, /10\.00/);
});

test("submit_card_caption accepts same-integer-part numbers (truncation, rounding, transcription)", () => {
  const evidence = buildCaptionEvidence({
    cardId: "trunc",
    query: {
      metrics: ["profitAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", profitAmt: 2199.295 }],
  });
  // Evidence rounds 2199.295 → 2199.3 (half-up on digit strings)
  // Integer-part check: any caption number with integer 2199 is accepted
  const exact = validateCaptionSubmission({
    paragraphs: ["CN01 毛利额 2199.3。"],
    pointers: ["/views/topN-profitAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(exact.markdown, /2199\.3/);
  // Trailing zero form
  const padded = validateCaptionSubmission({
    paragraphs: ["CN01 毛利额 2199.30。"],
    pointers: ["/views/topN-profitAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(padded.markdown, /2199\.30/);
  // Integer form
  const integer = validateCaptionSubmission({
    paragraphs: ["CN01 毛利额 2199。"],
    pointers: ["/views/topN-profitAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(integer.markdown, /2199/);
  // Transcription error (same integer, different decimals) — now accepted
  const typo = validateCaptionSubmission({
    paragraphs: ["CN01 毛利额 2199.99。"],
    pointers: ["/views/topN-profitAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(typo.markdown, /2199\.99/);
  // A completely different integer is still rejected
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["CN01 毛利额 2200。"],
    pointers: ["/views/topN-profitAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 2200/);
});

test("submit_card_caption accepts evidence.rowCount but rejects other counts", () => {
  const evidence = buildCaptionEvidence({
    cardId: "wide",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: Array.from({ length: 75 }, (_, index) => ({
      manageAreaId: `CN${String(index + 1).padStart(2, "0")}`,
      saleAmt: 1000 + index,
    })),
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["本期覆盖 75 行。最高为 1074。"],
    pointers: ["/views/topN-saleAmt-manageAreaId"],
  }, evidence);
  assert.match(ok.markdown, /75 行/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["大约 80 行。"],
    pointers: ["/views/topN-saleAmt-manageAreaId"],
  }, evidence), /caption rejected: number 80/);
});

test("submit_card_caption pointer budget equals the card view count", () => {
  const metrics = ["saleAmt", "custNum", "bf19SaleAmt", "preProfitAmt", "profitAmt", "receiveAmt", "saleDays"];
  const row = (manageAreaId, categoryLevel1Id, scale) => Object.fromEntries([
    ["manageAreaId", manageAreaId],
    ["categoryLevel1Id", categoryLevel1Id],
    ...metrics.map((metric) => [metric, scale]),
  ]);
  const evidence = buildCaptionEvidence({
    cardId: "national-ex-hk-mo-category-summary",
    query: {
      metrics,
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId", "categoryLevel1Id"],
    },
    rows: [row("CN01", "13", 23339723.3182), row("CN18", "10", 100)],
  });
  const viewIds = Object.keys(evidence.views);
  assert.equal(captionPointerBudget(evidence), viewIds.length);
  assert.ok(viewIds.length > 24);
  const pointers = viewIds.map((id) => `/views/${id}`);
  const ok = validateCaptionSubmission({
    paragraphs: ["CN01 receiveAmt 23339723.32。"],
    pointers,
  }, evidence);
  assert.match(ok.markdown, /23339723\.32/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["CN01 receiveAmt 23339723.3182。"],
    pointers: [...pointers, `/views/${viewIds[0]}/rows/0`],
  }, evidence), new RegExp(`pointers must contain at most ${viewIds.length} items`));
});

test("submit_card_caption accepts thousands separators that match evidence", () => {
  const evidence = buildCaptionEvidence({
    cardId: "one",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", saleAmt: 4484024 }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["销售额最高的是 CN01 的 4,484,024。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /4,484,024/);
});

test("prepareCardCaptionEvidence writes the packet next to entry.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "caption-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = join(root, ".harness", "state", "html-report", "s1");
  const cardId = "card-1";
  const cardDir = join(session, "data", "cards", cardId);
  await mkdir(cardDir, { recursive: true });
  const rows = [{ manageAreaId: "CN01", saleAmt: 12 }];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [{
      id: cardId,
      query: {
        request: {
          metrics: ["saleAmt"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-08-01", endDate: "2026-08-02" },
          dimensions: ["manageAreaId"],
          filters: {},
          pageNo: 1,
          pageSize: 500,
        },
        comparisons: [],
      },
    }],
  }));
  const prepared = await prepareCardCaptionEvidence({
    resultPath: join(session, "result.json"),
    cardId,
  });
  const persisted = JSON.parse(await readFile(prepared.evidencePath, "utf8"));
  assert.equal(persisted.producer, "prepare-card-caption-evidence.mjs");
  assert.ok(persisted.views["topN-saleAmt-manageAreaId"]);
  await writeCardCaption({
    input: {
      paragraphs: ["最高为 12。"],
      pointers: ["/views/topN-saleAmt-manageAreaId"],
    },
    evidencePath: prepared.evidencePath,
    captionPath: join(cardDir, "caption.md"),
  });
  assert.match(await readFile(join(cardDir, "caption.md"), "utf8"), /最高为 12/);
  assert.equal(captionViewId("topN", "saleAmt", ["manageAreaId"]), "topN-saleAmt-manageAreaId");
});

// ── validateCaptionSubmissionDetailed tests ──

test("validateCaptionSubmissionDetailed returns violations instead of throwing for bad numbers", () => {
  const evidence = buildCaptionEvidence({
    cardId: "det-1",
    query: { metrics: ["saleAmt"], statisticPolicy: "SUMMARY", dimensions: ["manageAreaId"] },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const result = validateCaptionSubmissionDetailed({
    paragraphs: ["合计 1100 最好。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.ok(Array.isArray(result.violations));
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, "NUMBER_NOT_IN_EVIDENCE");
  assert.match(result.violations[0].trigger, /1100/);
  assert.equal(result.violations[0].paragraphIndex, 0);
  assert.ok(result.violations[0].paragraphSnippet);
  // markdown still produced
  assert.match(result.markdown, /1100/);
});

test("validateCaptionSubmissionDetailed returns empty violations for valid caption", () => {
  const evidence = buildCaptionEvidence({
    cardId: "det-2",
    query: { metrics: ["saleAmt"], statisticPolicy: "SUMMARY", dimensions: ["manageAreaId"] },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const result = validateCaptionSubmissionDetailed({
    paragraphs: ["销售额最高的是 CN01 的 1000。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.equal(result.violations.length, 0);
  assert.match(result.markdown, /1000/);
});

test("validateCaptionSubmissionDetailed collects date and number violations together", () => {
  const evidence = buildCaptionEvidence({
    cardId: "det-3",
    query: { metrics: ["saleAmt"], statisticPolicy: "SUMMARY", dimensions: ["manageAreaId"] },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const result = validateCaptionSubmissionDetailed({
    paragraphs: ["2026-12-25 销售额 999。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence);
  const rules = result.violations.map((v) => v.rule);
  assert.ok(rules.includes("DATE_NOT_IN_EVIDENCE"));
  assert.ok(rules.includes("NUMBER_NOT_IN_EVIDENCE"));
});

test("writeCardCaption writes caption.md and violations.json when violations exist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "caption-detailed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cardDir = join(root, "card");
  await mkdir(cardDir, { recursive: true });
  const evidence = buildCaptionEvidence({
    cardId: "wc-1",
    query: { metrics: ["saleAmt"], statisticPolicy: "SUMMARY", dimensions: ["manageAreaId"] },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const evidencePath = join(cardDir, "caption-evidence.json");
  const captionPath = join(cardDir, "caption.md");
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await writeCardCaption({
    input: {
      paragraphs: ["合计 1100。"],
      pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
    },
    evidencePath,
    captionPath,
  });
  assert.ok(result.violations.length > 0);
  // caption.md written regardless of violations
  const md = await readFile(captionPath, "utf8");
  assert.match(md, /1100/);
  // violations.json written
  const vJson = JSON.parse(await readFile(violationsPathFor(captionPath), "utf8"));
  assert.ok(vJson.violations.length > 0);
  assert.equal(vJson.violations[0].rule, "NUMBER_NOT_IN_EVIDENCE");
});

test("writeCardCaption writes empty violations.json when no violations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "caption-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cardDir = join(root, "card");
  await mkdir(cardDir, { recursive: true });
  const evidence = buildCaptionEvidence({
    cardId: "wc-2",
    query: { metrics: ["saleAmt"], statisticPolicy: "SUMMARY", dimensions: ["manageAreaId"] },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  const evidencePath = join(cardDir, "caption-evidence.json");
  const captionPath = join(cardDir, "caption.md");
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await writeCardCaption({
    input: {
      paragraphs: ["销售额 1000。"],
      pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
    },
    evidencePath,
    captionPath,
  });
  assert.equal(result.violations.length, 0);
  const vJson = JSON.parse(await readFile(violationsPathFor(captionPath), "utf8"));
  assert.equal(vJson.violations.length, 0);
});

test("validateCaptionSubmission still throws on violations (backward compat)", () => {
  const evidence = buildCaptionEvidence({
    cardId: "bc-1",
    query: { metrics: ["saleAmt"], statisticPolicy: "SUMMARY", dimensions: ["manageAreaId"] },
    rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
  });
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["合计 1100。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /1100/);
});
