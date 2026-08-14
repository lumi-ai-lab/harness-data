import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMain } from "../scripts/compose-main.mjs";
import { rowsSha256 } from "../scripts/fetch-entry.mjs";
import {
  approvePipelineStage,
  finishPipelineStage,
  initPipeline,
  startPipelineStage,
} from "../scripts/stage-gate.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedSession(t, { cards, title = "区域客数报告", status = "confirmed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "html-report-compose-main-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  const resultCards = [];
  for (const card of cards) {
    resultCards.push({ id: card.id, title: card.title });
    if (card.skipFiles) continue;
    await mkdir(join(session, "data", "cards", card.id), { recursive: true });
    const rows = card.rows ?? [];
    await writeFile(join(session, "data", "cards", card.id, "entry.json"), JSON.stringify(rows));
    const meta = card.meta ?? { rowCount: rows.length, rowsSha256: rowsSha256(rows) };
    await writeFile(join(session, "data", "cards", card.id, "entry.meta.json"), JSON.stringify(meta));
    if (!card.skipFiles) {
      await writeFile(
        join(session, "data", "cards", card.id, "caption.md"),
        `${card.caption || `卡片 ${card.id} 最高为 ${card.rows?.[0] ? Object.values(card.rows[0])[1] ?? 0 : 0}。`}\n`
      );
    }
  }
  await writeFile(join(session, "result.json"), JSON.stringify({ status, title, cards: resultCards }));
  return session;
}

test("compose-main writes tables in result.json card order with original values", async (t) => {
  const session = await seedSession(t, {
    cards: [
      {
        id: "south",
        title: "南方",
        rows: [{ 区域: "华南", 客数: 12 }],
      },
      {
        id: "north",
        title: "北方",
        rows: [{ 区域: "华北", 客数: 34 }],
      },
    ],
  });

  const output = await composeMain(session);
  const main = await readFile(output.mainPath, "utf8");

  assert.equal(output.mainPath, join(session, "analysis", "main.md"));
  assert.deepEqual(output.cardIds, ["south", "north"]);
  assert.match(main, /^# 区域客数报告\n/);
  assert.match(main, /html-report:full-table card="south" rows="1"/);
  assert.match(main, /html-report:full-table card="north" rows="1"/);
  assert.match(main, /华南/);
  assert.match(main, /12/);
  assert.match(main, /华北/);
  assert.match(main, /34/);
  assert.ok(main.indexOf("南方") < main.indexOf("北方"));
  assert.ok(main.indexOf("华南") < main.indexOf("华北"));
  assert.match(main, /### 分析/);
  assert.match(main, /卡片 south 最高为 12/);
  assert.match(main, /卡片 north 最高为 34/);
});

test("compose-main keeps a successful zero-row card in place", async (t) => {
  const session = await seedSession(t, {
    cards: [{ id: "empty", title: "空卡", rows: [] }],
  });

  const output = await composeMain(session);
  const main = await readFile(output.mainPath, "utf8");
  assert.match(main, /html-report:full-table card="empty" rows="0"/);
  assert.match(main, /本次查询返回 0 行明细/);
});

test("compose-main fails on a missing caption and does not write main.md", async (t) => {
  const session = await seedSession(t, {
    cards: [{ id: "south", title: "南方", rows: [{ 区域: "华南", 客数: 12 }] }],
  });
  await rm(join(session, "data", "cards", "south", "caption.md"));

  await assert.rejects(() => composeMain(session), /caption\.md for card south is missing/);
  assert.equal(await exists(join(session, "analysis", "main.md")), false);
});

test("compose-main fails on a missing entry and does not write main.md", async (t) => {
  const session = await seedSession(t, {
    cards: [{ id: "missing", title: "缺文件", skipFiles: true }],
  });

  await assert.rejects(() => composeMain(session), /entry\.json for card missing is missing/);
  assert.equal(await exists(join(session, "analysis", "main.md")), false);
});

test("compose-main fails on rowCount mismatch and leaves a previous main.md untouched", async (t) => {
  const session = await seedSession(t, {
    cards: [{
      id: "bad",
      title: "坏卡",
      rows: [{ 区域: "华东", 客数: 9 }],
      meta: { rowCount: 99, rowsSha256: rowsSha256([{ 区域: "华东", 客数: 9 }]) },
    }],
  });
  await mkdir(join(session, "analysis"), { recursive: true });
  const previous = "# 旧稿\n";
  await writeFile(join(session, "analysis", "main.md"), previous);

  await assert.rejects(
    () => composeMain(session),
    /rowCount does not match entry\.json for card bad/,
  );
  assert.equal(await readFile(join(session, "analysis", "main.md"), "utf8"), previous);
});

test("compose-main fails on rowsSha256 mismatch", async (t) => {
  const session = await seedSession(t, {
    cards: [{
      id: "hash",
      title: "哈希坏卡",
      rows: [{ 区域: "华东", 客数: 9 }],
      meta: { rowCount: 1, rowsSha256: "0".repeat(64) },
    }],
  });

  await assert.rejects(
    () => composeMain(session),
    /rowsSha256 does not match entry\.json for card hash/,
  );
  assert.equal(await exists(join(session, "analysis", "main.md")), false);
});

test("compose-main then B2_MAIN finish waits for 继续", async (t) => {
  const session = await seedSession(t, {
    cards: [{ id: "south", title: "南方", rows: [{ 区域: "华南", 客数: 12 }] }],
  });
  await initPipeline(session, { mode: "step" });
  await startPipelineStage(session, "A_CONFIG");
  await finishPipelineStage(session, "A_CONFIG");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B0_PREFLIGHT");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B2_WRITER");

  const composed = await composeMain(session);
  const finished = await finishPipelineStage(session, "B2_MAIN");
  assert.equal(composed.mainPath, join(session, "analysis", "main.md"));
  assert.equal(finished.state.currentStage, "B2_MAIN");
  assert.equal(finished.state.status, "awaiting_approval");
  assert.match(await readFile(composed.mainPath, "utf8"), /华南/);

  const approved = await approvePipelineStage(session);
  assert.equal(approved.state.status, "completed");
  assert.equal(approved.state.stages.B25_EDITOR, undefined);
});
