import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  validateShape,
  hasEffectiveFilter,
  cardHasEffectiveFilters,
  collectFilterWarnings,
  inclusiveDaySpan,
  MAX_CARD_DATE_SPAN_DAYS,
} from "../scripts/validate-config.mjs";
import { collectRecommendationContractErrors } from "../scripts/recommendation-contract.mjs";
import {
  defaultFixedDateRange,
  fixedRecommendations,
} from "../scripts/seed-debug-recommendations.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const prepare = join(root, ".agents/pi/skills/html-report/scripts/prepare.mjs");
const serverScript = join(root, ".agents/pi/skills/html-report/scripts/server.mjs");
const htmlPath = join(root, "public/local-report-builder.html");

const valid = () => ({
  version: 1, question: "销售额", title: "销售额", mode: "single", recall: {}, warnings: [],
  cards: [{
    id: "c1",
    title: "销售额",
    analysisFocus: "趋势",
    headingLevel: 2,
    indicatorFieldList: ["saleAmt"],
    aggDimUniqueCodeList: ["bizDate"],
    columnAggDimUniqueCodeList: [],
    startDate: "2026-07-01",
    endDate: "2026-07-14",
    filters: [{ dimUniqueCode: "storeId", dimFieldIdList: ["101001"] }],
    storeCollectType: 1,
    indicatorBizId: "1",
    chartType: "table",
  }],
});

test("shape validator rejects empty, duplicate, invalid date and invalid parameters", () => {
  const data = valid();
  data.cards.push({ ...data.cards[0] });
  data.cards[0].indicatorFieldList = [];
  data.cards[0].aggDimUniqueCodeList = [];
  data.cards[0].startDate = "2026-99-99";
  data.cards[0].chartType = "line";
  assert.ok(validateShape(data).length >= 5);
});

test("shape validator rejects unsafe or filesystem-colliding card ids before B2", () => {
  const unsafe = valid();
  unsafe.cards[0].id = "..";
  assert.ok(validateShape(unsafe).some((error) => /unsafe id/.test(error)));

  const sanitizedMismatch = valid();
  sanitizedMismatch.cards[0].id = "card/a b";
  assert.ok(validateShape(sanitizedMismatch).some((error) => /unsafe id/.test(error)));

  const collision = valid();
  collision.cards.push({
    ...collision.cards[0],
    id: "same?card",
    title: "第二张卡",
  });
  collision.cards[0].id = "same/card";
  assert.ok(validateShape(collision).some((error) => /collides after filesystem sanitization/.test(error)));
});

test("shape validator rejects missing analysisFocus", () => {
  const data = valid();
  data.cards[0].analysisFocus = "   ";
  const errors = validateShape(data);
  assert.ok(errors.some((e) => /analysisFocus/i.test(e)), errors.join("; "));
});

test("hasEffectiveFilter requires dim and non-empty values", () => {
  assert.equal(hasEffectiveFilter({ dimUniqueCode: "storeId", values: ["101001"] }), true);
  assert.equal(hasEffectiveFilter({ dimUniqueCode: "storeId", values: [] }), false);
  assert.equal(hasEffectiveFilter({ dimUniqueCode: "", values: ["101001"] }), false);
  assert.equal(hasEffectiveFilter({ dimUniqueCode: "storeId", dimFieldIdList: ["101001"] }), true);
});

test("collectFilterWarnings warns when all cards lack filters but does not error", () => {
  const empty = valid();
  empty.cards[0].filters = [];
  const warnings = collectFilterWarnings(empty);
  assert.ok(warnings.some((w) => /no effective filters/i.test(w)), warnings.join("; "));
  assert.equal(validateShape(empty).length, 0);

  const withFilter = valid();
  assert.equal(cardHasEffectiveFilters(withFilter.cards[0]), true);
  assert.equal(collectFilterWarnings(withFilter).length, 0);
});

test("inclusiveDaySpan and max 31-day card window", () => {
  assert.equal(inclusiveDaySpan("2026-07-01", "2026-07-01"), 1);
  assert.equal(inclusiveDaySpan("2026-07-01", "2026-07-31"), 31);
  assert.equal(MAX_CARD_DATE_SPAN_DAYS, 31);

  const ok = valid();
  ok.cards[0].startDate = "2026-07-01";
  ok.cards[0].endDate = "2026-07-31";
  assert.equal(validateShape(ok).length, 0);

  const tooLong = valid();
  tooLong.cards[0].startDate = "2026-04-27";
  tooLong.cards[0].endDate = "2026-07-19";
  const errors = validateShape(tooLong);
  assert.ok(errors.some((e) => /date range spans|max 31/i.test(e)), errors.join("; "));
});

