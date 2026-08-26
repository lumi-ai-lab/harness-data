/**
 * Validate a Writer caption submission against persisted compact evidence
 * and write caption.md. The model only supplies paragraphs and pointers.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CAPTION_POINTER_PATTERN = /^\/views\/[^/].*$/;
export const CAPTION_MAX_PARAGRAPHS = 8;
export const CAPTION_MAX_PARAGRAPH_CHARS = 500;

export function captionPointerBudget(evidence) {
  const views = evidence?.views;
  if (!isPlainObject(views)) return 0;
  return Object.keys(views).length;
}

/** `/evidence/views/...` is the ack wrapper path of the same `/views/...` node. */
export function canonicalizeCaptionPointer(pointer) {
  const raw = String(pointer || "");
  return raw.startsWith("/evidence/views/") ? raw.slice("/evidence".length) : raw;
}

/**
 * Fold a caption pointer to its view. Cell paths are the same citation unit:
 * `/views/foo/rows/0/metricValue` → `/views/foo`.
 */
export function captionViewPointer(pointer) {
  const canonical = canonicalizeCaptionPointer(pointer);
  const match = /^\/views\/([^/]+)/.exec(canonical);
  return match ? `/views/${match[1]}` : canonical;
}

/** Parse a real array or a JSON-encoded array string (`"[\"a\"]"`). */
export function parseJsonArrayField(value) {
  if (Array.isArray(value)) return { ok: true, value };
  if (typeof value !== "string") return { ok: false, error: "must be an array" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: "must be an array" };
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return { ok: false, error: "must be an array" };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "must be an array" };
  }
}

export function defaultCaptionPointers(evidence) {
  const views = evidence?.views;
  if (!isPlainObject(views)) return [];
  return Object.keys(views).map((key) => `/views/${key}`);
}

/**
 * Coerce stringified arrays and fill omitted/empty pointers from evidence.views.
 * Does not write files.
 */
export function normalizeCaptionToolInput(input, evidence) {
  if (!isPlainObject(input)) {
    return { ok: false, error: "submit_card_caption accepts only paragraphs and optional pointers" };
  }
  const keys = Object.keys(input);
  if (!keys.includes("paragraphs") || keys.some((key) => key !== "paragraphs" && key !== "pointers")) {
    return { ok: false, error: "submit_card_caption accepts only paragraphs and optional pointers" };
  }
  const paragraphs = parseJsonArrayField(input.paragraphs);
  if (!paragraphs.ok) return { ok: false, error: "paragraphs must be an array" };
  let pointers = [];
  if (input.pointers !== undefined) {
    const parsed = parseJsonArrayField(input.pointers);
    if (!parsed.ok) return { ok: false, error: "pointers must be an array" };
    pointers = parsed.value;
  }
  if (pointers.length === 0) pointers = defaultCaptionPointers(evidence);
  return { ok: true, input: { paragraphs: paragraphs.value, pointers } };
}

