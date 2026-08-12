import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  normalizeEntryPayload,
  buildExecuteArgs,
  fetchAllEntries,
  indicatorsFetchBudgetMs,
  isIndicatorsTimeout,
  isRetryableIndicatorsFailure,
  shouldRetryIndicatorsFailure,
  parseEntryMetaResponse,
  reusableEntry,
  rowsSha256,
} from "../scripts/fetch-entry.mjs";
import {
  buildWriterReturnSchema,
  buildWriterSubmitSchema,
  parseWriterReturnText,
  validateWriterReturn,
  writerReturnPaths,
} from "../scripts/writer-return.mjs";
import { writerCoordinationDecision } from "../../../extensions/report-writer-fetch/lifecycle.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);

test("normalizeEntryPayload keeps all-pages friendly pageSize and currPage=1", () => {
  const payload = normalizeEntryPayload({
    indicatorFieldList: ["saleAmt"],
    aggDimUniqueCodeList: ["incDate"],
    startDate: "2026-07-01",
    endDate: "2026-07-14",
    currPage: 3,
    pageSize: 500,
    chartType: "table",
  });
  assert.equal(payload.currPage, 1);
  assert.equal(payload.pageSize, 500);
  assert.deepEqual(payload.indicatorFieldList, ["saleAmt"]);
});

test("normalizeEntryPayload caps pageSize at 5000", () => {
  const payload = normalizeEntryPayload({ pageSize: 99999, indicatorFieldList: ["a"] });
  assert.equal(payload.pageSize, 5000);
});

test("B2 execute args enable meta but never single-page", () => {
  const args = buildExecuteArgs(
    normalizeEntryPayload({
      indicatorFieldList: ["saleAmt"],
      aggDimUniqueCodeList: ["incDate"],
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      pageSize: 500,
    }),
    { meta: true }
  );
  assert.equal(args[0], "analysis");
  assert.equal(args[1], "execute");
  assert.ok(args.includes("--payload-json"));
  assert.ok(!args.includes("--single-page"), "report fetch must pull all pages");
  assert.ok(args.includes("--meta"), "B2 must request the minimal CLI metadata contract");
  const json = JSON.parse(args[args.indexOf("--payload-json") + 1]);
  assert.equal(json.pageSize, 500);
  assert.equal(json.currPage, 1);
});

test("execute args omit meta unless a report adapter opts in", () => {
  const args = buildExecuteArgs({ chartType: "table" });
  assert.ok(!args.includes("--meta"));
});

test("Writer timeout classifier stops backend timeouts but preserves fast retries", () => {
  assert.equal(isIndicatorsTimeout({ errorCode: "ETIMEDOUT" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "upstream request timeout exceeded" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stdout: "指标查询超时" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "HTTP 504" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "status code: 408" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "connection reset" }), false);
  assert.equal(
    isIndicatorsTimeout({ status: 0, error: "", stdout: '{"rows":[{"label":"timeout"}]}' }),
    false
  );
});

test("Indicators retries use a transient allowlist", () => {
  assert.equal(isRetryableIndicatorsFailure({ status: 1, errorCode: "ECONNRESET" }), true);
  assert.equal(isRetryableIndicatorsFailure({ status: 1, stderr: "HTTP 503 service unavailable" }), true);
  assert.equal(isRetryableIndicatorsFailure({ status: 1, stderr: "invalid record id 503" }), false);
  assert.equal(isRetryableIndicatorsFailure({ status: 1, stderr: "HTTP 425 too early" }), false);
  assert.equal(isRetryableIndicatorsFailure({ status: 1, stderr: "HTTP 418 service unavailable" }), false);
  assert.equal(isRetryableIndicatorsFailure({ status: 1, stderr: "temporarily invalid parameter" }), false);
  assert.equal(isRetryableIndicatorsFailure({ status: 1, stderr: "HTTP 401 unauthorized" }), false);
  assert.equal(
    isRetryableIndicatorsFailure({ status: 1, errorCode: "ECONNRESET", stderr: "HTTP 401 unauthorized" }),
    false
  );
  assert.equal(isRetryableIndicatorsFailure({ status: 1, errorCode: "ENOENT" }), false);
  assert.equal(isRetryableIndicatorsFailure({ status: null, signal: "SIGKILL" }), false);
  assert.equal(isRetryableIndicatorsFailure({ status: 0, stdout: "not json" }, { parseError: "invalid JSON" }), false);
  assert.equal(shouldRetryIndicatorsFailure({ status: 1, stderr: "HTTP 503", durationMs: 100 }), true);
  assert.equal(shouldRetryIndicatorsFailure({ status: 1, stderr: "HTTP 503", durationMs: 15_001 }), false);
  assert.equal(indicatorsFetchBudgetMs({}), 540_000);
  assert.equal(indicatorsFetchBudgetMs({ QDM_INDICATORS_FETCH_BUDGET_MS: "900000" }), 540_000);
  assert.equal(indicatorsFetchBudgetMs({ QDM_INDICATORS_FETCH_BUDGET_MS: "1000" }), 1_000);
});

