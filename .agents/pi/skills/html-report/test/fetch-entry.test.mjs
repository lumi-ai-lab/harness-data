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
  metricFetchBudgetMs,
  isMetricTimeout,
  isRetryableMetricFailure,
  shouldRetryMetricFailure,
  parseEntryMetaResponse,
  reusableEntry,
  rowsSha256,
} from "../scripts/fetch-entry.mjs";
import {
  buildWriterReturnSchema,
  extractWriterReceipt,
  parseWriterReturnText,
  validateWriterReturn,
  writerReturnPaths,
  WRITER_ACK_TOOL,
} from "../scripts/writer-return.mjs";
import { writerCoordinationDecision } from "../../../extensions/report-writer-fetch/lifecycle.mjs";
import { metricQueryFromCard } from "../scripts/metric-query-contract.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);

function metricQuery(overrides = {}) {
  return {
    metrics: ["saleAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-14" },
    dimensions: ["incDate"],
    filters: {},
    pageNo: 1,
    pageSize: 500,
    ...overrides,
  };
}

test("normalizeEntryPayload keeps all-pages friendly pageSize and pageNo=1", () => {
  const payload = normalizeEntryPayload(metricQuery({ pageNo: 3 }));
  assert.equal(payload.pageNo, 1);
  assert.equal(payload.pageSize, 500);
  assert.deepEqual(payload.metrics, ["saleAmt"]);
});

test("normalizeEntryPayload caps pageSize at the Metric CLI limit", () => {
  const payload = normalizeEntryPayload(metricQuery({ pageSize: 99999 }));
  assert.equal(payload.pageSize, 2000);
});

test("B2 execute args request data rows but never single-page or legacy meta", () => {
  const args = buildExecuteArgs(normalizeEntryPayload(metricQuery()));
  assert.equal(args[0], "analysis");
  assert.equal(args[1], "execute");
  assert.ok(args.includes("--payload-json"));
  assert.ok(!args.includes("--single-page"), "report fetch must pull all pages");
  assert.ok(!args.includes("--meta"), "qdm-metric-cli has no legacy --meta mode");
  assert.deepEqual(args.slice(args.indexOf("--output"), args.indexOf("--output") + 2), ["--output", "data"]);
  const json = JSON.parse(args[args.indexOf("--payload-json") + 1]);
  assert.equal(json.pageSize, 500);
  assert.equal(json.pageNo, 1);
});

test("legacy Indicators payload is rejected explicitly", () => {
  assert.throws(
    () => normalizeEntryPayload({ indicatorFieldList: ["saleAmt"] }),
    /LEGACY_INDICATORS_PAYLOAD_UNSUPPORTED/
  );
});

test("Metric query rejects unsupported policies and comparison without dimensions", () => {
  assert.throws(
    () => normalizeEntryPayload(metricQuery({ statisticPolicy: "VALID_DATA" })),
    /only supports SUMMARY and SALES_STORE_DAY_AVG/
  );
  assert.throws(
    () => normalizeEntryPayload(metricQuery({ dimensions: [], comparisons: ["YOY"] })),
    /requires at least one dimension/
  );
});

test("query.comparisons adds only CLI flags and stays out of the payload", () => {
  const withComparisons = metricQueryFromCard({
    id: "card-1",
    query: {
      request: metricQuery(),
      comparisons: ["YOY", "MOM"],
    },
  });
  assert.deepEqual(withComparisons.comparisons, ["MOM", "YOY"]);
  const args = buildExecuteArgs(withComparisons);
  assert.equal(args.filter((arg) => arg === "--yoy").length, 1);
  assert.equal(args.filter((arg) => arg === "--mom").length, 1);
  const payload = JSON.parse(args[args.indexOf("--payload-json") + 1]);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "comparisons"), false);
});

test("query without comparisons defaults to empty", () => {
  const noComparisons = metricQueryFromCard({
    id: "card-2",
    query: {
      request: metricQuery(),
      comparisons: [],
    },
  });
  assert.deepEqual(noComparisons.comparisons, []);
  const args = buildExecuteArgs(noComparisons);
  assert.equal(args.filter((arg) => arg === "--yoy").length, 0);
  assert.equal(args.filter((arg) => arg === "--mom").length, 0);
});

test("legacy requestBody and queryProof are rejected", () => {
  assert.throws(
    () => metricQueryFromCard({ id: "c", requestBody: metricQuery() }),
    /LEGACY_QUERY_FIELD_UNSUPPORTED.*requestBody/
  );
  assert.throws(
    () => metricQueryFromCard({ id: "c", queryProof: { comparisons: ["YOY"] } }),
    /LEGACY_QUERY_FIELD_UNSUPPORTED.*queryProof/
  );
});