test("fixed debug recommendation is a valid known-good 101001 daily card", () => {
  const range = defaultFixedDateRange(new Date(2026, 6, 25));
  assert.deepEqual(range, { startDate: "2026-07-01", endDate: "2026-07-24" });

  const recommendations = fixedRecommendations({
    sessionId: "debug-session",
    userQuestion: "任意问题在固定推荐调试阶段不影响卡片",
    now: new Date(2026, 6, 25),
  });
  assert.deepEqual(validateShape(recommendations), []);
  assert.equal(recommendations.cards.length, 1);
  assert.deepEqual(recommendations.cards[0].indicatorFieldList, ["custNum", "perCustAmt", "profitLostRate", "profitAmt"]);
  assert.deepEqual(recommendations.cards[0].aggDimUniqueCodeList, ["bizDate"]);
  assert.deepEqual(recommendations.cards[0].filters, [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }]);
});

test("recommendation contract rejects legacy inc time dimension fields", () => {
  const data = valid();
  const legacyDayDim = `inc${"Date"}`;
  const legacyWeekDim = `inc${"Week"}`;
  data.cards[0].aggDimUniqueCodeList = [legacyDayDim];
  data.cards[0].columnAggDimUniqueCodeList = [legacyWeekDim];
  data.cards[0].filters = [{ type: "DIMENSION", dimUniqueCode: legacyDayDim, values: ["2026-07-01"] }];
  data.cards[0].query = {
    request: {
      metrics: ["saleAmt"],
      statisticPolicy: "SUMMARY",
      time: { startDate: "2026-07-01", endDate: "2026-07-01" },
      dimensions: [legacyDayDim],
      filters: { [legacyWeekDim]: ["2026-07-01"] },
    },
    comparisons: [],
  };

  const errors = collectRecommendationContractErrors(data);
  assert.ok(errors.length >= 5);
  assert.ok(errors.every((error) => /legacy time dimension|bizDate/.test(error)));
});

