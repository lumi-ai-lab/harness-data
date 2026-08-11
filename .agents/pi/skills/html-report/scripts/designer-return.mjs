/**
 * STUB — Report Designer return contract.
 *
 * This file is a placeholder for Issue #37 (B0_PREFLIGHT). The full
 * implementation will be ported when Issue #41 (B5_DESIGN) is implemented.
 *
 * Reference: /Users/pengmd/c/qdm/harenss-data-github-ppt-master/.agents/pi/skills/html-report/scripts/designer-return.mjs
 */

export function designerReturnPaths() {
  return { htmlPath: "", contentPath: "", designPath: "" };
}

export function buildDesignerReturnSchema() {
  return { type: "object", properties: {} };
}

export function designerExpectedFromAssignment() {
  return null;
}

export function validateDesignerArtifacts() {
  return { ok: true, errors: [], warnings: [] };
}