test("non-array query.comparisons is rejected (fail-closed)", () => {
  assert.throws(
    () => metricQueryFromCard({ id: "c", query: { request: metricQuery(), comparisons: "YOY" } }),
    /card\.query\.comparisons must be an array/
  );
  assert.throws(
    () => metricQueryFromCard({ id: "c", query: { request: metricQuery(), comparisons: 42 } }),
    /card\.query\.comparisons must be an array/
  );
});

test("unknown query wrapper fields are rejected (fail-closed)", () => {
  assert.throws(
    () => metricQueryFromCard({ id: "c", query: { request: metricQuery(), comparisons: [], foo: "bar" } }),
    /unsupported fields.*foo/
  );
  assert.throws(
    () => metricQueryFromCard({ id: "c", query: { request: metricQuery(), typo: 123 } }),
    /unsupported fields.*typo/
  );
});

test("Writer timeout classifier stops backend timeouts but preserves fast retries", () => {
  assert.equal(isMetricTimeout({ errorCode: "ETIMEDOUT" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "upstream request timeout exceeded" }), true);
  assert.equal(isMetricTimeout({ status: 1, stdout: "指标查询超时" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "HTTP 504" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "status code: 408" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "connection reset" }), false);
  assert.equal(
    isMetricTimeout({ status: 0, error: "", stdout: '[{"label":"timeout"}]' }),
    false
  );
});

test("Metric retries use a transient allowlist", () => {
  assert.equal(isRetryableMetricFailure({ status: 1, errorCode: "ECONNRESET" }), true);
  assert.equal(isRetryableMetricFailure({ status: 1, stderr: "HTTP 503 service unavailable" }), true);
  assert.equal(isRetryableMetricFailure({ status: 1, stderr: "invalid record id 503" }), false);
  assert.equal(isRetryableMetricFailure({ status: 1, stderr: "HTTP 425 too early" }), false);
  assert.equal(isRetryableMetricFailure({ status: 1, stderr: "HTTP 418 service unavailable" }), false);
  assert.equal(isRetryableMetricFailure({ status: 1, stderr: "temporarily invalid parameter" }), false);
  assert.equal(isRetryableMetricFailure({ status: 1, stderr: "HTTP 401 unauthorized" }), false);
  assert.equal(
    isRetryableMetricFailure({ status: 1, errorCode: "ECONNRESET", stderr: "HTTP 401 unauthorized" }),
    false
  );
  assert.equal(isRetryableMetricFailure({ status: 1, errorCode: "ENOENT" }), false);
  assert.equal(isRetryableMetricFailure({ status: null, signal: "SIGKILL" }), false);
  assert.equal(isRetryableMetricFailure({ status: 0, stdout: "not json" }, { parseError: "invalid JSON" }), false);
  assert.equal(shouldRetryMetricFailure({ status: 1, stderr: "HTTP 503", durationMs: 100 }), true);
  assert.equal(shouldRetryMetricFailure({ status: 1, stderr: "HTTP 503", durationMs: 15_001 }), false);
  assert.equal(metricFetchBudgetMs({}), 540_000);
  assert.equal(metricFetchBudgetMs({ QDM_METRIC_FETCH_BUDGET_MS: "900000" }), 540_000);
  assert.equal(metricFetchBudgetMs({ QDM_METRIC_FETCH_BUDGET_MS: "1000" }), 1_000);
});

test("parseEntryMetaResponse accepts rows-array stdout and derives meta", () => {
  const rows = [{ id: 1 }, { id: 2 }];
  const parsed = parseEntryMetaResponse(JSON.stringify(rows));
  assert.equal(parsed.rowCount, 2);
  assert.deepEqual(parsed.rows, rows);
  assert.equal(parsed.rowsSha256, rowsSha256(rows));
  assert.throws(
    () => parseEntryMetaResponse(JSON.stringify({ rows: [] })),
    /rows array/
  );
  assert.throws(
    () => parseEntryMetaResponse(JSON.stringify([1])),
    /rows\[0\]/
  );
});

test("fetchAllEntries rejects result.json without confirmed status before CLI", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-status-"));
  const session = join(rootDir, ".harness", "state", "html-report", "missing-status");
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }],
  }));
  await assert.rejects(
    () => fetchAllEntries(resultPath, { cardId: "c1" }),
    /result\.status must be confirmed/
  );
});

