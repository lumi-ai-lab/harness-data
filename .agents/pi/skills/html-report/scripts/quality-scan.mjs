#!/usr/bin/env node
/**
 * Mechanical quality scan for Phase B report drafts.
 * Extracts numbers from trusted Writer entries and layout-validated Researcher
 * evidence, then compares them to numbers cited in the assembled report.
 *
 * Usage:
 *   node quality-scan.mjs --result <result.json>
 *   node quality-scan.mjs --session-dir .harness/state/html-report/<id>
 *
 * Writes: $SESSION/quality/scan.json
 * Exit 0 always when scan completes (verdict is separate); exit 1 on I/O errors.
 */
import { readFile, writeFile, mkdir, readdir, stat, access } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSessionLayout } from "./check-session-layout.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir, acc = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** Collect numeric leaves from JSON-like structures. */
export function collectNumbersFromJson(value, path = "$", out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push({ value, path, raw: String(value), isPercent: false });
    return out;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Only a complete numeric cell is evidence. Dates and prose containing a
    // number are deliberately excluded; an optional trailing % keeps its unit.
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(%)?$/.exec(trimmed);
    if (match) {
      out.push({
        value: Number(match[1]),
        path,
        raw: trimmed,
        isPercent: Boolean(match[2]),
      });
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectNumbersFromJson(item, `${path}[${i}]`, out));
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectNumbersFromJson(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/**
 * Extract numbers from markdown/text.
 * Captures: 4,540 / 4540 / 17.45 / 22,337.06 / 18.3% / -18.3%
 */
export function extractNumbersFromText(text, source = "text") {
  const found = [];
  const re = /(?<![\w.])(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)(%)?(?![\w.])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const isPct = Boolean(m[2]);
    const numStr = m[1].replace(/,/g, "");
    const value = Number(numStr);
    if (!Number.isFinite(value)) continue;
    // Skip lone years that look like 2026 when not part of larger evidence check — keep them but mark low weight
    const start = m.index;
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const lineEnd = text.indexOf("\n", start);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    found.push({
      value,
      raw,
      isPercent: isPct,
      index: start,
      line: line.trim(),
      source,
      weight: isPct ? "soft" : value >= 1000 || (Number.isInteger(value) && Math.abs(value) >= 100) ? "hard" : "soft",
    });
  }
  return found;
}

export function numbersClose(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  if (Math.abs(a - b) < 1e-6) return true;
  if (Math.abs(a - b) <= 0.05) return true; // cents / rounding
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  if (scale >= 100 && Math.abs(a - b) / scale <= 0.001) return true;
  // report truncated integer of money amount
  if (scale >= 100 && Math.round(a) === Math.round(b)) return true;
  return false;
}

/** Narrative rounding: report writes 4,500 for evidence 4540. */
export function numbersCloseApprox(a, b) {
  if (numbersClose(a, b)) return "exact";
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  // ~2.5% relative for counts/money ≥ 100 (covers 4,500 vs 4540)
  if (scale >= 100 && Math.abs(a - b) / scale <= 0.025) return "approx";
  // same hundred bucket for large integers
  if (scale >= 1000 && Math.round(a / 100) === Math.round(b / 100)) return "approx";
  return false;
}

/** Pull dim/filter ids and other config numbers from confirmed result.json. */
export function collectNumbersFromResult(result, out = []) {
  if (!result || typeof result !== "object") return out;
  const cards = Array.isArray(result.cards) ? result.cards : [];
  cards.forEach((card, ci) => {
    const filters = card.filters || card.requestBody?.filters || [];
    for (const f of filters) {
      const ids = f.dimFieldIdList || f.dimValueList || [];
      for (const id of ids) {
        const n = Number(String(id).replace(/,/g, ""));
        if (Number.isFinite(n)) {
          out.push({ value: n, path: `result.json.cards[${ci}].filters`, raw: String(id) });
        }
      }
    }
    // bare store ids in analysis text often come from config
    for (const key of ["storeId", "store_id"]) {
      if (card[key] != null) {
        const n = Number(card[key]);
        if (Number.isFinite(n)) out.push({ value: n, path: `result.json.cards[${ci}].${key}`, raw: String(card[key]) });
      }
    }
  });
  // also scan entire result for pure numeric leaves (dates stay strings)
  collectNumbersFromJson(result, "result.json", out);
  return out;
}

/**
 * From nested JSON (entry/explore), collect per-field column stats: sum/avg/min/max/count.
 * Used when report cites aggregates that are not literal row values.
 * Does NOT invent product/cross-metric pseudo fields.
 */
export function collectColumnStatsFromJson(value, path = "$", out = []) {
  const arrays = [];
  function findRowArrays(node, p) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
        arrays.push({ rows: node, path: p });
      } else {
        node.forEach((item, i) => findRowArrays(item, `${p}[${i}]`));
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      findRowArrays(v, `${p}.${k}`);
    }
  }
  findRowArrays(value, path);

  for (const { rows, path: base } of arrays) {
    const cols = new Map(); // field -> number[]
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        let n = null;
        if (typeof v === "number" && Number.isFinite(v)) n = v;
        else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
        if (n === null || !Number.isFinite(n)) continue;
        if (!cols.has(k)) cols.set(k, []);
        cols.get(k).push(n);
      }
    }
    for (const [field, nums] of cols) {
      if (!nums.length) continue;
      const sum = nums.reduce((a, b) => a + b, 0);
      const avg = sum / nums.length;
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const count = nums.length;
      const prefix = `${base}.#stats.${field}`;
      const additive = !/(^|[_\s])(id|code)($|[_\s])|编号|编码|日期|时间|年月|维度|率|比例|占比|百分比|平均|均价|单价|客单价|人均|次均|户均|rate|ratio|percent|average|\bavg\b|\bper\b/i.test(field);
      out.push({ value: sum, path: `${prefix}.sum`, raw: String(sum), kind: "col-sum", additive });
      out.push({ value: avg, path: `${prefix}.avg`, raw: String(avg), kind: "col-avg" });
      out.push({ value: min, path: `${prefix}.min`, raw: String(min), kind: "col-min" });
      out.push({ value: max, path: `${prefix}.max`, raw: String(max), kind: "col-max" });
      out.push({ value: count, path: `${prefix}.count`, raw: String(count), kind: "col-count" });
    }
  }
  return out;
}

