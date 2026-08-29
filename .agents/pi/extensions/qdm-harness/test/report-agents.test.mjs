import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalReportAgentName,
  isReportAgentName,
  rememberObservedReportAgentsFromListText,
  reportAgentDispatchName,
  resetObservedReportAgents,
  runtimeListHasReportAgent,
} from "../../shared/report-agents.mjs";
import { htmlReportScriptCandidates } from "../../shared/script-paths.mjs";
import { inspectRuntimeAgentListResult } from "../index.ts";
import { classifyResearcherCommand } from "../../report-researcher-guard/guard.mjs";

test("canonical and legacy report agent names resolve to the same role", () => {
  assert.equal(canonicalReportAgentName("report-writer"), "harness-data.report-writer");
  assert.equal(isReportAgentName("report-writer", "report-writer"), true);
  assert.equal(isReportAgentName("harness-data.report-writer", "report-writer"), true);
  assert.equal(isReportAgentName("harness-data.report-writer", "report-reviewer"), false);
  assert.equal(isReportAgentName("worker", "report-writer"), false);
});

test("runtime list accepts canonical package agent rows", (t) => {
  t.after(() => resetObservedReportAgents());
  const text = [
    "- harness-data.report-writer (package): write",
    "- harness-data.report-researcher (package): research",
    "- harness-data.report-reviewer (package): review",
    "- harness-data.report-designer (package): design",
  ].join("\n");
  assert.equal(runtimeListHasReportAgent(text, "report-writer"), true);
  const inspected = inspectRuntimeAgentListResult({
    toolName: "subagent",
    content: [{ type: "text", text }],
    isError: false,
  });
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.missingAgents, []);
  rememberObservedReportAgentsFromListText(text);
  assert.equal(reportAgentDispatchName("report-writer"), "harness-data.report-writer");
});

test("runtime list prefers legacy dispatch when both names are present", (t) => {
  t.after(() => resetObservedReportAgents());
  const text = [
    "- report-writer (project): write",
    "- harness-data.report-writer (package): write",
    "- report-researcher (project): research",
    "- report-reviewer (project): review",
    "- report-designer (project): design",
  ].join("\n");
  rememberObservedReportAgentsFromListText(text);
  assert.equal(reportAgentDispatchName("report-writer"), "report-writer");
});

test("researcher guard allows packaged absolute fetch/prepare scripts", () => {
  const guardUrl = new URL("../../report-researcher-guard/guard.mjs", import.meta.url).href;
  const fetchAbs = htmlReportScriptCandidates(guardUrl, "fetch-explore.mjs")
    .find((path) => path.endsWith("skills/html-report/scripts/fetch-explore.mjs") && path.startsWith("/"));
  assert.ok(fetchAbs);

  const contract = {
    ok: true,
    mode: "new_query",
    resultPath: "/tmp/session/result.json",
    taskId: "t1",
    payloadPath: "/tmp/session/data/explore/t1.payload.json",
    task: { goal: "缺口", fromCardId: "c1" },
  };
  const classified = classifyResearcherCommand(
    [
      "node",
      fetchAbs,
      `--result '${contract.resultPath}'`,
      `--task-id '${contract.taskId}'`,
      `--payload-file '${contract.payloadPath}'`,
      `--goal '${contract.task.goal}'`,
      `--from-card-id '${contract.task.fromCardId}'`,
    ].join(" "),
    contract
  );
  assert.equal(classified?.kind, "fetch");
});
