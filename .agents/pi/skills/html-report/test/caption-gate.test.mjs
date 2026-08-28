import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCaptionEvidence } from "../scripts/prepare-card-caption-evidence.mjs";
import { writeCardCaption, violationsPathFor } from "../scripts/submit-card-caption.mjs";
import { sanitizeCardId, writerReturnPaths } from "../scripts/writer-return.mjs";
import { cmdCheck, cmdWaive, cmdRevalidate, cmdStatus } from "../scripts/caption-gate.mjs";

function makeResultJson(sessionDir, cards) {
  return {
    status: "confirmed",
    cards: cards.map((c) => ({
      id: c.id,
      query: {
        request: {
          metrics: c.metrics || ["saleAmt"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-08-01", endDate: "2026-08-02" },
          dimensions: c.dims || ["manageAreaId"],
          filters: {},
          pageNo: 1,
          pageSize: 500,
        },
        comparisons: [],
      },
    })),
  };
}

async function setupSession(cardSpecs) {
  const root = await mkdtemp(join(tmpdir(), "caption-gate-"));
  const sessionDir = join(root, ".harness", "state", "html-report", "test-session");
  await mkdir(sessionDir, { recursive: true });
  const result = makeResultJson(sessionDir, cardSpecs);
  const resultPath = join(sessionDir, "result.json");
  await writeFile(resultPath, JSON.stringify(result));
  for (const spec of cardSpecs) {
    const paths = writerReturnPaths({ sessionDir, cardId: spec.id });
    await mkdir(join(sessionDir, "data", "cards", sanitizeCardId(spec.id)), { recursive: true });
    const evidence = buildCaptionEvidence({
      cardId: spec.id,
      query: {
        metrics: spec.metrics || ["saleAmt"],
        statisticPolicy: "SUMMARY",
        dimensions: spec.dims || ["manageAreaId"],
      },
      rows: spec.rows,
    });
    await writeFile(paths.evidencePath, JSON.stringify(evidence));
    if (spec.caption) {
      await writeCardCaption({
        input: spec.caption,
        evidencePath: paths.evidencePath,
        captionPath: paths.captionPath,
      });
    }
  }
  return { root, sessionDir, resultPath };
}

test("cmdCheck returns no violations when all captions are clean", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["销售额 1000。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = await cmdCheck(sessionDir);
  assert.equal(gate.totalViolations, 0);
  assert.equal(gate.cards[0].status, "resolved");
});

test("cmdCheck detects violations from caption.md.violations.json", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["合计 1100。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
    { id: "c2", rows: [{ manageAreaId: "CN01", saleAmt: 500 }],
      caption: { paragraphs: ["销售额 500。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = await cmdCheck(sessionDir);
  assert.equal(gate.totalViolations, 1);
  assert.equal(gate.cards[0].status, "pending");
  assert.equal(gate.cards[0].cardId, "c1");
  assert.equal(gate.cards[0].violations[0].rule, "NUMBER_NOT_IN_EVIDENCE");
  assert.equal(gate.cards[1].status, "resolved");
});

test("cmdWaive marks a card as waived", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["合计 1100。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await cmdCheck(sessionDir);
  const gate = await cmdWaive(sessionDir, "c1");
  assert.equal(gate.cards[0].status, "waived");
  assert.ok(gate.cards[0].waivedAt);
});

test("cmdRevalidate re-checks after caption.md is edited", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["合计 1100。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await cmdCheck(sessionDir);
  // Fix the caption
  const paths = writerReturnPaths({ sessionDir, cardId: "c1" });
  await writeFile(paths.captionPath, "销售额 1000。\n");
  const gate = await cmdRevalidate(sessionDir, "c1");
  assert.equal(gate.cards[0].status, "resolved");
  assert.equal(gate.cards[0].violationCount, 0);
});

test("cmdRevalidate detects new violations after edit", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["销售额 1000。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await cmdCheck(sessionDir); // no violations initially
  // Introduce a bad number
  const paths = writerReturnPaths({ sessionDir, cardId: "c1" });
  await writeFile(paths.captionPath, "销售额 9999。\n");
  const gate = await cmdRevalidate(sessionDir, "c1");
  assert.equal(gate.cards[0].status, "pending");
  assert.equal(gate.cards[0].violations[0].rule, "NUMBER_NOT_IN_EVIDENCE");
});

test("cmdStatus reports pending and resolved counts", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["合计 1100。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
    { id: "c2", rows: [{ manageAreaId: "CN01", saleAmt: 500 }],
      caption: { paragraphs: ["销售额 500。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await cmdCheck(sessionDir);
  const status = await cmdStatus(sessionDir);
  assert.equal(status.exists, true);
  assert.equal(status.pending, 1);
  assert.equal(status.resolved, 1);
  assert.equal(status.pendingCards[0].cardId, "c1");
});

test("cmdStatus returns exists=false when gate file missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "caption-gate-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = await cmdStatus(root);
  assert.equal(status.exists, false);
});

test("cmdWaive throws for unknown cardId", async (t) => {
  const { root, sessionDir } = await setupSession([
    { id: "c1", rows: [{ manageAreaId: "CN01", saleAmt: 1000 }],
      caption: { paragraphs: ["合计 1100。"], pointers: ["/views/topN-saleAmt-manageAreaId/rows/0"] } },
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await cmdCheck(sessionDir);
  await assert.rejects(() => cmdWaive(sessionDir, "unknown-card"), /not found/);
});
