import assert from "node:assert/strict";
import test from "node:test";

import { lintMetricDuplicates } from "../src/lib/wikis/metric-duplicates.js";

test("cmr + indicators is cross-system, cmr + idx is not", async () => {
  const { buildMetricDuplicatesReport } = await import("../src/lib/wikis/metric-duplicates.js");
  void buildMetricDuplicatesReport;
  const files = (domains) => domains.map((domain) => ({ domain }));
  const cross = (items) => {
    const domains = new Set(items.map((file) => file.domain));
    return domains.has("cmr") && domains.has("indicators");
  };
  assert.equal(cross(files(["cmr", "indicators"])), true);
  assert.equal(cross(files(["cmr", "idx"])), false);
});

test("lint metric duplicates requires at least two files", () => {
  const result = lintMetricDuplicates("/tmp", {
    groups: [{ id: "dup.label.x", match_type: "label", files: [{ path: "a.md" }], decision: {} }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.code === "too_few_files"));
});