test("parseEntryMetaResponse accepts only the three-field CLI contract", () => {
  const parsed = parseEntryMetaResponse(JSON.stringify({
    rows: [{ id: 1 }, { id: 2 }],
    rowCount: 2,
    rowsSha256: "a".repeat(64),
  }));
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.rows.length, 2);
  assert.throws(
    () => parseEntryMetaResponse(JSON.stringify({ rows: [], rowCount: 0, rowsSha256: "a".repeat(64), extra: true })),
    /exactly rows, rowCount, rowsSha256/
  );
  assert.throws(
    () => parseEntryMetaResponse(JSON.stringify({ rows: [{ id: 1 }], rowCount: 2, rowsSha256: "a".repeat(64) })),
    /rowCount/
  );
});

test("fetchAllEntries rejects result.json without confirmed status before CLI", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-status-"));
  const session = join(rootDir, ".harness", "state", "html-report", "missing-status");
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    cards: [{ id: "c1", requestBody: { indicatorFieldList: ["saleAmt"] } }],
  }));
  await assert.rejects(
    () => fetchAllEntries(resultPath, { cardId: "c1" }),
    /result\.status must be confirmed/
  );
});

test("fetch-entry attempts CAS once and skips Indicators when auth fails", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-auth-"));
  const session = join(rootDir, ".harness", "state", "html-report", "auth");
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: { indicatorFieldList: ["saleAmt"] } }],
  }));

  const casCountPath = join(rootDir, "cas-count.txt");
  const indicatorsCountPath = join(rootDir, "indicators-count.txt");
  const fakeCas = join(rootDir, "fake-cas.sh");
  const fakeIndicators = join(rootDir, "fake-indicators.sh");
  await writeFile(fakeCas, [
    "#!/bin/sh",
    "count=0",
    "if [ -f \"$FAKE_CAS_COUNT_PATH\" ]; then count=$(sed -n '1p' \"$FAKE_CAS_COUNT_PATH\"); fi",
    "count=$((count + 1))",
    "printf '%s' \"$count\" > \"$FAKE_CAS_COUNT_PATH\"",
    "exit 1",
    "",
  ].join("\n"));
  await writeFile(fakeIndicators, [
    "#!/bin/sh",
    "printf 'called' > \"$FAKE_INDICATORS_COUNT_PATH\"",
    "exit 1",
    "",
  ].join("\n"));
  await Promise.all([chmod(fakeCas, 0o755), chmod(fakeIndicators, 0o755)]);

  const fetchEntryScript = fileURLToPath(new URL("../scripts/fetch-entry.mjs", import.meta.url));
  const env = {
    ...process.env,
    QDM_CAS_CLI: fakeCas,
    QDM_INDICATORS_CLI: fakeIndicators,
    FAKE_CAS_COUNT_PATH: casCountPath,
    FAKE_INDICATORS_COUNT_PATH: indicatorsCountPath,
  };
  delete env.QDM_INDICATORS_TOKEN;
  const run = spawnSync(process.execPath, [
    fetchEntryScript,
    "--result", resultPath,
    "--card-id", "c1",
  ], { encoding: "utf8", env });

  assert.equal(run.status, 1, run.stderr || run.stdout);
  assert.equal(await readFile(casCountPath, "utf8"), "1");
  await assert.rejects(() => stat(indicatorsCountPath), /ENOENT/);
  const output = JSON.parse(run.stdout);
  assert.equal(output.cards[0].error, "AUTH_TOKEN_FAILED: unable to obtain Indicators token");
  assert.deepEqual(output.cards[0].attempts, []);
});

