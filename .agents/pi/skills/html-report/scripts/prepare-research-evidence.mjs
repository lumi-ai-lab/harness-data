/**
 * STUB — Prepare compact evidence for B3 Researcher tasks.
 *
 * This file is a placeholder for Issue #37 (B0_PREFLIGHT). It exports only the
 * symbols imported by check-session-layout.mjs. The full implementation (1877
 * lines) will be ported from the reference workspace when Issue #39
 * (B3_RESEARCH) is implemented.
 *
 * Reference: /Users/pengmd/c/qdm/harenss-data-github-ppt-master/.agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs
 */

/**
 * Build source field metadata for a card's entry.json.
 * Full implementation reads entry.json + entry.meta.json and returns compact
 * source inventory with availableFields, rowCount, rowsSha256.
 * Stub returns null — only called by check-session-layout phases b2/explore/quality/html.
 */
export async function buildSourceFieldMetadata() {
  return null;
}

/**
 * Canonicalize a JSON value for deterministic hashing.
 * Full implementation sorts keys and normalizes values.
 */
export function canonicalizeJson(value) {
  return JSON.stringify(value);
}

/**
 * Build a compact decision query scope from a result.json card.
 * Full implementation extracts indicator/dim/date/filter scope.
 */
export function compactDecisionQueryScope() {
  return null;
}

/**
 * Execute evidence operations (project, sort, groupBy, etc.) on entry rows.
 * Full implementation reads entry.json and produces compact evidence JSON.
 */
export async function executeEvidenceOperations() {
  return null;
}

// Additional exports needed by tests
export async function prepareResearchEvidence() {
  return { ok: true, evidencePath: "" };
}

export function rowsSha256(rows) {
  return canonicalizeJson(rows);
}
