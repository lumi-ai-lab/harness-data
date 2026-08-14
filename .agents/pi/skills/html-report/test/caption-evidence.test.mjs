import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCaptionAxis, captionPrefixes, captionViewId } from "../scripts/caption-dims.mjs";
import {
  buildCaptionEvidence,
  prepareCardCaptionEvidence,
} from "../scripts/prepare-card-caption-evidence.mjs";
import {
  captionPointerBudget,
  extractCaptionTokens,
  validateCaptionSubmission,
  writeCardCaption,
} from "../scripts/submit-card-caption.mjs";

test("caption axis keeps three in-group dims and drops the rest", () => {
  const built = buildCaptionAxis([
    "storeId",
    "cityId",
    "manageAreaId",
    "sapArea2Id",
    "totalArea",
    "bizDate",
  ]);
  assert.deepEqual(built.axis, ["sapArea2Id", "manageAreaId", "cityId"]);
  assert.deepEqual(built.droppedDimensions, ["totalArea", "bizDate", "storeId"]);
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

test("caption tokens treat thousands separators as one number", () => {
  const tokens = extractCaptionTokens("CN01以4,484,024居首，CN20为1,313,823。");
  assert.deepEqual(tokens.numbers, ["4484024", "1313823"]);
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
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["销售额写成 49459。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 49459/);
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
  const ok = validateCaptionSubmission({
    paragraphs: ["CN01 订货额 26,494,489.19。"],
    pointers: ["/views/topN-storeOrderAmt-manageAreaId/rows/0"],
  }, evidence);
  assert.match(ok.markdown, /26,494,489\.19/);
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["订货额写成 26494489.18。"],
    pointers: ["/views/topN-storeOrderAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 26494489\.18/);
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

test("submit_card_caption rejects same-integer numbers from a different cell", () => {
  const evidence = buildCaptionEvidence({
    cardId: "per-cust",
    query: {
      metrics: ["perCustAmt"],
      statisticPolicy: "SALES_STORE_DAY_AVG",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN22", perCustAmt: 14.48 }],
  });
  assert.throws(() => validateCaptionSubmission({
    paragraphs: ["CN22 客单价 14.89。"],
    pointers: ["/views/topN-perCustAmt-manageAreaId/rows/0"],
  }, evidence), /caption rejected: number 14\.89/);
  const carry = buildCaptionEvidence({
    cardId: "carry",
    query: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      dimensions: ["manageAreaId"],
    },
    rows: [{ manageAreaId: "CN01", saleAmt: 9.995 }],
  });
  const ok = validateCaptionSubmission({
    paragraphs: ["CN01 为 10.00。"],
    pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"],
  }, carry);
  assert.match(ok.markdown, /10\.00/);
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
    paragraphs: ["CN01 receiveAmt 23339723.3182。"],
    pointers,
  }, evidence);
  assert.match(ok.markdown, /23339723\.3182/);
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