test("fetch-entry does not retry permanent CLI or response-contract failures", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-terminal-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));

  const fakeIndicators = join(rootDir, "fake-indicators.sh");
  await writeFile(fakeIndicators, [
    "#!/bin/sh",
    "count=0",
    "if [ -f \"$FAKE_INDICATORS_COUNT_PATH\" ]; then count=$(sed -n '1p' \"$FAKE_INDICATORS_COUNT_PATH\"); fi",
    "count=$((count + 1))",
    "printf '%s' \"$count\" > \"$FAKE_INDICATORS_COUNT_PATH\"",
    "if [ \"$FAKE_INDICATORS_MODE\" = \"unauthorized\" ]; then",
    "  printf '%s\\n' 'HTTP 401 unauthorized' >&2",
    "  exit 1",
    "fi",
    "printf '%s\\n' 'not-json'",
    "exit 0",
    "",
  ].join("\n"));
  await chmod(fakeIndicators, 0o755);

  const fetchEntryScript = fileURLToPath(new URL("../scripts/fetch-entry.mjs", import.meta.url));
  for (const mode of ["unauthorized", "invalid-json"]) {
    const session = join(rootDir, ".harness", "state", "html-report", mode);
    await mkdir(session, { recursive: true });
    const resultPath = join(session, "result.json");
    await writeFile(resultPath, JSON.stringify({
      status: "confirmed",
      cards: [{ id: "c1", requestBody: { indicatorFieldList: ["saleAmt"] } }],
    }));
    const countPath = join(rootDir, `${mode}-count.txt`);
    const run = spawnSync(process.execPath, [
      fetchEntryScript,
      "--result", resultPath,
      "--card-id", "c1",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        QDM_INDICATORS_TOKEN: "test-token",
        QDM_INDICATORS_CLI: fakeIndicators,
        FAKE_INDICATORS_COUNT_PATH: countPath,
        FAKE_INDICATORS_MODE: mode,
      },
    });

    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(await readFile(countPath, "utf8"), "1", `${mode} must terminate after one CLI call`);
    const output = JSON.parse(run.stdout);
    assert.equal(output.cards[0].attempts.length, 1);
    assert.match(
      output.cards[0].error,
      mode === "unauthorized" ? /401 unauthorized/i : /invalid JSON/i
    );
  }
});

test("Writer retry reuses an intact entry/meta pair without calling CLI or rewriting files", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-reuse-"));
  const session = join(rootDir, ".harness", "state", "html-report", "reuse");
  const cardDir = join(session, "data", "cards", "c1");
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await mkdir(cardDir, { recursive: true });

  const rows = [{ 日期: "2026-07-01", 销售额: 100 }, { 日期: "2026-07-02", 销售额: 120 }];
  const entryText = `${JSON.stringify(rows, null, 2)}\n`;
  const metaText = `${JSON.stringify({ rowCount: rows.length, rowsSha256: rowsSha256(rows) }, null, 2)}\n`;
  const entryPath = join(cardDir, "entry.json");
  const metaPath = join(cardDir, "entry.meta.json");
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: { indicatorFieldList: ["saleAmt"] } }],
  }));
  await writeFile(entryPath, entryText);
  await writeFile(metaPath, metaText);

  const output = await fetchAllEntries(resultPath, { cardId: "c1" });
  assert.equal(output.cards.length, 1);
  assert.equal(output.cards[0].fetchStatus, "success");
  assert.equal(output.cards[0].rowCount, rows.length);
  assert.equal(output.cards[0].rowsSha256, rowsSha256(rows));
  assert.deepEqual(output.cards[0].attempts, [], "reuse must not invoke analysis execute");
  assert.equal(await readFile(entryPath, "utf8"), entryText);
  assert.equal(await readFile(metaPath, "utf8"), metaText);
});

test("Writer retry rejects an entry/meta pair older than the confirmed result", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-stale-"));
  const cardDir = join(rootDir, "data", "cards", "c1");
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await mkdir(cardDir, { recursive: true });
  const rows = [{ id: 1 }];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: 1,
    rowsSha256: rowsSha256(rows),
  }));

  assert.equal(
    await reusableEntry(cardDir, { notBeforeMs: Date.now() + 1_000 }),
    null,
    "artifacts from an earlier confirmation must not be reused"
  );
});

