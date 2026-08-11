/**
 * STUB — Report Reviewer return contract.
 *
 * This file is a placeholder for Issue #37 (B0_PREFLIGHT). It exports only the
 * symbols imported by tests. The full implementation will be ported when Issue
 * #40 (B4_REVIEW) is implemented.
 *
 * Reference: /Users/pengmd/c/qdm/harenss-data-github-ppt-master/.agents/pi/skills/html-report/scripts/reviewer-return.mjs
 */

export function reviewerReturnPaths() {
  return { reportPath: "", verdictPath: "", scanPath: "" };
}

export function buildReviewerReturnSchema() {
  return { type: "object", properties: {} };
}

export function reviewerExpectedFromAssignment() {
  return null;
}

export function validateReviewerArtifacts() {
  return { ok: true, errors: [], warnings: [] };
}