/** True if the report line looks like invented / simulated business metric prose. */
export function looksInventedMetricLine(line = "") {
  return /模拟|推算销售额|估算营收|虚构|自造/.test(String(line));
}

/**
 * Re-check unmatched report numbers against column stats evidence.
 * Returns { matchedExtra, stillUnmatched, softFromStats }.
 */
export function reconcileUnmatchedWithColumnStats(unmatched, columnStatEvidence) {
  const matchedExtra = [];
  const stillUnmatched = [];
  const softFromStats = [];
  for (const rn of unmatched) {
    if (rn.isPercent) {
      stillUnmatched.push(rn);
      continue;
    }
    let best = null;
    let bestKind = false;
    for (const en of columnStatEvidence) {
      if (en.kind === "col-sum" && en.additive === false) continue;
      const kind = numbersCloseApprox(en.value, rn.value);
      if (kind === "exact") {
        best = en;
        bestKind = "exact";
        break;
      }
      if (kind === "approx" && bestKind !== "exact") {
        best = en;
        bestKind = "approx";
      }
    }
    if (best) {
      matchedExtra.push({
        ...rn,
        matchType: bestKind === "approx" ? "col-stat-approx" : "col-stat",
        evidencePath: best.path,
        evidenceValue: best.value,
      });
      softFromStats.push({
        severity: "soft",
        code: "DERIVED_COLUMN_STAT",
        message: `数字 ${rn.raw} 未出现在行级 data，但与列统计 ${best.path}≈${best.value} 可复算一致`,
        where: rn.line || rn.source,
      });
    } else {
      stillUnmatched.push(rn);
    }
  }
  return { matchedExtra, stillUnmatched, softFromStats };
}