test("Writer retry rejects incomplete or unverifiable entry/meta pairs", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-invalid-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const rows = [{ id: 1 }];
  const cases = [
    {
      name: "extra-meta-field",
      rows,
      meta: { rowCount: 1, rowsSha256: rowsSha256(rows), extra: true },
    },
    {
      name: "row-count-mismatch",
      rows,
      meta: { rowCount: 2, rowsSha256: rowsSha256(rows) },
    },
    {
      name: "hash-mismatch",
      rows,
      meta: { rowCount: 1, rowsSha256: "0".repeat(64) },
    },
    {
      name: "non-row-entry",
      rows: [1],
      meta: { rowCount: 1, rowsSha256: rowsSha256([1]) },
    },
  ];
  for (const invalid of cases) {
    const cardDir = join(rootDir, invalid.name);
    await mkdir(cardDir, { recursive: true });
    await writeFile(join(cardDir, "entry.json"), JSON.stringify(invalid.rows));
    await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify(invalid.meta));
    assert.equal(
      await reusableEntry(cardDir, { notBeforeMs: 0 }),
      null,
      `${invalid.name} must force a fresh fetch`
    );
  }

  const partialDir = join(rootDir, "partial");
  await mkdir(partialDir, { recursive: true });
  await writeFile(join(partialDir, "entry.json"), JSON.stringify(rows));
  assert.equal(await reusableEntry(partialDir, { notBeforeMs: 0 }), null);

  const externalDir = join(rootDir, "external");
  const linkedDir = join(rootDir, "linked");
  await mkdir(externalDir, { recursive: true });
  await mkdir(linkedDir, { recursive: true });
  await writeFile(join(externalDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(externalDir, "entry.meta.json"), JSON.stringify({
    rowCount: 1,
    rowsSha256: rowsSha256(rows),
  }));
  await symlink(join(externalDir, "entry.json"), join(linkedDir, "entry.json"));
  await symlink(join(externalDir, "entry.meta.json"), join(linkedDir, "entry.meta.json"));
  assert.equal(
    await reusableEntry(linkedDir, { notBeforeMs: 0 }),
    null,
    "reuse must never trust symlinked cache files"
  );
});

test("Writer retry can reuse a valid zero-row CLI result", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-empty-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFile(join(rootDir, "entry.json"), "[]\n");
  await writeFile(join(rootDir, "entry.meta.json"), JSON.stringify({
    rowCount: 0,
    rowsSha256: rowsSha256([]),
  }));
  assert.deepEqual(await reusableEntry(rootDir, { notBeforeMs: 0 }), {
    rows: [],
    rowCount: 0,
    rowsSha256: rowsSha256([]),
  });
});

test("Report Writer child extension blocks supervisor detach channels", () => {
  for (const toolName of ["contact_supervisor", "intercom"]) {
    const decision = writerCoordinationDecision({ toolName });
    assert.equal(decision.block, true);
    assert.match(decision.reason, /不允许进入/);
  }
  assert.equal(writerCoordinationDecision({ toolName: "structured_output" }), undefined);
});

test("skill and pipeline docs require full pagination for fetch-entry", async () => {
  const skill = await readFile(join(root, ".agents/pi/skills/html-report/SKILL.md"), "utf8");
  const pipeline = await readFile(join(root, "docs/html-report-pipeline.md"), "utf8");
  assert.match(skill, /fetch-entry\.mjs/);
  assert.match(skill, /Never.*--single-page|禁止.*single-page|all-pages|全量分页|card-id/i);
  assert.match(skill, /report-writer|Report Writer|summary-only/i);
  assert.match(pipeline, /必须拉全部分页|all-pages|Never.*single-page|report-writer|Report Writer/i);
  assert.match(pipeline, /P3|Report Researcher|Report Reviewer|HTML|Researcher|Reviewer/i);
});

