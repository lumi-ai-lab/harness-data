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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => actual[index] === expected[index]);
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

/** Unsigned decimal half-up. Operates on digit strings, not IEEE-754. */
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

export function evidenceAllowsCaptionNumber(token, numbers) {
  if (numbers.has(token)) return true;
  const decimals = tokenDecimalPlaces(token);
  if (decimals < 1) return false;
  const unsigned = tokenUnsigned(token);
  for (const allowed of numbers) {
    const rounded = roundHalfUpUnsigned(tokenUnsigned(allowed), decimals);
    if (rounded === unsigned) return true;
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

const DATE_TOKEN = /\d{4}-\d{2}-\d{2}/g;
const THOUSANDS_NUMBER = /(?<![A-Za-z0-9_.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![A-Za-z0-9_.])/g;
const NUMBER_TOKEN = /(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?![A-Za-z0-9_.])/g;

export function extractCaptionTokens(text) {
  const source = String(text || "");
  const dates = source.match(DATE_TOKEN) || [];
  const withoutDates = source.replace(DATE_TOKEN, " ");
  const withoutThousands = withoutDates.replace(THOUSANDS_NUMBER, (token) => token.replace(/,/g, ""));
  const numbers = withoutThousands.match(NUMBER_TOKEN) || [];
  return { dates, numbers };
}

function normalizeParagraphs(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("paragraphs must be a non-empty array");
  }
  if (value.length > CAPTION_MAX_PARAGRAPHS) {
    throw new Error(`paragraphs must contain at most ${CAPTION_MAX_PARAGRAPHS} items`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`paragraphs[${index}] must be a non-empty string`);
    }
    const paragraph = item.trim();
    if ([...paragraph].length > CAPTION_MAX_PARAGRAPH_CHARS) {
      throw new Error(`paragraphs[${index}] exceeds ${CAPTION_MAX_PARAGRAPH_CHARS} characters`);
    }
    return paragraph;
  });
}

function normalizePointers(value, maxPointers) {
  if (!Array.isArray(value)) throw new Error("pointers must be an array");
  if (value.length > maxPointers) {
    throw new Error(`pointers must contain at most ${maxPointers} items`);
  }
  const pointers = value.map((item, index) => {
    const pointer = canonicalizeCaptionPointer(item);
    if (typeof item !== "string" || !CAPTION_POINTER_PATTERN.test(pointer)) {
      throw new Error(`pointers[${index}] must be a /views/... JSON pointer`);
    }
    return pointer;
  });
  if (new Set(pointers).size !== pointers.length) throw new Error("pointers must be unique");
  return pointers;
}

export function renderCaptionMarkdown(paragraphs) {
  return `${paragraphs.join("\n\n")}\n`;
}

export function validateCaptionSubmission(input, evidence) {
  if (!exactKeys(input, ["paragraphs", "pointers"])) {
    throw new Error("submit_card_caption accepts only paragraphs and pointers");
  }
  if (!isPlainObject(evidence) || evidence.producer !== "prepare-card-caption-evidence.mjs") {
    throw new Error("caption evidence is missing or has the wrong producer");
  }
  if (!isPlainObject(evidence.views)) throw new Error("caption evidence views must be an object");
  const paragraphs = normalizeParagraphs(input.paragraphs);
  const pointers = normalizePointers(input.pointers, captionPointerBudget(evidence));
  for (const pointer of pointers) resolveJsonPointer(evidence, pointer);
  const numbers = new Set();
  const strings = new Set();
  collectQueryTimeDates(evidence, strings);
  collectEvidenceRowCount(evidence, numbers);
  collectAllowedCaptionNumbers(evidence.views, numbers);
  collectStringValues(evidence.views, strings);
  const prose = paragraphs.join("\n");
  const tokens = extractCaptionTokens(prose);
  for (const date of tokens.dates) {
    if (!strings.has(date)) {
      throw new Error(`caption rejected: date ${date} is not present in the evidence packet or query.time`);
    }
  }
  for (const number of tokens.numbers) {
    if (!evidenceAllowsCaptionNumber(number, numbers)) {
      throw new Error(`caption rejected: number ${number} is not present in the evidence packet`);
    }
  }
  return {
    paragraphs,
    pointers,
    markdown: renderCaptionMarkdown(paragraphs),
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

export async function writeCardCaption({ input, evidencePath, captionPath }) {
  const evidence = await loadCaptionEvidence(evidencePath);
  const submitted = validateCaptionSubmission(input, evidence);
  await atomicWrite(captionPath, submitted.markdown);
  return submitted;
}
