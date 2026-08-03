import assert from "node:assert/strict";
import test from "node:test";

import { generateApprovedMetricCatalog } from "./generate-approved-metrics.mjs";

test("generates every published metric compatible with protected scopes", () => {
  const catalog = generateApprovedMetricCatalog({
    compiled: {
      effectiveDimensions: {
        profitRate: ["manageAreaId", "categoryLevel1Id", "storeId"]
      }
    },
    metrics: {
      saleAmt: {
        code: "saleAmt",
        status: "published",
        supportedDimensions: ["bizDate", "manageAreaId", "categoryLevel1Id"]
      },
      bf19CustNum: {
        code: "bf19CustNum",
        status: "published",
        supportedDimensions: ["manageAreaId", "categoryLevel1Id", "storeId"]
      },
      warehouseOnly: {
        code: "warehouseOnly",
        status: "published",
        supportedDimensions: ["bizDate", "warehouseId"]
      },
      blockedMetric: {
        code: "blockedMetric",
        status: "blocked",
        supportedDimensions: ["manageAreaId", "categoryLevel1Id"]
      },
      profitRate: {
        code: "profitRate",
        status: "published",
        supportedDimensions: null
      }
    }
  });

  assert.deepEqual(Object.keys(catalog.metrics), ["bf19CustNum", "profitRate", "saleAmt"]);
  assert.deepEqual(catalog.metrics.saleAmt, {
    supportedDimensions: ["bizDate", "manageAreaId", "categoryLevel1Id"],
    dictionaryRefs: []
  });
  assert.deepEqual(catalog.metrics.profitRate, {
    supportedDimensions: ["manageAreaId", "categoryLevel1Id", "storeId"],
    dictionaryRefs: []
  });
});

test("rejects malformed registry contracts", () => {
  assert.throws(
    () =>
      generateApprovedMetricCatalog({
        metrics: {
          saleAmt: {
            code: "anotherCode",
            status: "published",
            supportedDimensions: ["manageAreaId", "categoryLevel1Id"]
          }
        }
      }),
    /code does not match/
  );
  assert.throws(
    () =>
      generateApprovedMetricCatalog({
        metrics: {
          saleAmt: {
            code: "saleAmt",
            status: "published",
            supportedDimensions: ["manageAreaId", "categoryLevel1Id", "manageAreaId"]
          }
        }
      }),
    /duplicate dimension/
  );
});