test("B2.5 uses one typed Planner and extension-owned deterministic materialization", async () => {
  const skill = await readFile(join(root, ".agents/pi/skills/html-report/SKILL.md"), "utf8");
  const pipeline = await readFile(join(root, "docs/html-report-pipeline.md"), "utf8");
  const b25 = skill.slice(skill.indexOf("### B2.5"), skill.indexOf("### B3.5"));
  assert.match(b25, /IMMEDIATE B25 TOOL MESSAGE[\s\S]*stage-gate status[\s\S]*--source-fields/i);
  assert.match(b25, /两个 Bash 都成功后[\s\S]*事件桥派发[\s\S]*context: "fresh"[\s\S]*report-researcher/);
  assert.match(b25, /不得再[\s\S]*Writer 文件[\s\S]*临时子代理目录/);
  assert.match(b25, /同一 `fromCardId`[\s\S]*合并为[\s\S]*一张 task/);
  assert.match(b25, /operations 必须最小且不重叠[\s\S]*每 task 最多六个/);
  assert.match(b25, /reuse_entry[\s\S]*new_query/);
  assert.match(b25, /main\.md[\s\S]*禁止复制明细行或样例表[\s\S]*Markdown\/HTML 表格/);
  assert.match(b25, /researchTasks\[\][\s\S]*完整[\s\S]*task[\s\S]*evidencePath/);
  assert.match(b25, /禁止手工 `write\/edit`[\s\S]*禁止手工[\s\S]*stage-gate finish/);
  assert.match(b25, /失败后扩展自动 fail[\s\S]*不得重派/);
  assert.match(skill, /always replaces them with the exact per-card schema/i);
  assert.match(skill, /valid persisted\s+entry\/meta pair is reused automatically/i);
  assert.match(pipeline, /不得重新列举或读取 Writer 的 entry\/meta 目录/);
  assert.match(pipeline, /--source-fields/);
  assert.match(pipeline, /同源需求必须合并/);
  assert.match(pipeline, /单 task 最多六个[\s\S]*不得拆分重复同源 task/);
  assert.match(pipeline, /全部相关 Writer source[\s\S]*empty_source -> no_data[\s\S]*任一非空 source 都必须进入 B3/);
  assert.match(pipeline, /不得出现 Markdown 表格或复制任何 Writer 行的日期\/数值/);
  assert.match(pipeline, /排序\/TopN\/分组\/统计走 `reuse_entry`/);
  assert.match(pipeline, /typed plan[\s\S]*researchTasks\[\]/i);
});

