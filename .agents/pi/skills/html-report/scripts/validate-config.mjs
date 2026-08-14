#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeCardId } from "./writer-return.mjs";
import { collectRecommendationContractErrors } from "./recommendation-contract.mjs";

/** Same notion as HTML confirmEmptyFiltersGate: dim + at least one value. */
export function hasEffectiveFilter(filter) {
  if (!filter || typeof filter !== "object") return false;
  const dim = String(filter.dimUniqueCode || filter.dim_unique_code || "").trim();
  if (!dim) return false;
  const values = filter.values || filter.dimFieldIdList || filter.dim_field_id_list || [];
  if (!Array.isArray(values)) return false;
  return values.some((v) => String(v ?? "").trim() !== "");
}

export function cardHasEffectiveFilters(card) {
  return (card?.filters || []).some(hasEffectiveFilter);
}

/**
 * Soft scope checks only — never errors for empty filters.
 * Full-scope queries are legitimate; Agent/HTML should still notice.
 */
export function collectFilterWarnings(data) {
  const warnings = [];
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  if (!cards.length) return warnings;
  const missing = cards.filter((c) => !cardHasEffectiveFilters(c));
  if (missing.length === cards.length) {
    warnings.push(
      "all cards have no effective filters; query may cover full store/region/category scope (add cards[].filters when the user named a store/region/category, or keep empty only if full-scope is intentional)"
    );
  } else if (missing.length > 0) {
    const labels = missing.map((c) => c.title || c.id || "card").join(", ");
    warnings.push(
      `some cards have no effective filters (${labels}); those cards may query full scope`
    );
  }
  return warnings;
}

/** Inclusive calendar-day count between YYYY-MM-DD strings; NaN if invalid. */
export function inclusiveDaySpan(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "")) return NaN;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return NaN;
  return Math.floor((end - start) / 86400000) + 1;
}

/** Max inclusive days per card (≈ one month). */
export const MAX_CARD_DATE_SPAN_DAYS = 31;