export function matchReportToEvidence(reportNumbers, evidenceNumbers) {
  const matched = [];
  const unmatched = [];
  for (const rn of reportNumbers) {
    // Skip trivial 0/1 often structural
    if (!rn.isPercent && (rn.value === 0 || rn.value === 1) && rn.weight === "soft") {
      matched.push({ ...rn, matchType: "skipped-trivial" });
      continue;
    }
    // Years like 2026 in date ranges — soft skip if 1900-2100 integer
    if (!rn.isPercent && Number.isInteger(rn.value) && rn.value >= 1900 && rn.value <= 2100) {
      matched.push({ ...rn, matchType: "skipped-year" });
      continue;
    }
    // Small week/index integers (2–99) without percent — usually structural, soft only
    if (!rn.isPercent && Number.isInteger(rn.value) && Math.abs(rn.value) >= 2 && Math.abs(rn.value) < 100) {
      matched.push({ ...rn, matchType: "skipped-small-int" });
      continue;
    }
    let best = null;
    let bestKind = false;
    for (const en of evidenceNumbers) {
      if (rn.isPercent) {
        const ok = en.isPercent === true
          ? numbersClose(en.value, rn.value) || numbersClose(Math.abs(en.value), Math.abs(rn.value))
          : numbersClose(en.value, rn.value) ||
            numbersClose(en.value * 100, rn.value) ||
            numbersClose(en.value, rn.value / 100) ||
            numbersClose(Math.abs(en.value), Math.abs(rn.value));
        if (ok) {
          best = en;
          bestKind = "exact";
          break;
        }
        continue;
      }
      // Keep units strict in both directions: a percent cell is not evidence
      // for a plain amount/count that merely has the same numeric magnitude.
      if (en.isPercent === true) continue;
      const kind = numbersCloseApprox(en.value, rn.value);
      if (kind === "exact") {
        best = en;
        bestKind = "exact";
        break;
      }
      if (kind === "approx" && bestKind !== "exact") {
        best = en;
        bestKind = "approx";
      }
    }
    if (best) {
      matched.push({
        ...rn,
        matchType: bestKind === "approx" ? "evidence-approx" : "evidence",
        evidencePath: best.path,
        evidenceValue: best.value,
      });
    } else unmatched.push(rn);
  }
  return { matched, unmatched };
}

export function buildHardIssues(unmatched) {
  const issues = [];
  for (const u of unmatched) {
    if (u.weight !== "hard") continue;
    if (u.isPercent) continue; // derived ratios → soft only
    const invented = looksInventedMetricLine(u.line || "");
    issues.push({
      severity: "hard",
      code: invented ? "INVENTED_METRIC" : "DATA_UNTRACEABLE",
      message: invented
        ? `报告中的数字 ${u.raw} 出现在疑似编造/模拟业务表述中，且无法从取数落盘或列汇总复算`
        : `报告中的数字 ${u.raw} 未能在可信 Writer/Researcher 落盘结果（含列 sum/avg/min/max）中找到对应值`,
      where: u.line || u.source,
      value: u.value,
      raw: u.raw,
    });
  }
  return issues;
}