test("B2 dispatch keeps status but does not duplicate confirmed card content", async () => {
  const skill = await readFile(join(root, ".agents/pi/skills/html-report/SKILL.md"), "utf8");
  const b2 = skill.slice(skill.indexOf("### B1 + B2"), skill.indexOf("### B2.5"));
  assert.match(b2, /initial `NEXT_TOOL_ONLY`[\s\S]*stage-start status call/i);
  assert.match(b2, /successful result reveals one exact Writer call/i);
  assert.match(b2, /never merge calls[\s\S]*read `result\.json`/i);
  assert.match(b2, /exact mandatory[\s\S]*stage-start status call[\s\S]*read `result\.json`/i);
  assert.doesNotMatch(b2, /listed order fixes only the\s+message shape[\s\S]*do not wait/i);
  assert.doesNotMatch(b2, /本卡配置:\s*<JSON>/);
  assert.doesNotMatch(b2, /用户问题:\s*<…>/);
  assert.match(b2, /at most one[\s\S]*entry\.json#\/0[\s\S]*exactly one short/i);
});

test("report-writer persists only the CLI contract and returns analysis", async () => {
  const worker = await readFile(
    join(root, ".agents/pi/skills/html-report/agents/report-writer.md"),
    "utf8"
  );
  assert.match(worker, /fetch_report_entry/);
  assert.doesNotMatch(worker, /fetch-entry\.mjs/);
  assert.match(worker, /entry\.json/);
  assert.match(worker, /entry\.meta\.json/);
  assert.doesNotMatch(worker, /entry\.profile\.json/);
  assert.doesNotMatch(worker, /entry\.facts\.json/);
  assert.match(worker, /submit_writer_result/);
  assert.match(worker, /Never call `structured_output` yourself/);
  assert.match(worker, /"dataPath"/);
  assert.match(worker, /"metaPath"/);
  assert.match(worker, /JSON Pointer/);
  assert.match(worker, /never calculate|Do not calculate/i);
  assert.match(worker, /Python, Node\.js, `jq`, shell expressions, SQL/i);
  assert.match(worker, /period-wide\s+or cross-row claim/i);
  assert.match(worker, /qualitative and must not introduce a numeric target/i);
  assert.match(worker, /recommendations.*next actions only/i);
  assert.match(worker, /Do not repeat a number, date, or\s+sample row/i);
  assert.match(worker, /silently check these three field\s+rules/i);
  assert.doesNotMatch(worker, /outliers or comparisons/i);
  assert.match(worker, /report-writer/);
  assert.match(worker, /禁止.*worker|Unknown agent: report-writer/i);
});

test("runtime report-writer prompt carries the exact return contract", async () => {
  const runtime = await readFile(join(root, ".agents/pi/agents/report-writer.md"), "utf8");
  assert.match(runtime, /"dataPath"/);
  assert.match(runtime, /"metaPath"/);
  assert.match(runtime, /"findings"/);
  assert.match(runtime, /JSON Pointer/);
  assert.match(runtime, /rowCount \+ rowsSha256/);
  assert.doesNotMatch(runtime, /entry\.profile\.json/);
  assert.doesNotMatch(runtime, /entry\.facts\.json/);
  assert.match(runtime, /^tools:\s*read, fetch_report_entry, submit_writer_result$/m);
  assert.match(runtime, /^extensions:\s*$/m);
  assert.match(runtime, /^subagentOnlyExtensions:\s*\.agents\/pi\/extensions\/report-writer-fetch\/index\.mjs$/m);
  assert.match(runtime, /^inheritProjectContext:\s*false$/m);
  assert.doesNotMatch(runtime, /^tools:.*\bbash\b/m);
  assert.match(runtime, /^completionGuard:\s*false$/m);
  assert.match(runtime, /^acceptanceRole:\s*read-only$/m);
  assert.match(runtime, /^acceptance:\s*\{"level":"none",/m);
  assert.match(runtime, /period-wide or cross-row claim/i);
  assert.match(runtime, /Python, Node\.js, `jq`, shell expressions, SQL/i);
  assert.match(runtime, /recommendations.*next actions only/i);
  assert.match(runtime, /Do not repeat a number, date, or\s+sample row/i);
  assert.match(runtime, /silently check these three field\s+rules/i);
  assert.match(runtime, /do not spend\s+a turn searching skills,\s+wikis, Git state/i);
  assert.match(runtime, /fetch_report_entry.*exactly once/i);
  assert.match(runtime, /Finish by calling.*submit_writer_result/i);
  assert.match(runtime, /Do not wrap it in `value`[\s\S]*do not call[\s\S]*`structured_output`/i);
  assert.match(runtime, /取数失败，未形成业务判断/);
  assert.match(runtime, /literal token `null`[\s\S]*never the quoted string `"null"`/i);
});

test("Writer return contract rejects prose, wrong paths, and ungrounded findings", () => {
  const expected = writerReturnPaths({
    sessionDir: "/tmp/html-report-session",
    cardId: "card/a",
  });
  const valid = {
    cardId: "card/a",
    fetchStatus: "success",
    dataPath: expected.dataPath,
    metaPath: expected.metaPath,
    analysis: {
      summary: "明细中包含门店日度记录。",
      findings: [{ statement: "第一行包含一个日期字段。", evidence: ["entry.json#/0"] }],
      recommendations: ["结合业务场景核对该日记录。"],
    },
  };
  assert.deepEqual(validateWriterReturn(valid, expected), { ok: true, errors: [] });
  assert.equal(
    validateWriterReturn({
      ...valid,
      analysis: {
        ...valid.analysis,
        findings: [{ statement: "跨行事实", evidence: ["entry.json#/0", "entry.json#/1"] }],
      },
    }, expected).ok,
    false
  );
  assert.equal(validateWriterReturn({ ...valid, dataPath: "/tmp/other/entry.json" }, expected).ok, false);
  assert.equal(
    validateWriterReturn({
      ...valid,
      analysis: { ...valid.analysis, findings: [{ statement: "x", evidence: ["entry.json#/bad~2"] }] },
    }, expected).ok,
    false
  );
  assert.equal(
    validateWriterReturn({
      ...valid,
      analysis: {
        ...valid.analysis,
        findings: [
          { statement: "第一行。", evidence: ["entry.json#/0"] },
          { statement: "第二行。", evidence: ["entry.json#/1"] },
        ],
      },
    }, expected).ok,
    false
  );
  assert.equal(
    validateWriterReturn({
      ...valid,
      analysis: { ...valid.analysis, recommendations: [] },
    }, expected).ok,
    false
  );
  assert.throws(() => parseWriterReturnText("说明：" + JSON.stringify(valid)), /without prose/);
  assert.deepEqual(parseWriterReturnText(JSON.stringify(valid)), valid);
});

test("Writer return output schema fixes the assigned card and absolute paths", () => {
  const expected = writerReturnPaths({ sessionDir: "/tmp/html-report-session", cardId: "card-1" });
  const schema = buildWriterReturnSchema(expected);
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.oneOf[0].properties.cardId.const, "card-1");
  assert.equal(schema.oneOf[0].properties.dataPath.const, expected.dataPath);
  assert.equal(schema.oneOf[0].properties.metaPath.const, expected.metaPath);
  assert.equal(schema.oneOf[0].properties.analysis.properties.findings.maxItems, 1);
  assert.equal(schema.oneOf[0].properties.analysis.properties.findings.items.properties.evidence.maxItems, 1);
  assert.equal(schema.oneOf[0].properties.analysis.properties.recommendations.minItems, 1);
  assert.equal(schema.oneOf[0].properties.analysis.properties.recommendations.maxItems, 1);
  assert.equal(schema.oneOf[1].properties.dataPath.const, null);
  const submitSchema = buildWriterSubmitSchema();
  assert.equal(submitSchema.oneOf[0].properties.cardId.type, "string");
  assert.equal(submitSchema.oneOf[0].properties.fetchStatus.const, "success");
  assert.equal(submitSchema.oneOf[0].properties.analysis.type, "object");
  assert.equal(submitSchema.oneOf[1].properties.fetchStatus.const, "failed");
  assert.deepEqual(submitSchema.oneOf[1].properties.dataPath, { type: "null" });
});

test("Writer paths reject dot-segment card ids", () => {
  assert.throws(
    () => writerReturnPaths({ sessionDir: "/tmp/html-report-safe", cardId: ".." }),
    /dot path segment/
  );
});

test("four report-* agents registered under .pi/agents", async () => {
  for (const name of ["report-writer", "report-researcher", "report-reviewer", "report-designer"]) {
    const text = await readFile(join(root, `.pi/agents/${name}.md`), "utf8");
    assert.match(text, new RegExp(`^name:\\s*${name}\\s*$`, "m"));
    assert.match(text, /HARD DEPENDENCY/i);
  }
});

test("check-report-agents.mjs passes for all four agents", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = join(root, ".agents/pi/skills/html-report/scripts/check-report-agents.mjs");
  const out = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.agents.length, 4);
  const writer = payload.agents.find((agent) => agent.name === "report-writer");
  assert.equal(writer.ok, true);
  assert.ok(writer.messages.some((message) => /OK\./.test(message)));
});