test("fetch-entry authz on fails closed before invoking Metric CLI when no bound blob exists", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-auth-"));
  const session = join(rootDir, ".harness", "state", "html-report", "auth");
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    session_id: "auth-session",
    cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }],
  }));

  const countPath = join(rootDir, "metric-count.txt");
  const fakeMetric = join(rootDir, "fake-metric.sh");
  await writeFile(fakeMetric, [
    "#!/bin/sh",
    "printf 'called' > \"$FAKE_METRIC_COUNT_PATH\"",
    "printf '%s\\n' '[]'",
    "",
  ].join("\n"));
  await chmod(fakeMetric, 0o755);

  const fetchEntryScript = fileURLToPath(new URL("../scripts/fetch-entry.mjs", import.meta.url));
  const env = {
    ...process.env,
    QDM_METRIC_CLI: fakeMetric,
    HARNESS_AUTHZ_MODE: "on",
    FAKE_METRIC_COUNT_PATH: countPath,
  };
  delete env.HARNESS_AUTH_BLOB;
  delete env.HARNESS_AUTH_BLOB_FILE;
  delete env.HARNESS_AUTH_USER_ID;
  delete env.LUMI_REQUESTER_CONTEXT_DIR;
  const run = spawnSync(process.execPath, [fetchEntryScript, "--result", resultPath, "--card-id", "c1"], {
    encoding: "utf8",
    env,
  });

  assert.equal(run.status, 1, run.stderr || run.stdout);
  await assert.rejects(() => stat(countPath), /ENOENT/);
  const output = JSON.parse(run.stdout);
  assert.match(output.cards[0].error, /METRIC_AUTH_CONTEXT_REQUIRED/);
  assert.deepEqual(output.cards[0].attempts, []);
});

test("fetch-entry does not retry permanent CLI or response-contract failures", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "html-report-fetch-entry-terminal-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));

  const fakeMetric = join(rootDir, "fake-metric.sh");
  await writeFile(fakeMetric, [
    "#!/bin/sh",
    "count=0",
    "if [ -f \"$FAKE_METRIC_COUNT_PATH\" ]; then count=$(sed -n '1p' \"$FAKE_METRIC_COUNT_PATH\"); fi",
    "count=$((count + 1))",
    "printf '%s' \"$count\" > \"$FAKE_METRIC_COUNT_PATH\"",
    "if [ \"$FAKE_METRIC_MODE\" = \"unauthorized\" ]; then",
    "  printf '%s\\n' 'HTTP 401 unauthorized' >&2",
    "  exit 1",
    "fi",
    "printf '%s\\n' 'not-json'",
    "exit 0",
    "",
  ].join("\n"));
  await chmod(fakeMetric, 0o755);

  const fetchEntryScript = fileURLToPath(new URL("../scripts/fetch-entry.mjs", import.meta.url));
  for (const mode of ["unauthorized", "invalid-json"]) {
    const session = join(rootDir, ".harness", "state", "html-report", mode);
    await mkdir(session, { recursive: true });
    const resultPath = join(session, "result.json");
    await writeFile(resultPath, JSON.stringify({
      status: "confirmed",
      session_id: mode,
      cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }],
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
        QDM_METRIC_CLI: fakeMetric,
        HARNESS_AUTHZ_MODE: "off",
        FAKE_METRIC_COUNT_PATH: countPath,
        FAKE_METRIC_MODE: mode,
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
    session_id: "reuse",
    cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }],
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
  assert.match(skill, /valid persisted entry\/meta pair is reused automatically/i);
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
  assert.match(b2, /ack_cli_data/i);
});

test("report-writer persists only the CLI contract and submits the fetch receipt", async () => {
  const worker = await readFile(
    join(root, ".agents/pi/skills/html-report/agents/report-writer.md"),
    "utf8"
  );
  assert.match(worker, /ack_cli_data/);
  assert.doesNotMatch(worker, /fetch-entry\.mjs/);
  assert.match(worker, /entry\.json/);
  assert.match(worker, /entry\.meta\.json/);
  assert.doesNotMatch(worker, /entry\.profile\.json/);
  assert.doesNotMatch(worker, /entry\.facts\.json/);
  assert.match(worker, /single call is the entire job/i);
  assert.match(worker, /Do not call `submit_writer_result` or `structured_output`/);
  assert.match(worker, /report-writer/);
  assert.match(worker, /禁止.*worker|Unknown agent: report-writer/i);
});

