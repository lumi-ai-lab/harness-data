/**
 * STUB — B2.5 Editor Planner contract.
 *
 * This file is a placeholder for Issue #37 (B0_PREFLIGHT). It exports only the
 * symbols imported by gate-control.mjs. The full implementation (1407 lines)
 * will be ported from the reference workspace when Issue #39 (B3_RESEARCH) is
 * implemented.
 *
 * Reference: /Users/pengmd/c/qdm/harenss-data-github-ppt-master/.agents/pi/skills/html-report/scripts/editor-plan-contract.mjs
 */

export const EDITOR_PLANNER_MARKER = "HTML_REPORT_EDITOR_PLAN_V1";
export const EDITOR_PLAN_VERSION = 1;
export const EDITOR_PLAN_INPUT_VERSION = 1;
export const EDITOR_PLANNER_CACHE_VERSION = 1;
export const EDITOR_PLANNER_CACHE_PRODUCER = "editor-plan-contract.mjs";

// Additional exports needed by tests and gate-control.mjs
export function buildEditorPlanSchema() { return { type: "object", properties: {} }; }
export function editorPlannerExpectedFromAssignment() { return null; }
export function isEditorPlannerAssignment() { return false; }
export function normalizeEditorPlan() { return null; }
export function persistEditorWriterReturn() { return null; }
export function persistEditorSourceInventory() { return null; }
export function validateEditorPlan() { return { ok: true, errors: [] }; }