export function softDepthHints(mainText, result) {
  const issues = [];
  const q = String(result?.question || result?.title || "");
  const lower = mainText.toLowerCase();
  if (mainText.length < 200) {
    issues.push({
      severity: "soft",
      code: "DEPTH_SHORT",
      message: "main.md 篇幅过短，可能分析深度不足",
      where: "analysis/main.md",
    });
  }
  if (!/结论|平衡|建议|发现|最优|最佳/.test(mainText)) {
    issues.push({
      severity: "soft",
      code: "DEPTH_NO_CONCLUSION",
      message: "main.md 未明显包含结论/建议类小节，可能未充分回答用户问题",
      where: "analysis/main.md",
    });
  }
  // If user question mentions 平衡 but report never does
  if (/平衡/.test(q) && !/平衡/.test(mainText)) {
    issues.push({
      severity: "soft",
      code: "DEPTH_MISS_QUESTION",
      message: "用户问题强调「平衡」，但 main.md 未出现相关表述",
      where: "analysis/main.md",
    });
  }
  return issues;
}

function sanitizeTaskId(raw) {
  const value = String(raw || "task").trim();
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "task";
}

/**
 * Researcher views and new-query rows are derived evidence, so they are
 * trusted only after the complete B3 explore layout (source hashes,
 * deterministic views, summaries, task state and final assembly) passes.
 * Fail closed and never keep a partial set if any post-gate read fails.
 */
async function collectTrustedResearcherEvidence(sessionDir, { failOnInvalid = false } = {}) {
  let layout;
  try {
    layout = await checkSessionLayout(sessionDir, { phase: "explore" });
  } catch (error) {
    if (failOnInvalid) {
      const failure = new Error(
        `B3_EXPLORE_LAYOUT_INVALID: explore layout validation failed: ${error.message || error}`
      );
      failure.code = "B3_EXPLORE_LAYOUT_INVALID";
      throw failure;
    }
    return {
      numbers: [],
      columnStats: [],
      status: {
        layoutPhase: "explore",
        layoutValidated: false,
        fileCount: 0,
        sourceFileCount: 0,
        numberCount: 0,
        columnStatCount: 0,
        validationErrors: [`explore layout validation failed: ${error.message || error}`],
      },
    };
  }
  const status = {
    layoutPhase: "explore",
    layoutValidated: layout.ok,
    fileCount: 0,
    sourceFileCount: 0,
    numberCount: 0,
    columnStatCount: 0,
    validationErrors: layout.ok ? [] : layout.errors,
  };
  if (!layout.ok) {
    if (failOnInvalid) {
      const details = layout.errors.length ? layout.errors.join("; ") : "unknown layout error";
      const failure = new Error(`B3_EXPLORE_LAYOUT_INVALID: ${details}`);
      failure.code = "B3_EXPLORE_LAYOUT_INVALID";
      failure.validationErrors = layout.errors;
      throw failure;
    }
    return { numbers: [], columnStats: [], status };
  }

  try {
    const tasksDocument = JSON.parse(
      await readFile(join(sessionDir, "analysis", "tasks.json"), "utf8")
    );
    const numbers = [];
    const columnStats = [];
    let fileCount = 0;
    let sourceFileCount = 0;
    for (const task of tasksDocument.tasks) {
      if (String(task?.status || "").toLowerCase() !== "done") continue;
      const taskId = sanitizeTaskId(task.id);
      const rel = join("analysis", "evidence", `${taskId}.json`);
      const packet = JSON.parse(await readFile(join(sessionDir, rel), "utf8"));
      collectNumbersFromJson(packet.views, `${rel}.views`, numbers);
      fileCount += 1;

      // Payload files describe the query and are never business evidence.
      // Only the hashed source rows for a validated new_query task are added.
      if (task.evidencePlan?.mode === "new_query") {
        const sourceRel = join("data", "explore", `${taskId}.json`);
        const source = JSON.parse(await readFile(join(sessionDir, sourceRel), "utf8"));
        collectNumbersFromJson(source, sourceRel, numbers);
        collectColumnStatsFromJson(source, sourceRel, columnStats);
        sourceFileCount += 1;
      }
    }
    status.fileCount = fileCount;
    status.sourceFileCount = sourceFileCount;
    status.numberCount = numbers.length;
    status.columnStatCount = columnStats.length;
    return { numbers, columnStats, status };
  } catch (error) {
    if (failOnInvalid) {
      const failure = new Error(
        `B3_RESEARCH_EVIDENCE_READ_FAILED: cannot collect validated Researcher evidence: ${error.message || error}`
      );
      failure.code = "B3_RESEARCH_EVIDENCE_READ_FAILED";
      throw failure;
    }
    return {
      numbers: [],
      columnStats: [],
      status: {
        ...status,
        layoutValidated: false,
        fileCount: 0,
        sourceFileCount: 0,
        numberCount: 0,
        columnStatCount: 0,
        validationErrors: [`cannot collect validated Researcher evidence: ${error.message || error}`],
      },
    };
  }
}