test("report-researcher branches between reused evidence and material new queries", async () => {
  const agent = await readFile(
    join(root, ".agents/pi/skills/html-report/agents/report-researcher.md"),
    "utf8"
  );
  const runtime = await readFile(join(root, ".pi/agents/report-researcher.md"), "utf8");
  assert.match(agent, /reuse_entry/);
  assert.match(agent, /new_query/);
  assert.match(agent, /prepare-research-evidence\.mjs/);
  assert.match(agent, /fetch-explore\.mjs/);
  assert.match(agent, /data\/explore/);
  assert.match(agent, /selfCheck|质量自查/);
  assert.match(agent, /NO_MATERIAL_QUERY_DELTA|实质变化/);
  assert.match(agent, /needs_new_query/);
  assert.match(agent, /needs_evidence_plan/);
  assert.match(agent, /evidenceGap/);
  assert.match(agent, /field_mismatch/);
  assert.match(agent, /missingFields/);
  assert.match(agent, /availableFields/);
  assert.match(agent, /不写假的完成 section\/summary/);
  assert.match(agent, /临时 Python \/ Node \/ jq/);
  assert.match(agent, /report-researcher/);
  assert.match(runtime, /^tools:\s*read, bash, write, submit_research_findings$/m);
  assert.match(runtime, /`submit_research_findings` exactly once/);
  assert.match(runtime, /captures the same object[\s\S]*`researcherReturn`[\s\S]*terminates the child/);
  assert.match(runtime, /On success, do not call[\s\S]*`structured_output`/);
  assert.match(runtime, /^inheritProjectContext:\s*false$/m);
  assert.match(runtime, /reuse_entry[\s\S]*Do \*\*not\*\* read full/m);
  assert.match(runtime, /Do \*\*not\*\*[\s\S]*fetch-explore\.mjs/m);
  assert.match(runtime, /new_query[\s\S]*fetch-explore\.mjs/m);
  assert.match(runtime, /evidenceGap\.type[\s\S]*evidenceGap\.types\[\][\s\S]*evidenceGap\.reason/);
  assert.match(runtime, /Only `status: "ok"` writes section\/summary artifacts/);
  assert.match(runtime, /needs_\*[\s\S]*no[\s\S]*completion paths/i);
  assert.match(runtime, /structured_output/);
  assert.match(runtime, /must not contain a Markdown table/);
});