/** Stub captions that only have dates / 半截句子 extract no data numbers. */
export function captionCitesDataNumber(paragraphs, evidence) {
  const columnLabels = isPlainObject(evidence?.columnLabels) ? evidence.columnLabels : {};
  const properNames = Object.values(columnLabels).filter(Boolean);
  const text = (Array.isArray(paragraphs) ? paragraphs : []).join("\n");
  return extractCaptionTokens(text, properNames).numbers.length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodePointerSegment(segment) {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveJsonPointer(document, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${pointer}`);
  }
  if (pointer === "/") throw new Error("JSON pointer must not be a bare slash");
  let current = document;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(raw);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        throw new Error(`JSON pointer ${pointer} does not resolve`);
      }
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`JSON pointer ${pointer} does not resolve`);
    }
    if (current === undefined) throw new Error(`JSON pointer ${pointer} does not resolve`);
  }
  return current;
}

// 判断是否是率字段：以 Rate 结尾或含"率"字，但排除"增长率"（增长率已在派生列里×100过）
function isRateField(name) {
  const field = String(name || "");
  if (!field || /增长率/.test(field)) return false;
  return /Rate$/i.test(field) || /率/.test(field);
}

function compactNumberString(value) {
  if (!Number.isFinite(value)) return "";
  if (Object.is(value, -0) || value === 0) return "0";
  return String(Number(value.toFixed(10)));
}

function addCompactNumber(n, into) {
  if (!Number.isFinite(n)) return;
  into.add(compactNumberString(n));
  if (n < 0) into.add(compactNumberString(Math.abs(n)));
}

/**
 * 把一个 evidence 数值加入允许集。同一格子允许 Writer 用以下形式写：
 *   ① 精确值：    2199.295
 *   ② 绝对值：    -0.82 → 也允许写 0.82（去负号）
 *   ③ 率×100：    profitLostRate=-0.0082 → 也允许写 0.82（百分比形式）
 *   ④ 万：        4484026 → 也允许写 448.4026（abs ≥ 10000）
 *   ⑤ 亿：        4484026 → 也允许写 0.04484026（abs ≥ 1亿）
 * field 用来判断是否是率字段（Rate 后缀或含"率"字，但排除"增长率"）。
 */
function addAllowedNumber(value, field, into) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return;
  addCompactNumber(n, into);
  if (isRateField(field) || /增长率/.test(String(field || ""))) {
    if (isRateField(field)) addCompactNumber(n * 100, into);
    return;
  }
  const abs = Math.abs(n);
  if (abs >= 10_000) addCompactNumber(n / 10_000, into);
  if (abs >= 100_000_000) addCompactNumber(n / 100_000_000, into);
}

/** Collect exact values plus abs(), Rate×100, and 万/亿 display forms from cited nodes. */
export function collectAllowedCaptionNumbers(value, into = new Set(), field = "", metricHint = "") {
  if (typeof value === "number" && Number.isFinite(value)) {
    addAllowedNumber(value, field, into);
    return into;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) addAllowedNumber(Number(trimmed), field, into);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAllowedCaptionNumbers(item, into, field, metricHint);
    return into;
  }
  if (isPlainObject(value)) {
    const hint = typeof value.metric === "string" && value.metric.trim() ? value.metric : metricHint;
    for (const [key, item] of Object.entries(value)) {
      const nextField = key === "metricValue" && hint ? hint : key;
      collectAllowedCaptionNumbers(item, into, nextField, hint);
    }
  }
  return into;
}

export function collectNumberStrings(value, into = new Set()) {
  return collectAllowedCaptionNumbers(value, into);
}

export function collectEvidenceRowCount(evidence, into = new Set()) {
  const n = evidence?.rowCount;
  if (Number.isSafeInteger(n) && n >= 0) into.add(String(n));
  return into;
}

export function collectQueryTimeDates(evidence, into = new Set()) {
  const time = evidence?.query?.time;
  if (!time || typeof time !== "object" || Array.isArray(time)) return into;
  for (const key of ["startDate", "endDate"]) {
    const value = time[key];
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) into.add(value);
  }
  return into;
}

/**
 * 把 query.time 里的年/月/日数值加入允许集。
 * Writer 可能用任意自然语言格式写日期（"10日"、"10号"、"8/10"…），
 * 正则无法兜住所有写法。把这些小整数提前放入白名单，
 * 即使日期未被剥离也不会被误杀。
 */
export function collectQueryTimeDateComponents(evidence, into = new Set()) {
  const time = evidence?.query?.time;
  if (!time || typeof time !== "object" || Array.isArray(time)) return into;
  for (const key of ["startDate", "endDate"]) {
    const value = time[key];
    if (typeof value !== "string") continue;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) continue;
    const [, year, month, day] = match;
    into.add(year);                      // "2026"
    into.add(month);                     // "08"
    into.add(String(Number(month)));     // "8"
    into.add(day);                       // "10"
    into.add(String(Number(day)));       // "10" (去前导零)
  }
  return into;
}

function tokenDecimalPlaces(token) {
  const abs = String(token).replace(/^-/, "");
  const dot = abs.indexOf(".");
  return dot < 0 ? 0 : abs.length - dot - 1;
}

function tokenUnsigned(token) {
  return String(token).replace(/^-/, "");
}

function incrementDigitString(digits) {
  const chars = [...digits];
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (chars[i] !== "9") {
      chars[i] = String(Number(chars[i]) + 1);
      return chars.join("");
    }
    chars[i] = "0";
  }
  return `1${chars.join("")}`;
}

/**
 * 无符号十进制四舍五入（half-up）。用 digit 字符串运算，不用 IEEE-754 浮点。
 * 避免 JS 的 Number.toFixed 银行家舍入问题（如 2.5.toFixed(0) → "2" 而非 "3"）。
 * 例：roundHalfUpUnsigned("2199.295", 2) → "2199.30"
 */
export function roundHalfUpUnsigned(abs, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (!/^\d+(?:\.\d+)?$/.test(abs)) return null;
  const [intRaw, fracRaw = ""] = abs.split(".");
  const intDigits = intRaw.replace(/^0+(?=\d)/, "") || "0";
  if (fracRaw.length <= decimals) {
    const frac = fracRaw.padEnd(decimals, "0");
    return decimals === 0 ? intDigits : `${intDigits}.${frac}`;
  }
  const keep = fracRaw.slice(0, decimals);
  const shouldBump = fracRaw[decimals] >= "5";
  if (!shouldBump) {
    return decimals === 0 ? intDigits : `${intDigits}.${keep}`;
  }
  const whole = `${intDigits}${keep}`.replace(/^0+(?=\d)/, "") || "0";
  const bumped = incrementDigitString(whole);
  if (decimals === 0) return bumped;
  const padded = bumped.padStart(decimals + 1, "0");
  const split = padded.length - decimals;
  return `${padded.slice(0, split)}.${padded.slice(split)}`;
}

/**
 * 无符号十进制截断（向零取整，不进位）。用 digit 字符串运算。
 * 例：truncUnsigned("2199.295", 2) → "2199.29"（直接砍末位，不四舍五入）
 * 用于容忍 Writer LLM 截断小数的行为。
 */
export function truncUnsigned(abs, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (!/^\d+(?:\.\d+)?$/.test(abs)) return null;
  const [intRaw, fracRaw = ""] = abs.split(".");
  const intDigits = intRaw.replace(/^0+(?=\d)/, "") || "0";
  if (decimals === 0) return intDigits;
  if (fracRaw.length <= decimals) {
    return `${intDigits}.${fracRaw.padEnd(decimals, "0")}`;
  }
  return `${intDigits}.${fracRaw.slice(0, decimals)}`;
}

/** 取数字字符串的整数部分（去符号、去小数）。 */
function integerPartOf(token) {
  const unsigned = String(token).replace(/^-/, "");
  const dot = unsigned.indexOf(".");
  return dot < 0 ? unsigned : unsigned.slice(0, dot);
}

/**
 * 校验 caption 里的一个数字是否在 evidence 允许集里。
 * 规则：精确匹配 或 整数部分一致即放行。
 *   ① 精确匹配：  evidence 有 "4464.4"，caption 写 "4464.4" → ✅
 *   ② 整数一致：  evidence 有 "4464.4"，caption 写 "4464.3968" → 整数 4464 == 4464 → ✅
 * 完全不同的整数（如 "5000" vs "4464"）仍被拒绝。
 * 这覆盖了之前四舍五入、截断、转录误差等场景，规则更宽更简单。
 */
export function evidenceAllowsCaptionNumber(token, numbers) {
  if (numbers.has(token)) return true;
  const tokenInt = integerPartOf(token);
  if (!tokenInt) return false;
  for (const allowed of numbers) {
    if (integerPartOf(allowed) === tokenInt) return true;
  }
  return false;
}

export function collectStringValues(value, into = new Set()) {
  if (typeof value === "string" && value.trim()) {
    into.add(value.trim());
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, into);
    return into;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectStringValues(item, into);
  }
  return into;
}

// ── 抠除规则（在提取数字前，先从 caption 文本里抠掉不该当数字检查的内容）──
// 顺序：ISO日期 → 中文日期 → 缩写MM-DD日期 → 中文专名 → 千分位 → 剩余才是数据数字

// ① 完整 ISO 日期：2026-08-01。抠掉后加入 dates[]，校验是否在 query.time 里
const DATE_TOKEN = /\d{4}-\d{2}-\d{2}/g;
// ② 中文日期：2026年8月1日、8月10日。只抠不校验（不做 query.time 匹配）
const CHINESE_DATE_TOKEN = /\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/g;
// ③ 缩写 MM-DD 日期：08-10（Writer 写 "2026-08-01 至 08-10" 时第二个日期省略年份）
//    前后不能跟数字，避免误匹配 1008-10 或 08-100 的一部分
const ABBREVIATED_DATE_TOKEN = /(?<!\d)\d{1,2}-\d{1,2}(?!\d)/g;
// ④ 千分位数字：4,484,026。抠掉逗号后变成 4484026，再走 NUMBER_TOKEN
const THOUSANDS_NUMBER = /(?<![A-Za-z0-9_.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![A-Za-z0-9_.])/g;
// ⑤ 数据数字：剩余文本里的独立数字（前后不能是字母/数字/点/下划线）
const NUMBER_TOKEN = /(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?![A-Za-z0-9_.])/g;

export function extractCaptionTokens(text, properNames = []) {
  const source = String(text || "");
  // ① 提取完整 ISO 日期（加入 dates[]，后续校验是否在 query.time 里）
  const dates = source.match(DATE_TOKEN) || [];
  let stripped = source.replace(DATE_TOKEN, " ");
  // ② 抠掉中文日期（只抠不校验，不做 query.time 匹配）
  stripped = stripped.replace(CHINESE_DATE_TOKEN, " ");
  // ③ 抠掉缩写 MM-DD 日期（Writer 写 "2026-08-01 至 08-10" 时第二个日期省略年份）
  //    不加入 dates[]，只防 "08" 被当数据数字提取
  stripped = stripped.replace(ABBREVIATED_DATE_TOKEN, " ");
  // ④ 抠掉中文专名（如 "19点前客数"），防 "19" 被当数据数字提取
  //    最长名优先，避免短名部分遮蔽长名
  const sortedNames = [...properNames]
    .filter((name) => typeof name === "string" && name.trim())
    .sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    stripped = stripped.split(name).join(" ");
  }
  // ⑤ 千分位去逗号：4,484,026 → 4484026，然后统一走 NUMBER_TOKEN
  const withoutThousands = stripped.replace(THOUSANDS_NUMBER, (token) => token.replace(/,/g, ""));
  // ⑥ 提取剩余的数据数字（前后不能是字母/数字/点/下划线）
  const numbers = withoutThousands.match(NUMBER_TOKEN) || [];
  return { dates, numbers };
}

/** Empty string means paragraphs are within count/length limits. */
export function captionParagraphLimitError(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return "paragraphs must be a non-empty array";
  }
  if (value.length > CAPTION_MAX_PARAGRAPHS) {
    return `paragraphs must contain at most ${CAPTION_MAX_PARAGRAPHS} items`;
  }
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (typeof item !== "string" || !item.trim()) {
      return `paragraphs[${index}] must be a non-empty string`;
    }
    if ([...item.trim()].length > CAPTION_MAX_PARAGRAPH_CHARS) {
      return `paragraphs[${index}] exceeds ${CAPTION_MAX_PARAGRAPH_CHARS} characters`;
    }
  }
  return "";
}

function normalizeParagraphs(value) {
  const error = captionParagraphLimitError(value);
  if (error) throw new Error(error);
  return value.map((item) => item.trim());
}

export function renderCaptionMarkdown(paragraphs) {
  return `${paragraphs.join("\n\n")}\n`;
}

/** Parse caption.md back into paragraphs (reverse of renderCaptionMarkdown). */
export function parseCaptionMarkdown(markdown) {
  const text = String(markdown || "").replace(/\n$/, "");
  if (!text.trim()) return [];
  return text.split("\n\n").map((p) => p.trim()).filter(Boolean);
}

function findParagraphIndex(paragraphs, token) {
  const needle = String(token);
  for (let i = 0; i < paragraphs.length; i++) {
    if (paragraphs[i].includes(needle)) return i;
  }
  return -1;
}

function snippetAround(paragraph, token, radius = 30) {
  const idx = paragraph.indexOf(String(token));
  if (idx < 0) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(paragraph.length, idx + String(token).length + radius);
  let snippet = paragraph.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < paragraph.length) snippet += "…";
  return snippet;
}

function buildViolation(rule, ruleName, description, trigger, paragraphIndex, paragraphs) {
  return {
    rule,
    ruleName,
    description,
    trigger: String(trigger),
    paragraphIndex,
    paragraphSnippet: paragraphIndex >= 0 && paragraphs[paragraphIndex]
      ? snippetAround(paragraphs[paragraphIndex], trigger)
      : "",
  };
}

/**
 * 非抛出式详细校验。返回 { violations, paragraphs, pointers, markdown }。
 * - 基础设施错误（input shape、evidence producer、views 缺失）→ 仍然 throw
 * - 段落格式错误 → 仍然 throw（无法写 caption.md）
 * - 指针/日期/数字校验 → 收集 violations，不 throw
 */
export function validateCaptionSubmissionDetailed(input, evidence) {
  const normalized = normalizeCaptionToolInput(input, evidence);
  if (!normalized.ok) throw new Error(normalized.error);
  if (!isPlainObject(evidence) || evidence.producer !== "prepare-card-caption-evidence.mjs") {
    throw new Error("caption evidence is missing or has the wrong producer");
  }
  if (!isPlainObject(evidence.views)) throw new Error("caption evidence views must be an object");
  const paragraphs = normalizeParagraphs(normalized.input.paragraphs);
  const violations = [];

  // ── 指针校验（收集 violations，不 throw）──
  // Citation unit is the view. Resolve the original (cell) path, then fold and
  // silently dedupe so many row pointers in one view count as one.
  const maxPointers = captionPointerBudget(evidence);
  const rawPointers = Array.isArray(normalized.input.pointers) ? normalized.input.pointers : [];
  const pointers = [];
  const seen = new Set();
  for (let i = 0; i < rawPointers.length; i++) {
    const item = rawPointers[i];
    const pointer = canonicalizeCaptionPointer(item);
    if (typeof item !== "string" || !CAPTION_POINTER_PATTERN.test(pointer)) {
      violations.push(buildViolation(
        "POINTER_FORMAT", "引用路径格式错误",
        `pointers[${i}] must be a /views/... JSON pointer`,
        String(item), -1, paragraphs,
      ));
      continue;
    }
    try {
      resolveJsonPointer(evidence, pointer);
    } catch {
      violations.push(buildViolation(
        "POINTER_UNRESOLVED", "引用路径无法解析",
        `pointers[${i}] 在 evidence.views 中不存在`,
        pointer, -1, paragraphs,
      ));
      continue;
    }
    const folded = captionViewPointer(pointer);
    if (seen.has(folded)) continue;
    seen.add(folded);
    pointers.push(folded);
  }
  if (seen.size > maxPointers && maxPointers > 0) {
    violations.push(buildViolation(
      "POINTER_BUDGET_EXCEEDED", "引用数量超限",
      `pointers must contain at most ${maxPointers} items`,
      `${seen.size}`, -1, paragraphs,
    ));
  }

  // ── 构建允许集 ──
  const numbers = new Set();
  const strings = new Set();
  collectQueryTimeDates(evidence, strings);
  collectQueryTimeDateComponents(evidence, numbers);
  collectEvidenceRowCount(evidence, numbers);
  collectAllowedCaptionNumbers(evidence.views, numbers);
  collectStringValues(evidence.views, strings);
  const columnLabels = isPlainObject(evidence.columnLabels) ? evidence.columnLabels : {};
  const properNames = Object.values(columnLabels).filter(Boolean);

  // ── 从 caption 提取 token ──
  const prose = paragraphs.join("\n");
  const tokens = extractCaptionTokens(prose, properNames);

  // ── 校验日期（收集 violations）──
  for (const date of tokens.dates) {
    if (!strings.has(date)) {
      const idx = findParagraphIndex(paragraphs, date);
      violations.push(buildViolation(
        "DATE_NOT_IN_EVIDENCE", "日期不在 evidence 中",
        `caption 中的日期 ${date} 不在 evidence 或 query.time 中`,
        date, idx, paragraphs,
      ));
    }
  }

  // ── 校验数字（收集 violations）──
  for (const number of tokens.numbers) {
    if (!evidenceAllowsCaptionNumber(number, numbers)) {
      const idx = findParagraphIndex(paragraphs, number);
      violations.push(buildViolation(
        "NUMBER_NOT_IN_EVIDENCE", "数字不在允许集",
        `caption 中的数字 ${number} 不在 evidence 允许集中（精确匹配或整数部分一致）`,
        number, idx, paragraphs,
      ));
    }
  }

  return {
    violations,
    paragraphs,
    pointers,
    markdown: renderCaptionMarkdown(paragraphs),
  };
}

export function validateCaptionSubmission(input, evidence) {
  const result = validateCaptionSubmissionDetailed(input, evidence);
  if (result.violations.length > 0) {
    const first = result.violations[0];
    let msg;
    switch (first.rule) {
      case "POINTER_BUDGET_EXCEEDED":
        msg = first.description;
        break;
      case "POINTER_FORMAT":
        msg = first.description;
        break;
      case "POINTER_DUPLICATE":
        msg = "pointers must be unique";
        break;
      case "POINTER_UNRESOLVED":
        msg = `JSON pointer ${first.trigger} does not resolve`;
        break;
      case "DATE_NOT_IN_EVIDENCE":
        msg = `caption rejected: date ${first.trigger} is not present in the evidence packet or query.time`;
        break;
      case "NUMBER_NOT_IN_EVIDENCE":
        msg = `caption rejected: number ${first.trigger} is not present in the evidence packet`;
        break;
      default:
        msg = `caption rejected: ${first.ruleName}`;
    }
    throw new Error(msg);
  }
  return {
    paragraphs: result.paragraphs,
    pointers: result.pointers,
    markdown: result.markdown,
  };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function loadCaptionEvidence(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`caption evidence is missing: ${path}`);
    throw new Error(`cannot read caption evidence: ${error.message || error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`caption evidence must contain valid JSON: ${error.message || error}`);
  }
}

/** Derive the violations file path from a caption.md path. */
export function violationsPathFor(captionPath) {
  return `${String(captionPath || "").replace(/\.md$/, "")}.md.violations.json`;
}

export async function writeCardCaption({ input, evidencePath, captionPath }) {
  const evidence = await loadCaptionEvidence(evidencePath);
  const submitted = validateCaptionSubmissionDetailed(input, evidence);
  await atomicWrite(captionPath, submitted.markdown);
  const violationsPath = violationsPathFor(captionPath);
  if (submitted.violations.length > 0) {
    await atomicWrite(violationsPath, `${JSON.stringify({
      producer: "submit-card-caption.mjs",
      cardId: evidence.cardId || null,
      captionPath,
      violations: submitted.violations,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } else {
    await atomicWrite(violationsPath, `${JSON.stringify({
      producer: "submit-card-caption.mjs",
      cardId: evidence.cardId || null,
      captionPath,
      violations: [],
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }
  return submitted;
}

/** Re-validate a caption.md file against its evidence (for caption-gate --revalidate). */
export function revalidateCaptionMarkdown(markdown, evidence) {
  const paragraphs = parseCaptionMarkdown(markdown);
  if (!paragraphs.length) {
    return {
      violations: [{
        rule: "PARAGRAPH_EMPTY",
        ruleName: "段落为空",
        description: "caption.md 解析后没有有效段落",
        trigger: "",
        paragraphIndex: -1,
        paragraphSnippet: "",
      }],
      paragraphs: [],
      pointers: [],
      markdown,
    };
  }
  return validateCaptionSubmissionDetailed({ paragraphs, pointers: [] }, evidence);
}