test("prepare identifies single, multi_single, report and free modes", () => {
  for (const [question, mode] of [["分析销售额", "single"], ["销售额和客单价最近怎么样？", "multi_single"], ["生成盈利情况分析报告", "report"], ["讲个笑话", "free"]]) {
    const out = spawnSync(process.execPath, [prepare, "--question", question, "--session-id", `test-${mode}`], { cwd: root, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr || out.stdout);
    assert.equal(JSON.parse(out.stdout).mode, mode);
  }
});

test("prepare uses Spec-only recall (doc-set specs) for single metric", () => {
  const out = spawnSync(process.execPath, [prepare, "--question", "分析销售额", "--session-id", "test-specs-single"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.docSet, "specs");
  assert.equal(payload.mode, "single");
  assert.ok(payload.specs.some((p) => /销售额\/spec\.md$/.test(p)), JSON.stringify(payload.specs));
  assert.ok(!payload.specs.some((p) => /playbook\.md$/.test(p)));
  assert.equal(payload.emptyRecall, false);
});

test("prepare allows empty Spec recall for free no-hit (LLM explores indexes)", () => {
  const out = spawnSync(process.execPath, [prepare, "--question", "讲个笑话", "--session-id", "test-specs-empty"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.mode, "free");
  assert.equal(payload.emptyRecall, true);
  assert.deepEqual(payload.specs, []);
  assert.equal(payload.supported, true);
  assert.match(payload.next, /index\.md/);
});

test("prepare accepts recalled Metric-native reports", () => {
  const out = spawnSync(process.execPath, [prepare, "--question", "生成经营综合分析报告", "--session-id", "test-cmr"], { cwd: root, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.supported, true);
  assert.ok(payload.specs.some((p) => /经营综合分析报告\/spec\.md$/.test(p)), JSON.stringify(payload.specs));
});

test("skill instructions require Spec-only flow and forbid analysis execute", async () => {
  const skill = await readFile(join(root, ".agents/pi/skills/html-report/SKILL.md"), "utf8");
  const plannerContract = await readFile(
    join(root, ".agents/pi/skills/html-report/scripts/editor-plan-contract.mjs"),
    "utf8"
  );
  const researcherPrompts = await Promise.all([
    readFile(join(root, ".agents/pi/agents/report-researcher.md"), "utf8"),
    readFile(join(root, ".agents/pi/skills/html-report/agents/report-researcher.md"), "utf8"),
  ]);
  const startupPreflight = skill.indexOf("## Pi runtime prerequisite");
  const phaseA = skill.indexOf("## Phase A");
  assert.ok(startupPreflight >= 0 && startupPreflight < phaseA, "runtime preflight must precede Phase A");
  const startupInstructions = skill.slice(startupPreflight, phaseA);
  assert.match(startupInstructions, /extension-owned[\s\S]*pi-subagents slash bridge/i);
  assert.match(startupInstructions, /exactly `\{ action: "list" \}`/i);
  assert.match(startupInstructions, /parent model must not repeat this call/i);
  assert.match(startupInstructions, /report-writer[\s\S]*report-researcher[\s\S]*report-reviewer[\s\S]*report-designer/i);
  assert.match(startupInstructions, /fail[\s\S]*A_CONFIG[\s\S]*stop/i);
  assert.match(startupInstructions, /Never work around[\s\S]*`pi --print`/i);
  assert.match(startupInstructions, /installed but[\s\S]*filtered\/disabled[\s\S]*unavailable/i);
  assert.match(skill, /doc-set specs/);
  assert.match(skill, /Phase B|生成报告/);
  assert.match(skill, /fetch-entry\.mjs/);
  assert.match(skill, /report-writer|Report Writer|summary-only|--card-id/i);
  assert.match(skill, /B0|action:\s*"list"|missing html-report SubAgent|report-writer/i);
  const b0Section = skill.slice(skill.indexOf("### B0 —"), skill.indexOf("### B1"));
  assert.match(b0Section, /automatically emits[\s\S]*`\{ action: "list" \}`[\s\S]*pi-subagents event bridge[\s\S]*`phase=a` layout/i);
  assert.match(b0Section, /Report Editor must not call[\s\S]*subagent list[\s\S]*Bash[\s\S]*layout[\s\S]*`stage-gate`/i);
  const b3Preflight = skill.slice(
    skill.indexOf("#### B3.5.0"),
    skill.indexOf("#### B3.5.1")
  );
  assert.match(b3Preflight, /B0_PREFLIGHT[\s\S]*四个运行时角色/);
  assert.match(b3Preflight, /B3_RESEARCH[\s\S]*不得再次调用[\s\S]*action:\s*"list"/);
  assert.doesNotMatch(b3Preflight, /Report Editor \*\*必须\*\*[\s\S]*subagent\(\{ action: "list" \}\)/);
  assert.match(skill, /builtin `worker`|No builtin worker|禁止.*worker/i);
  assert.doesNotMatch(skill, /推荐（兼容性最好）[\s\S]*agent:\s*"worker"/);
  assert.match(skill, /emptyRecall|specs is empty/i);
  assert.match(skill, /server\.mjs/);
  assert.match(skill, /--detach/);
  assert.match(skill, /auto-detects Pi process/i);
  assert.match(skill, /analysisFocus/);
  assert.match(skill, /cards\[\]\.filters|Scope → filters|structured filters/i);
  assert.match(skill, /门店|区域|品类/);
  assert.match(skill, /title.*analysisFocus|analysisFocus.*title|only.*prose|只写在/i);
  assert.match(skill, /31|≤ 31|<= 31/);
  assert.match(skill, /1st of the current calendar month|current month 1st|当月 1/);
  assert.match(skill, /through yesterday|→ yesterday|～昨天/);
  assert.match(skill, /Card diversity|避免重复|time grain|bizDate/);
  assert.match(skill, /same indicator|同指标|Forbidden|禁止/);
  assert.match(skill, /tasks\.json/);
  const b25Planner = skill.slice(skill.indexOf("### B2.5"), skill.indexOf("### B3.5"));
  assert.match(b25Planner, /requirement-to-view\/rubric 覆盖/i);
  assert.match(b25Planner, /typed schema/i);
  assert.match(b25Planner, /确定性生成 analysis\/tasks\.json/i);
  assert.match(skill, /candidateIndicators[\s\S]*candidateDims[\s\S]*少一个空字段也会拒绝派发/);
  const researcherPromptText = researcherPrompts.join("\n");
  assert.match(researcherPromptText, /Top N/);
  assert.match(researcherPromptText, /Bottom N/);
  assert.match(researcherPromptText, /其余N日/);
  assert.match(researcherPromptText, /forbidden derivation|禁止/);
  assert.match(skill, /submit_research_findings/);
  assert.match(
    skill,
    /机器契约[\s\S]*qdm-harness[\s\S]*不得在这里展开、转述或追加规则/i
  );
  assert.doesNotMatch(skill, /MODE RULE:/);
  for (const researcherPrompt of researcherPrompts) {
    assert.match(
      researcherPrompt,
      /summary JSON file is not a reduced summary record[\s\S]*exactly equal[\s\S]*structured_output/i
    );
    assert.match(
      researcherPrompt,
      /structured_output\(\{value: envelopeObject\}\)[\s\S]*(?:never quote|禁止给[\s\S]*value[\s\S]*加引号)/i
    );
    assert.match(
      researcherPrompt,
      /analysisRequirements[\s\S]*findings[\s\S]*requirementId[\s\S]*evidencePointers/
    );
    assert.match(
      researcherPrompt,
      /source(?:\.| )queryCoverage[\s\S]*(?:never supplies|不能为 finding)/i
    );
    assert.match(
      researcherPrompt,
      /finding(?:\.claim| claim)[\s\S]*证据：/i
    );
    assert.match(researcherPrompt, /显著|Significance/i);
    assert.match(researcherPrompt, /因果|causality/i);
    assert.match(researcherPrompt, /全局|global optimum/i);
    assert.match(
      researcherPrompt,
      /analysisContractVersion[^\n]*1[\s\S]*submit_research_findings[\s\S]*(?:Do not call `write`|禁止自行 write)/i
    );
    assert.match(researcherPrompt, /researcherReturn[\s\S]*structured_output/i);
    assert.match(
      researcherPrompt,
      /ranking[\s\S]*(?:never enumerate the full TopN|不得枚举完整 TopN)[\s\S]*(?:explicitly requested|明确要求)/i
    );
    assert.match(
      researcherPrompt,
      /joint_tradeoff[\s\S]*(?:support-qualified|支持合格)[\s\S]*(?:raw observed winner|原始已观测赢家)/i
    );
    assert.match(researcherPrompt, /(?:never echo JSON|禁止照抄 JSON)[\s\S]*(?:enum values|枚举值)/i);
    assert.match(researcherPrompt, /suggestedDeeper[\s\S]*(?:default|默认|unless)/i);
    assert.doesNotMatch(researcherPrompt, /Fixed safe prose shape|固定两句|固定写两条/);
  }
  assert.match(researcherPrompts[0], /Current contract: typed findings submission/);
  assert.match(
    researcherPrompts[0],
    /captures the same object[\s\S]*terminates the child[\s\S]*do not call[\s\S]*structured_output/i
  );
  assert.match(researcherPrompts[0], /inspect the actual section string once/);
  assert.match(researcherPrompts[0], /at most 12 findings[\s\S]*at most 6 pointers[\s\S]*at most 24/);
  assert.doesNotMatch(researcherPrompts[0], /exactly 1–2 compact bullets|never more than 3/);
  assert.doesNotMatch(researcherPrompts[0], /Enumerate every number|complete this zero-tool check/);
  assert.match(
    plannerContract,
    /Capability -> operation[\s\S]*compareTopN[\s\S]*quantileBins[\s\S]*correlation[\s\S]*never from memorized business fields/i
  );
  assert.match(plannerContract, /CAPABILITY_OPERATION_TYPES/);
  const b25Section = skill.slice(skill.indexOf("### B2.5"), skill.indexOf("### B3.5"));
  assert.match(b25Section, /两个 sibling Bash[\s\S]*列表顺序[\s\S]*不要求等待/);
  assert.match(b25Section, /operations 必须最小且不重叠[\s\S]*最多六个/);
  assert.match(
    b25Section,
    /平衡\/权衡\/最好\/最佳点[\s\S]*不[\s\S]*等于用户要求日期、具体记录或排名[\s\S]*明确要求/i
  );
  assert.match(b25Section, /相关性写成因果或显著性/);
  assert.match(
    b25Section,
    /jointQuantileBins[\s\S]*恰好两个驱动字段[\s\S]*共同[\s\S]*complete-case[\s\S]*二维等频分箱/i
  );
  assert.match(b25Section, /jointQuantileBins[\s\S]*最佳已观测组合/);
  assert.match(
    b25Section,
    /不得拼接两个边际最优[\s\S]*不得外推全局最优、因果或显著性[\s\S]*不得插值[\s\S]*未观察到的组合/
  );
  assert.match(b25Section, /不得读文件[\s\S]*召回 Spec[\s\S]*查数或写产物/);
  assert.doesNotMatch(b25Section, /"requiredColumns": \["日维度", "门店毛利额"\]/);
  assert.match(skill, /entry\.meta\.json/);
  assert.match(skill, /check-session-layout\.mjs/);
  assert.match(skill, /stage-gate\.mjs/);
  assert.match(skill, /A_CONFIG/);
  assert.match(skill, /B0_PREFLIGHT/);
  assert.match(skill, /B2_WRITER/);
  assert.match(skill, /B2_MAIN/);
  assert.match(skill, /compose-main/);
  assert.match(skill, /B25_EDITOR/);
  assert.match(skill, /B3_RESEARCH/);
  assert.match(skill, /B4_REVIEW/);
  assert.match(skill, /B5_DESIGN/);
  assert.match(skill, /--phase writer/);
  assert.match(skill, /start.*工作.*layout.*finish.*stop/is);
  assert.match(skill, /重试当前阶段/);
  assert.match(skill, /关闭单步调试并继续/);
  assert.match(skill, /HTML_REPORT_GATE_MODE=auto/);
  assert.match(skill, /quality-scan\.mjs/);
  assert.match(skill, /write-verdict\.mjs/);
  assert.match(skill, /producer|scanFingerprint|forged|hand-write|手改|手写/i);
  assert.match(skill, /B4|report-reviewer|phase quality/i);
  assert.match(skill, /report-researcher` 单步骤 chain|chain[\s\S]*agent: "report-researcher"/i);
  const b3Flow = skill.slice(skill.indexOf("#### B3.5.1"), skill.indexOf("### B4"));
  assert.match(b3Flow, /单个 JSON 返回[\s\S]*不要读取 summary\/section[\s\S]*所有 task 收齐后[\s\S]*finalizer[\s\S]*一次性/i);
  assert.match(b3Flow, /run exactly[\s\S]*one deterministic finalizer[\s\S]*finalize-research-stage\.mjs/i);
  assert.match(b3Flow, /Do not separately read summary files[\s\S]*edit tasks\/main[\s\S]*assemble[\s\S]*layout/i);
  assert.match(skill, /structured chain step[\s\S]*agent: "report-reviewer"/i);
  assert.match(skill, /禁止解析.*acceptance report|Never interpret.*acceptance report/is);
  assert.match(skill, /infrastructure_error[\s\S]*stage-gate\.mjs fail[\s\S]*重试当前阶段/i);
  assert.match(skill, /compile-report-content\.mjs/);
  assert.match(skill, /compose-report\.mjs/);
  assert.match(skill, /capture.*desktop\/mobile|desktop\/mobile.*capture/i);
  assert.match(skill, /finalize-design\.mjs/);
  assert.match(skill, /B5|report-designer|phase html|report\.html/i);
  const b5Flow = skill.slice(skill.indexOf("### B5"), skill.indexOf("### Phase B bans"));
  assert.match(b5Flow, /single|单步骤[\s\S]*chain|chain[\s\S]*agent: "report-designer"/i);
  assert.match(b5Flow, /acceptance\.level=none/);
  assert.match(b5Flow, /structured_output/);
  assert.match(b5Flow, /do not[\s\S]*read[\s\S]*layout again|不要[\s\S]*再次运行 layout/i);
  assert.match(b5Flow, /never[\s\S]*re-dispatch Designer|never start a duplicate Designer/i);
  assert.match(skill, /FORBIDDEN|禁止.*analysis\/|repo-root `analysis`|repository-root `analysis`/i);
  assert.match(skill, /\$SESSION|SESSION=/);
  // Skill must not instruct agents to pass a watch pid / PPID.
  assert.doesNotMatch(skill, /--watch-pid "\$\{/);
  assert.doesNotMatch(skill, /--watch-pid "\$PPID"/);
  assert.match(skill, /not\*\* pass `--watch-pid`|do \*\*not\*\* pass `--watch-pid`|do not pass `--watch-pid`/i);
  // Phase A still bans full multi-page narrative fetch; Phase B uses fetch-entry script.
  assert.match(skill, /Phase A bans|Full multi-page report data collection/i);
});

test("html confirm path preserves or backfills analysisFocus", async () => {
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /function ensureAnalysisFocus\(/);
  assert.match(html, /card\.analysisFocus = analysisFocus/);
  assert.match(html, /围绕「/);
});

test("html confirm warns when cards have no effective filters", async () => {
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /function isEffectiveFilter\(/);
  assert.match(html, /function confirmEmptyFiltersGate\(/);
  assert.match(html, /confirmEmptyFiltersGate\(state\.cards\)/);
  assert.match(html, /全门店|过滤条件/);
  assert.match(html, /window\.confirm\(/);
});

test("html confirm title falls back to first card title", async () => {
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /function resolveReportTitle\(/);
  assert.match(html, /firstCardTitle|cards\[0\]\?\.title/);
  assert.match(html, /title:\s*title|title,\s*$/m);
  // After loading recommendations without top-level title, backfill from first card.
  assert.match(html, /if \(!state\.harness\.title\)/);
});

test("recommendation normalizer reads flat skill card fields before nested fallbacks", async () => {
  const html = await readFile(htmlPath, "utf8");
  // Regression: previous code only read suggested/requestBody and dropped skill-written
  // top-level indicatorFieldList / aggDimUniqueCodeList / startDate / indicatorBizId.
  assert.match(html, /function normalizeRecommendationCard\(/);
  assert.match(html, /indicatorFieldList:\s*firstList\(\s*item\.indicatorFieldList/);
  assert.match(html, /aggDimUniqueCodeList:\s*firstList\(\s*item\.aggDimUniqueCodeList/);
  assert.match(html, /item\.startDate/);
  assert.match(html, /item\.indicatorBizId/);
  assert.match(html, /function reportPageState\(/);
  assert.match(html, /\/harness\/page-state/);
});

test("local server serves page, recommendations, health, token config and page-state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-report-"));
  const file = join(dir, "recommendations.json");
  await writeFile(file, JSON.stringify(valid()));
  const child = spawn(process.execPath, [serverScript, "--config", file], {
    cwd: root,
    env: { ...process.env, QDM_INDICATORS_TOKEN: "test-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  const [chunk] = await once(child.stdout, "data");
  const base = chunk.toString().trim();

  assert.equal((await fetch(`${base}healthz`)).status, 200);
  assert.equal((await fetch(`${base}missing`)).status, 404);
  assert.equal((await fetch(`${base}../AGENTS.md`)).status, 404);
  assert.equal((await (await fetch(`${base}harness/config`)).json()).token, "test-token");

  const recommendations = await (await fetch(`${base}harness/recommendations`)).json();
  assert.equal(recommendations.cards.length, 1);
  assert.deepEqual(recommendations.cards[0].indicatorFieldList, ["saleAmt"]);
  assert.deepEqual(recommendations.cards[0].aggDimUniqueCodeList, ["bizDate"]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).cards[0].aggDimUniqueCodeList, ["bizDate"]);
  assert.match(await (await fetch(base)).text(), /确认生成报告/);

  const initialState = await (await fetch(`${base}harness/page-state`)).json();
  assert.equal(initialState.recommendationsSummary.cardCount, 1);
  assert.deepEqual(initialState.recommendationsSummary.cards[0].indicatorFieldList, ["saleAmt"]);
  assert.ok(initialState.statePath);

  const snapshot = {
    updatedAt: "2026-07-17T00:00:00.000Z",
    reason: "test",
    loaded: true,
    activeCardId: "c1",
    cards: [{
      id: "c1",
      title: "销售额",
      indicatorFieldList: ["saleAmt"],
      aggDimUniqueCodeList: ["bizDate"],
      startDate: "2026-07-01",
      endDate: "2026-07-14",
      filters: [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }],
      selectionStatus: {
        indicatorsSelected: 1,
        indicatorsResolved: 1,
        indicatorsMissing: [],
        dimsSelected: 1,
        dimsResolved: 1,
        dimsMissing: [],
        filtersSelected: 1,
        hasTimeRange: true,
      },
    }],
  };
  const post = await fetch(`${base}harness/page-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).ok, true);

  const after = await (await fetch(`${base}harness/page-state`)).json();
  assert.equal(after.page.activeCardId, "c1");
  assert.deepEqual(after.page.cards[0].indicatorFieldList, ["saleAmt"]);
  assert.deepEqual(after.page.cards[0].filters[0].values, ["101001"]);

  const persisted = JSON.parse(await readFile(join(dir, "page-state.json"), "utf8"));
  assert.equal(persisted.reason, "test");
  assert.deepEqual(persisted.cards[0].indicatorFieldList, ["saleAmt"]);

  const meta = JSON.parse(await readFile(join(dir, "server-meta.json"), "utf8"));
  assert.equal(meta.pid, child.pid);
  assert.ok(meta.url.startsWith("http://127.0.0.1:"));
  assert.equal(meta.configPath, file);
});

test("server stops when watch-pid exits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-report-watch-"));
  const file = join(dir, "recommendations.json");
  await writeFile(file, JSON.stringify(valid()));

  // A short-lived owner process; server must die after this PID exits.
  const owner = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(async () => {
    try {
      owner.kill("SIGKILL");
    } catch {
      // already dead
    }
    await rm(dir, { recursive: true, force: true });
  });

  const child = spawn(
    process.execPath,
    [serverScript, "--config", file, "--watch-pid", String(owner.pid), "--max-idle-ms", "0", "--max-lifetime-ms", "0"],
    {
      cwd: root,
      env: { ...process.env, QDM_INDICATORS_TOKEN: "test-token" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const [chunk] = await once(child.stdout, "data");
  const base = chunk.toString().trim();
  assert.equal((await fetch(`${base}healthz`)).status, 200);

  owner.kill("SIGTERM");
  const exit = await Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit after watch-pid died")), 8000)),
  ]);
  assert.ok(exit.code === 0 || exit.signal === "SIGTERM" || exit.signal === null);
});

test("server --detach returns quickly and keeps serving after launcher exits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-report-detach-"));
  const file = join(dir, "recommendations.json");
  await writeFile(file, JSON.stringify(valid()));

  const owner = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(async () => {
    try {
      owner.kill("SIGKILL");
    } catch {
      // ignore
    }
    spawnSync(process.execPath, [serverScript, "--config", file, "--stop"], { cwd: root, encoding: "utf8" });
    await rm(dir, { recursive: true, force: true });
  });

  const launcher = spawn(
    process.execPath,
    [serverScript, "--config", file, "--detach", "--watch-pid", String(owner.pid), "--max-idle-ms", "0", "--max-lifetime-ms", "0"],
    {
      cwd: root,
      env: { ...process.env, QDM_INDICATORS_TOKEN: "test-token" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const [chunk] = await once(launcher.stdout, "data");
  const base = chunk.toString().trim();
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const launcherExit = await Promise.race([
    once(launcher, "exit").then(([code]) => code),
    new Promise((_, reject) => setTimeout(() => reject(new Error("detach launcher did not exit")), 10000)),
  ]);
  assert.equal(launcherExit, 0);

  // Launcher is gone; worker must still serve.
  assert.equal((await fetch(`${base}healthz`)).status, 200);
  const meta = JSON.parse(await readFile(join(dir, "server-meta.json"), "utf8"));
  assert.notEqual(meta.pid, launcher.pid);
  assert.equal(meta.watchPid, owner.pid);

  owner.kill("SIGTERM");
  // Worker should shut down after watch-pid exits.
  const deadline = Date.now() + 8000;
  let down = false;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}healthz`);
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      down = true;
      break;
    }
  }
  assert.equal(down, true, "detached worker should exit when watch-pid dies");
});

test("confirm validates cards and writes result.json into session dir", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-report-confirm-"));
  const file = join(dir, "recommendations.json");
  await writeFile(file, JSON.stringify({ ...valid(), userQuestion: "分析销售额" }));
  const child = spawn(process.execPath, [serverScript, "--config", file, "--max-idle-ms", "0", "--max-lifetime-ms", "0"], {
    cwd: root,
    env: { ...process.env, QDM_INDICATORS_TOKEN: "test-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true });
  });
  const [chunk] = await once(child.stdout, "data");
  const base = chunk.toString().trim();

  const bad = await fetch(`${base}harness/confirm/validate-card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      index: 0,
      total: 1,
      card: {
        id: "c1",
        title: "坏卡片",
        requestBody: {
          indicatorFieldList: [],
          aggDimUniqueCodeList: ["bizDate"],
          startDate: "2026-07-01",
          endDate: "2026-07-14",
        },
      },
    }),
  });
  assert.equal(bad.status, 422);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.match(badBody.error.summary || badBody.error.detail || "", /指标|CLI|失败|空/);

  const payload = {
    status: "confirmed",
    title: "销售额",
    mode: "single",
    cards: [{
      id: "c1",
      title: "销售额",
      indicatorFieldList: ["saleAmt"],
      aggDimUniqueCodeList: ["bizDate"],
      requestBody: {
        indicatorFieldList: ["saleAmt"],
        aggDimUniqueCodeList: ["bizDate"],
        startDate: "2026-07-01",
        endDate: "2026-07-14",
        storeCollectType: 1,
        chartType: "table",
        filterDimUniqueCodeList: [],
        columnAggDimUniqueCodeList: [],
        indicatorsGroup: 1,
        currPage: 1,
        pageSize: 20,
        compareDate: [],
      },
    }],
  };
  const saved = await fetch(`${base}harness/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, validation: [{ ok: true, cardId: "c1" }] }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.ok, true);
  assert.match(savedBody.result_path, /result\.json$/);

  const onDisk = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
  assert.equal(onDisk.status, "confirmed");
  assert.equal(onDisk.already_validated, true);
  assert.equal(onDisk.userQuestion, "分析销售额");
  assert.equal(onDisk.cards.length, 1);
  assert.equal(onDisk.cards[0].indicatorFieldList[0], "saleAmt");

  const got = await (await fetch(`${base}harness/result`)).json();
  assert.equal(got.cards[0].id, "c1");
});

test("confirm accepts card.query and validates through qdm-metric-cli", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-report-query-confirm-"));
  const file = join(dir, "recommendations.json");
  const fakeMetricCli = join(dir, "qdm-metric-cli");
  const fakeMetricLog = join(dir, "metric-cli.log");
  await writeFile(file, JSON.stringify(valid()));
  await writeFile(fakeMetricCli, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$QDM_FAKE_METRIC_LOG\"\nprintf '[]\\n'\n", { mode: 0o755 });
  const child = spawn(process.execPath, [serverScript, "--config", file, "--max-idle-ms", "0", "--max-lifetime-ms", "0"], {
    cwd: root,
    env: { ...process.env, QDM_METRIC_CLI: fakeMetricCli, QDM_FAKE_METRIC_LOG: fakeMetricLog },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true });
  });
  const [chunk] = await once(child.stdout, "data");
  const base = chunk.toString().trim();

  const payload = {
    status: "confirmed",
    title: "销售额",
    mode: "builder",
    cards: [{
      id: "c1",
      title: "销售额",
      headingLevel: 2,
      analysisFocus: "趋势",
      chartType: "table",
      indicatorBizId: "1",
      query: {
        request: {
          metrics: ["saleAmt"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-07-01", endDate: "2026-07-14", grain: "DAY" },
          dimensions: ["bizDate"],
          filters: { storeId: ["101001"] },
          pageNo: 1,
          pageSize: 500,
        },
        comparisons: [],
      },
    }],
  };
  const checked = await fetch(`${base}harness/confirm/validate-card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index: 0, total: 1, card: payload.cards[0] }),
  });
  assert.equal(checked.status, 200);
  const checkedBody = await checked.json();
  assert.equal(checkedBody.ok, true);

  const saved = await fetch(`${base}harness/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(saved.status, 200);

  const onDisk = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
  assert.deepEqual(onDisk.cards[0].query.request.metrics, ["saleAmt"]);
  assert.equal(Object.hasOwn(onDisk.cards[0], "requestBody"), false);
  const metricLog = await readFile(fakeMetricLog, "utf8");
  assert.match(metricLog, /analysis execute --payload-json/);
});

test("server --stop terminates a running instance for the same config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-report-stop-"));
  const file = join(dir, "recommendations.json");
  await writeFile(file, JSON.stringify(valid()));
  const child = spawn(process.execPath, [serverScript, "--config", file, "--max-idle-ms", "0", "--max-lifetime-ms", "0"], {
    cwd: root,
    env: { ...process.env, QDM_INDICATORS_TOKEN: "test-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
    await rm(dir, { recursive: true, force: true });
  });
  const [chunk] = await once(child.stdout, "data");
  const base = chunk.toString().trim();
  assert.equal((await fetch(`${base}healthz`)).status, 200);

  const stop = spawnSync(process.execPath, [serverScript, "--config", file, "--stop"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /"stopped": true/);

  const exit = await Promise.race([
    once(child, "exit").then(([code]) => code),
    new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit after --stop")), 8000)),
  ]);
  assert.equal(typeof exit, "number");
});
