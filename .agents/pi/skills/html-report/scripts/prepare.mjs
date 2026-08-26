#!/usr/bin/env node
/**
 * Prepare html-report recall state.
 * Uses data-harness-cli with --doc-set specs so contextFiles are Spec-only
 * (default CLI recall stays playbook-only for normal Q&A).
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((v, i, a) => (v.startsWith("--") ? [[v.slice(2), a[i + 1]]] : []))
);
if (!args.question) throw new Error("--question is required");

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const cli = join(root, "bin/data-harness-cli");
const result = spawnSync(
  cli,
  ["wikis", "recall-debug", "--question", args.question, "--json", "--doc-set", "specs"],
  { cwd: root, encoding: "utf8" }
);
if (result.status !== 0) {
  throw new Error((result.stderr || result.stdout || "recall-debug failed").trim());
}

const recall = JSON.parse(result.stdout);
const mode = recall.plan?.mode || "free";
const selectedSpecs = Array.isArray(recall.plan?.selectedSpecs) ? recall.plan.selectedSpecs : [];
const contextPaths = (recall.contextFiles || [])
  .map((x) => x.path)
  .filter((p) => typeof p === "string" && p.trim());

// Prefer physical contextFiles; fall back to logical selectedSpecs → wikis/…
const recalledSpecs = [
  ...contextPaths.filter((p) => /(?:^|\/)spec\.md$/.test(p) || /\/spec\//.test(p)),
  ...selectedSpecs.map((p) => (p.startsWith("wikis/") ? p : `wikis/${p}`)),
].filter((p, i, arr) => arr.indexOf(p) === i);
const specs = recalledSpecs.filter((p) => mode !== "free" || p !== "wikis/rules/qdm-metric-cli/spec.md");

// Audit-only: sibling playbooks derived from specs (not for Agent to execute).
const playbooks = specs
  .map((p) => p.replace(/\/spec\.md$/, "/playbook.md").replace(/\/spec\//, "/playbooks/"))
  .filter((p) => existsSync(join(root, p)));

async function isIndicatorsSpecOrSibling(specPath) {
  const abs = join(root, specPath);
  let text = "";
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return false;
  }
  // Prefer sibling playbook for datasource signals when present.
  const siblingPlaybook = abs.replace(/\/spec\.md$/, "/playbook.md");
  if (existsSync(siblingPlaybook)) {
    try {
      text = `${text}\n${await readFile(siblingPlaybook, "utf8")}`;
    } catch {
      // ignore
    }
  }
  const head = text.slice(0, 8000);
  const looksIndicators = /qdm-indicators-cli|qdm-metric-cli|Metric(?:-native| CLI| Registry)?|Indicators|指标英文 code|indicators\.code\.|analysis execute/i.test(head);
  const looksNonIndicators = /qdm-cmr-cli|qdm-sql-cli|sql\s+execute|CMR/i.test(head) && !looksIndicators;
  if (looksNonIndicators) return false;
  // Metric specs under wikis/metrics are treated as Indicators unless clearly CMR/SQL.
  if (/wikis\/metrics\//.test(specPath) || /\/metrics\//.test(specPath)) return true;
  if (/wikis\/reports\//.test(specPath) || /\/reports\//.test(specPath)) {
    return looksIndicators && !/qdm-cmr-cli/i.test(head);
  }
  return looksIndicators;
}

let supported = true;
if (mode === "free" && specs.length === 0) {
  // Empty recall is OK: skill hands exploration to the LLM via specs indexes.
  supported = true;
} else if (specs.length === 0) {
  supported = false;
} else {
  const checks = await Promise.all(specs.map((p) => isIndicatorsSpecOrSibling(p)));
  supported = checks.every(Boolean);
}

const sid = String(args["session-id"] || `session-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_");
const dir = join(root, ".harness/state/html-report", sid);
const recommendationsPath = join(dir, "recommendations.json");
const recallPath = join(dir, "recall.json");
await mkdir(dir, { recursive: true });
await writeFile(recallPath, `${JSON.stringify(recall, null, 2)}\n`);

const payload = {
  supported,
  mode,
  docSet: "specs",
  specs,
  playbooks,
  files: specs,
  recommendationsPath,
  recallPath,
  emptyRecall: specs.length === 0,
  next:
    specs.length === 0
      ? "contextFiles empty: explore wikis/metrics/index.md and wikis/reports/index.md, open Spec files only, then write recommendations.json and start server --detach without --open"
      : "read only specs, write recommendations.json, validate-config, start server --detach without --open (do not analysis execute)",
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