export function validateShape(data) {
  const errors = [];
  if (data.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(data.cards) || data.cards.length === 0) errors.push("cards must not be empty");
  const ids = new Set();
  const filesystemIds = new Map();
  for (const [i, card] of (data.cards || []).entries()) {
    const label = card.title || `card ${i + 1}`;
    if (!card.id || ids.has(card.id)) errors.push(`${label}: missing or duplicate id`);
    ids.add(card.id);
    if (card.id) {
      try {
        const safeId = sanitizeCardId(card.id);
        if (typeof card.id !== "string" || card.id !== safeId) {
          errors.push(`${label}: unsafe id (use only A-Z, a-z, 0-9, dot, underscore, or hyphen)`);
        }
        if (filesystemIds.has(safeId)) {
          errors.push(`${label}: id collides after filesystem sanitization with ${filesystemIds.get(safeId)}`);
        } else {
          filesystemIds.set(safeId, card.id);
        }
      } catch (error) {
        errors.push(`${label}: unsafe id (${error.message || error})`);
      }
    }
    if (!Array.isArray(card.indicatorFieldList) || !card.indicatorFieldList.length) errors.push(`${label}: indicators are empty`);
    if (!Array.isArray(card.aggDimUniqueCodeList) || !card.aggDimUniqueCodeList.length) errors.push(`${label}: row dimensions are empty`);
    if (!String(card.analysisFocus || card.analysis_focus || "").trim()) {
      errors.push(`${label}: analysisFocus must not be empty (needed for Phase B chapter writing)`);
    }
    if (card.chartType !== "table") errors.push(`${label}: chartType must be table`);
    if (![1, 2].includes(Number(card.storeCollectType))) errors.push(`${label}: invalid storeCollectType`);
    for (const key of ["startDate", "endDate"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(card[key] || "") || Number.isNaN(Date.parse(card[key]))) errors.push(`${label}: invalid ${key}`);
    if (card.startDate && card.endDate && card.startDate > card.endDate) errors.push(`${label}: startDate is after endDate`);
    const span = inclusiveDaySpan(card.startDate, card.endDate);
    if (Number.isFinite(span) && span > MAX_CARD_DATE_SPAN_DAYS) {
      errors.push(
        `${label}: date range spans ${span} days (max ${MAX_CARD_DATE_SPAN_DAYS} inclusive); truncate to ≤1 month`
      );
    }
    const dims = [...(card.aggDimUniqueCodeList || []), ...(card.columnAggDimUniqueCodeList || [])];
    if (new Set(dims).size !== dims.length) errors.push(`${label}: duplicate dimensions`);
  }
  return errors;
}

let refreshed = false;
function cliJson(cli, argv) {
  let out = spawnSync(cli, argv, { encoding: "utf8", env: process.env });
  const message = () => (out.stderr || out.stdout || out.error?.message || "CLI execution failed").trim();
  if (out.status !== 0 && !refreshed && /token|认证|401|403|460|expired/i.test(message())) {
    refreshed = true;
    const root = resolve(new URL("../../../../../", import.meta.url).pathname);
    const cas = process.env.QDM_CAS_CLI || join(root, "bin/cas-cli");
    const auth = spawnSync(cas, ["token", "--app", "indicators", "--timeout", "20s"], { encoding: "utf8", timeout: 25000 });
    if (auth.status === 0 && auth.stdout.trim()) {
      process.env.QDM_INDICATORS_TOKEN = auth.stdout.trim();
      out = spawnSync(cli, argv, { encoding: "utf8", env: process.env });
    }
  }
  if (out.error) throw new Error(message());
  if (out.status !== 0) throw new Error(message());
  return JSON.parse(out.stdout);
}

export function validateMetadata(data, cli) {
  const errors = [];
  for (const card of data.cards || []) {
    const indicators = card.indicatorFieldList.map((code) => {
      const rows = cliJson(cli, ["indicator", "search", "--keyword", code, "--full"]);
      const list = Array.isArray(rows) ? rows : (rows.data || []);
      const exact = list.find((x) => x.indicatorsCodeEn === code);
      if (!exact) errors.push(`${card.title}: unknown indicator ${code}`);
      return exact;
    }).filter(Boolean);
    const dims = [...card.aggDimUniqueCodeList, ...(card.columnAggDimUniqueCodeList || [])];
    for (const code of dims) {
      const rows = cliJson(cli, ["dim", "search", "--keyword", code, "--full"]);
      const list = Array.isArray(rows) ? rows : (rows.data || []);
      if (!list.find((x) => x.dimUniqueCode === code)) errors.push(`${card.title}: unknown dimension ${code}`);
      if (indicators.some((x) => Array.isArray(x.supportDim) && !x.supportDim.includes(code))) errors.push(`${card.title}: dimension ${code} is not supported by every indicator`);
    }
    const bizIds = new Set(indicators.map((x) => String(x.bizId ?? x.indicatorBizId ?? "")).filter(Boolean));
    if (bizIds.size > 1 || (card.indicatorBizId && bizIds.size && !bizIds.has(String(card.indicatorBizId)))) errors.push(`${card.title}: incompatible indicator business groups`);
    const payload = {
      filterDimUniqueCodeList: (card.filters || []).filter((x) => x.dimUniqueCode).map((x) => ({ type: x.type || "DIMENSION", dimUniqueCode: x.dimUniqueCode, dimFieldIdList: x.values || x.dimFieldIdList || [] })),
      aggDimUniqueCodeList: card.aggDimUniqueCodeList,
      indicatorFieldList: card.indicatorFieldList,
      columnAggDimUniqueCodeList: card.columnAggDimUniqueCodeList || [],
      startDate: card.startDate,
      endDate: card.endDate,
      indicatorsGroup: 1,
      storeCollectType: Number(card.storeCollectType),
      currPage: 1,
      pageSize: 20,
      chartType: "table",
      compareDate: [],
    };
    try { cliJson(cli, ["analysis", "preview", "--payload-json", JSON.stringify(payload)]); }
    catch (error) { errors.push(`${card.title}: incompatible parameters: ${error.message}`); }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("config path is required");
  const data = JSON.parse(await readFile(file, "utf8"));
  const root = resolve(new URL("../../../../../", import.meta.url).pathname);
  const errors = [...validateShape(data), ...collectRecommendationContractErrors(data)];
  const warnings = collectFilterWarnings(data);
  if (!errors.length && process.env.HTML_REPORT_SKIP_METADATA !== "1") {
    errors.push(...validateMetadata(data, join(root, "bin/qdm-indicators-cli")));
  }
  for (const w of warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }
  if (errors.length) {
    process.stderr.write(errors.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(
    `valid: ${data.cards.length} card(s)${warnings.length ? ` (${warnings.length} warning(s))` : ""}\n`
  );
}