export async function runQualityScan(sessionDir) {
  const abs = resolve(sessionDir);
  const dataDir = join(abs, "data");
  const analysisDir = join(abs, "analysis");
  const qualityDir = join(abs, "quality");
  const finalReportPath = join(abs, "report", "report.md");

  // A final report means B4 is reviewing the authoritative B3 candidate.  In
  // that mode an invalid explore layout is an infrastructure failure, not
  // evidence to be silently discarded while an LLM continues scoring.  Keep
  // the no-final-report fallback for the legacy B2 diagnostic use case.
  const authoritativeCandidate = await exists(finalReportPath);
  const researcherEvidence = await collectTrustedResearcherEvidence(abs, {
    failOnInvalid: authoritativeCandidate,
  });

  const evidence = [];
  const columnStats = [];
  const cardsDir = join(dataDir, "cards");
  const writerEntryFiles = (await walkFiles(cardsDir)).filter((f) => {
    const rel = relative(cardsDir, f).replaceAll("\\", "/");
    return /^[^/]+\/entry\.json$/.test(rel);
  });
  for (const f of writerEntryFiles) {
    try {
      const raw = await readFile(f, "utf8");
      const json = JSON.parse(raw);
      const rel = relative(abs, f);
      const nums = collectNumbersFromJson(json, rel);
      evidence.push(...nums);
      // Statistics are transient quality evidence only. B2 does not persist
      // profile/facts artifacts and Writers never consume these calculations.
      collectColumnStatsFromJson(json, rel, columnStats);
    } catch {
      // ignore unreadable
    }
  }

  let result = {};
  try {
    result = JSON.parse(await readFile(join(abs, "result.json"), "utf8"));
  } catch {
    result = {};
  }
  collectNumbersFromResult(result, evidence);

  evidence.push(...researcherEvidence.numbers);
  columnStats.push(...researcherEvidence.columnStats);

  const reportFiles = [];
  const mainPath = join(analysisDir, "main.md");
  // Once assembled, scan exactly what will be delivered. Before assembly keep
  // the legacy draft fallback so B2 diagnostics remain useful.
  if (await exists(finalReportPath)) {
    reportFiles.push(finalReportPath);
  } else {
    try {
      await stat(mainPath);
      reportFiles.push(mainPath);
    } catch {
      // missing
    }
    const sectionFiles = (await walkFiles(join(analysisDir, "sections"))).filter((f) => f.endsWith(".md"));
    reportFiles.push(...sectionFiles);
  }

  const reportNumbers = [];
  let mainText = "";
  for (const f of reportFiles) {
    const text = await readFile(f, "utf8");
    if (f.endsWith("main.md") || f.endsWith("report.md")) mainText = text;
    reportNumbers.push(...extractNumbersFromText(text, relative(abs, f)));
  }

  // 1) literal match against row-level evidence
  let { matched, unmatched } = matchReportToEvidence(reportNumbers, evidence);
  // 2) Review-oriented reconcile: unmatched vs column sum/avg/min/max/count
  const recon = reconcileUnmatchedWithColumnStats(unmatched, columnStats);
  matched = matched.concat(recon.matchedExtra);
  unmatched = recon.stillUnmatched;

  const hardFromData = buildHardIssues(unmatched);
  const soft = [
    ...recon.softFromStats,
    ...unmatched
      .filter((u) => u.weight === "soft" || u.isPercent)
      .map((u) => ({
        severity: "soft",
        code: u.isPercent ? "DERIVED_PERCENT" : "DATA_UNTRACEABLE_SOFT",
        message: `数字 ${u.raw} 未直接出现在可信 Writer/Researcher 证据中（可能为推算或格式差异），请人工核对`,
        where: u.line || u.source,
      })),
    ...softDepthHints(mainText, result),
  ];

  // Deduplicate soft by message+where
  const softKey = new Set();
  const softUnique = [];
  for (const s of soft) {
    const k = `${s.code}|${s.message}|${s.where}`;
    if (softKey.has(k)) continue;
    softKey.add(k);
    softUnique.push(s);
  }

  const matchedForReport = matched.filter((m) =>
    m.matchType === "evidence" ||
    m.matchType === "evidence-approx" ||
    m.matchType === "col-stat" ||
    m.matchType === "col-stat-approx"
  );

  const scan = {
    version: 1,
    checkedAt: new Date().toISOString(),
    sessionDir: abs,
    evidence: {
      fileCount: writerEntryFiles.length + researcherEvidence.status.sourceFileCount,
      writerFileCount: writerEntryFiles.length,
      numberCount: evidence.length,
      columnStatCount: columnStats.length,
      researcher: researcherEvidence.status,
      sample: evidence.slice(0, 20),
    },
    report: {
      fileCount: reportFiles.length,
      numberCount: reportNumbers.length,
      matchedCount: matchedForReport.length,
      unmatchedCount: unmatched.length,
    },
    matched: matchedForReport.slice(0, 100),
    unmatched,
    hardIssues: hardFromData,
    softIssues: softUnique,
    suggestPass: hardFromData.length === 0,
  };

  await mkdir(qualityDir, { recursive: true });
  const scanPath = join(qualityDir, "scan.json");
  await writeFile(scanPath, `${JSON.stringify(scan, null, 2)}\n`);
  return { scan, scanPath };
}