test("runtime report-writer prompt carries the fetch-only contract", async () => {
  const runtime = await readFile(join(root, ".agents/pi/agents/report-writer.md"), "utf8");
  assert.match(runtime, /entry\.json` \+ `entry\.meta\.json/);
  assert.doesNotMatch(runtime, /entry\.profile\.json/);
  assert.doesNotMatch(runtime, /entry\.facts\.json/);
  assert.match(runtime, /^tools:\s*ack_cli_data$/m);
  assert.match(runtime, /^extensions:\s*$/m);
  assert.match(runtime, /^subagentOnlyExtensions:\s*\.agents\/pi\/extensions\/report-writer-fetch\/index\.mjs$/m);
  assert.match(runtime, /^inheritProjectContext:\s*false$/m);
  assert.doesNotMatch(runtime, /^tools:.*\bbash\b/m);
  assert.match(runtime, /^completionGuard:\s*false$/m);
  assert.match(runtime, /^acceptanceRole:\s*read-only$/m);
  assert.match(runtime, /^acceptance:\s*\{"level":"none",/m);
  assert.match(runtime, /ack_cli_data.*exactly once/i);
  assert.match(runtime, /single call is the entire job/i);
  assert.match(runtime, /Do \*\*not\*\* call `read`[\s\S]*`submit_writer_result`[\s\S]*`structured_output`/i);
});

test("Writer return contract accepts the fetch receipt and rejects extras", () => {
  const expected = writerReturnPaths({
    sessionDir: "/tmp/html-report-session",
    cardId: "card-a",
  });
  const valid = {
    cardId: "card-a",
    fetchStatus: "success",
    dataPath: expected.dataPath,
    metaPath: expected.metaPath,
    rowCount: 2,
    rowsSha256: "a".repeat(64),
  };
  assert.deepEqual(validateWriterReturn(valid, expected), { ok: true, errors: [] });
  assert.equal(validateWriterReturn({ ...valid, dataPath: "/tmp/other/entry.json" }, expected).ok, false);
  assert.equal(validateWriterReturn({ ...valid, error: null }, expected).ok, false);
  assert.equal(
    validateWriterReturn({
      cardId: "card-a",
      fetchStatus: "failed",
      dataPath: null,
      metaPath: null,
      error: "cli failed",
    }, expected).ok,
    true
  );
  assert.throws(() => parseWriterReturnText("说明：" + JSON.stringify(valid)), /without prose/);
  assert.deepEqual(parseWriterReturnText(JSON.stringify(valid)), valid);
  assert.deepEqual(extractWriterReceipt({
    exitCode: 1,
    error: "Subagent produced no output (possible model cold-start or empty response).",
    messages: [{
      role: "toolResult",
      toolName: WRITER_ACK_TOOL,
      isError: false,
      content: [{ type: "text", text: JSON.stringify(valid) }],
      details: valid,
    }],
  }), valid);
});

test("extractWriterReceipt reads ack_cli_data from the child transcript when messages are omitted", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "writer-ack-transcript-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const expected = writerReturnPaths({
    sessionDir: "/tmp/html-report-session",
    cardId: "card-a",
  });
  const valid = {
    cardId: "card-a",
    fetchStatus: "success",
    dataPath: expected.dataPath,
    metaPath: expected.metaPath,
    rowCount: 2,
    rowsSha256: "a".repeat(64),
  };
  const transcriptPath = join(dir, "writer.transcript.jsonl");
  await writeFile(transcriptPath, `${JSON.stringify({
    recordType: "message",
    role: "toolResult",
    text: JSON.stringify(valid, null, 2),
    message: {
      role: "toolResult",
      toolName: WRITER_ACK_TOOL,
      isError: false,
      content: [{ type: "text", text: JSON.stringify(valid, null, 2) }],
      details: valid,
    },
  })}\n`);
  assert.deepEqual(extractWriterReceipt({
    exitCode: 1,
    error: "Subagent produced no output (possible model cold-start or empty response).",
    transcriptPath,
  }), valid);
});

test("Writer return output schema fixes the assigned card and absolute paths", () => {
  const expected = writerReturnPaths({ sessionDir: "/tmp/html-report-session", cardId: "card-1" });
  const schema = buildWriterReturnSchema(expected);
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.oneOf[0].properties.cardId.const, "card-1");
  assert.equal(schema.oneOf[0].properties.dataPath.const, expected.dataPath);
  assert.equal(schema.oneOf[0].properties.metaPath.const, expected.metaPath);
  assert.equal(schema.oneOf[0].required.includes("rowCount"), true);
  assert.equal(schema.oneOf[1].properties.dataPath.const, null);
  assert.equal(schema.oneOf[1].required.includes("error"), true);
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
  assert.match(reviewerRuntime, /^tools:\s*read, submit_review_scorecard$/m);
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
  assert.match(reviewerTask, /parent extension performs[\s\S]*authoritative/i);
});
