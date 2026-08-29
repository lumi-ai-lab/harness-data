import assert from "node:assert/strict";
import test from "node:test";

import { verifyWikiRelocation } from "./verify-wikis-relocation.mjs";

test("pinned Wikis indexes remain usable after relocation", async () => {
  const report = await verifyWikiRelocation();
  assert.equal(report.ok, true);
  assert.match(report.revision, /^[a-f0-9]{64}$/);
  assert.ok(report.docCount > 0);
  assert.ok(report.recallCount > 0);
  assert.ok(report.contextFileCount > 0);
  assert.ok(report.responseFileCount > 0);
});