/**
 * Write mechanical draft verdict (hard issues only from scan).
 * QUALITY agent should refine pass/fail after qualitative review.
 */
export async function writeDraftVerdict(sessionDir, scan) {
  const qualityDir = join(resolve(sessionDir), "quality");
  await mkdir(qualityDir, { recursive: true });
  const verdict = {
    version: 1,
    pass: scan.suggestPass,
    draft: true,
    source: "quality-scan.mjs",
    issues: [...scan.hardIssues, ...scan.softIssues],
    checkedAt: scan.checkedAt,
    notes: scan.suggestPass
      ? "机械扫描未发现 hard 级数据不可追溯问题（含列 sum/avg 复算）；仍需 Report Reviewer 做深度/矛盾审核后给出最终 pass。"
      : "机械扫描发现 hard 级不可追溯数字（无法用行级 data 或列汇总复算）；最终 pass 必须为 false。编造/模拟业务列应 fail 并建议 Editor 删除或补取数。",
  };
  const path = join(qualityDir, "verdict.draft.json");
  await writeFile(path, `${JSON.stringify(verdict, null, 2)}\n`);
  return { verdict, path };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    process.stderr.write("usage: quality-scan.mjs --result <result.json> | --session-dir <dir>\n");
    process.exit(2);
  }
  try {
    const { scan, scanPath } = await runQualityScan(sessionDir);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          scanPath,
          suggestPass: scan.suggestPass,
          hardIssues: scan.hardIssues.length,
          softIssues: scan.softIssues.length,
          unmatched: scan.report.unmatchedCount,
          matched: scan.report.matchedCount,
        },
        null,
        2
      )}\n`
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