test("report-reviewer and report-designer are subagent roles", async () => {
  const rev = await readFile(
    join(root, ".agents/pi/skills/html-report/agents/report-reviewer.md"),
    "utf8"
  );
  assert.match(rev, /report-reviewer/);
  assert.match(rev, /scores|R1|R7/);
  assert.match(rev, /subagent|Pi/);
  assert.match(rev, /status[\s\S]*sessionDir[\s\S]*resultPath[\s\S]*scanPath[\s\S]*verdictPath[\s\S]*repairHints/);
  assert.match(rev, /infrastructure_error[\s\S]*failedStep[\s\S]*error[\s\S]*repairHints/);
  assert.match(rev, /failed[\s\S]*至少提供一条[\s\S]*repairHints/);
  assert.doesNotMatch(rev, /"paths"\s*:/);
  assert.doesNotMatch(rev, /"lowRubric"\s*:/);
  assert.doesNotMatch(rev, /"suggestedDrill"\s*:/);
  const reviewerRuntime = await readFile(join(root, ".pi/agents/report-reviewer.md"), "utf8");
  assert.match(reviewerRuntime, /^tools:\s*read, bash, submit_review_scorecard$/m);
  assert.match(reviewerRuntime, /typed scorecard[\s\S]*JSON serialization[\s\S]*verdict stamping/i);
  assert.match(reviewerRuntime, /^extensions:\s*$/m);
  assert.match(reviewerRuntime, /^inheritProjectContext:\s*false$/m);
  assert.match(reviewerRuntime, /structured_output/);
  assert.match(reviewerRuntime, /status[\s\S]*passed[\s\S]*failed/);
  assert.match(reviewerRuntime, /infrastructure_error[\s\S]*failedStep[\s\S]*error[\s\S]*repairHints/);
  assert.match(reviewerRuntime, /pass:false.*failed|pass`.*false.*failed/is);
  assert.match(reviewerRuntime, /parent extension[\s\S]*authoritative/i);
  assert.doesNotMatch(reviewerRuntime, /^node .*assemble-report\.mjs/m);
  assert.doesNotMatch(reviewerRuntime, /^node .*check-session-layout\.mjs/m);
  const des = await readFile(
    join(root, ".agents/pi/skills/html-report/agents/report-designer.md"),
    "utf8"
  );
  assert.match(des, /compile-report-content\.mjs/);
  assert.match(des, /compose-report\.mjs/);
  assert.match(des, /capture-report\.mjs/);
  assert.match(des, /html-report-design/);
  assert.match(des, /report-designer/);
  assert.match(des, /subagent|Pi/);
});

test("report-designer isolates context and injects only the report design skill", async () => {
  const agent = await readFile(join(root, ".pi/agents/report-designer.md"), "utf8");
  assert.match(agent, /^tools:\s*read, bash, write, edit$/m);
  assert.doesNotMatch(agent, /^tools:.*\b(?:ls|find|grep)\b/m);
  assert.match(agent, /^extensions:\s*$/m);
  assert.match(
    agent,
    /^subagentOnlyExtensions:\s*\.agents\/pi\/extensions\/report-designer-guard\/index\.mjs$/m
  );
  assert.match(agent, /^inheritProjectContext:\s*false$/m);
  assert.match(agent, /^inheritSkills:\s*false$/m);
  assert.match(agent, /^skills:\s*html-report-design$/m);
  assert.match(agent, /^skillPath:\s*\.\.\/skills$/m);
  assert.match(agent, /`structured_output` exactly once/);
  assert.match(agent, /do not produce an acceptance report/i);
});

test("skill uses Report Editor and four agent ids", async () => {
  const skill = await readFile(join(root, ".agents/pi/skills/html-report/SKILL.md"), "utf8");
  assert.match(skill, /Report Editor/);
  assert.match(skill, /report-writer/);
  assert.match(skill, /report-researcher/);
  assert.match(skill, /report-reviewer/);
  assert.match(skill, /report-designer/);
  assert.match(skill, /html-report-quality-rubric/);
  assert.doesNotMatch(skill, /card-worker|explore-analyst/);
  assert.match(skill, /agent: "report-reviewer"/);
  assert.match(skill, /agent: "report-designer"/);
  const reviewerTask = skill.match(/task: `B4 scorecard[\s\S]*?force pass`/)?.[0] || "";
  assert.ok(reviewerTask, "B4 Reviewer task must be present");
  assert.doesNotMatch(reviewerTask, /^\d+\).*assemble-report\.mjs/m);
  assert.doesNotMatch(reviewerTask, /check-session-layout\s+--phase\s+quality/);
  assert.match(reviewerTask, /parent extension performs authoritative/i);
});
