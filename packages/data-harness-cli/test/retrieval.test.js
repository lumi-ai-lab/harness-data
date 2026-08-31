import assert from "node:assert/strict";
import test from "node:test";

import { ngrams, normalizeChinese, search } from "../src/lib/retrieval.js";

test("normalizeChinese", () => {
  assert.equal(normalizeChinese(" 会员，复购率！ＡＢＣ１２３ abc-_%　"), "会员复购率abc123abc");
});

test("ngrams", () => {
  assert.equal(ngrams("会员复购率", 2).join(","), "会员,员复,复购,购率");
  assert.equal(ngrams("会员复购率", 3).join(","), "会员复,员复购,复购率");
});

test("search fuzzy matches member repurchase rate", () => {
  const matches = search([{ term: "会员复购率", targetPath: "spec/member-repurchase-rate.md" }], "会员复购为什么下降");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].exact, false);
  assert.equal(matches[0].matchType, "fuzzy");
  assert.ok(Math.abs(matches[0].bigramCoverage - 0.75) < 0.0001);
  assert.equal(matches[0].matchedBigrams.join(","), "会员,员复,复购");
});

test("search prefers long exact term and suppresses short term", () => {
  const matches = search(
    [
      { term: "会员复购率", targetPath: "spec/member-repurchase-rate.md" },
      { term: "19点前滚动7天会员复购率", targetPath: "spec/bf19-member-repurchase-rate.md" },
    ],
    "19点前滚动7天会员复购率",
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].term, "19点前滚动7天会员复购率");
  assert.equal(matches[0].exact, true);
});
