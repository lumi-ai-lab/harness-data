import test from "node:test";
import assert from "node:assert/strict";
import {
  finalizeEditorStage,
  stampAnalysisContractDocument,
} from "../scripts/finalize-editor-stage.mjs";

const RESULT = "/tmp/html-report-editor-session/result.json";
const SESSION = "/tmp/html-report-editor-session";

function runningEditorState() {
  return {
    status: "running",
    currentStage: "B25_EDITOR",
    stages: { B25_EDITOR: { status: "running" } },
  };
}

test("Editor finalizer performs evidence, assembly, and b2 layout once without finishing the Gate", async () => {
  const calls = [];
  const result = await finalizeEditorStage(RESULT, {
    readPipelineState: async (sessionDir) => {
      calls.push(["state", sessionDir]);
      return runningEditorState();
    },
    stampAnalysisContractTasks: async (sessionDir) => {
      calls.push(["contract", sessionDir]);
      return { analysisContractVersion: 1, taskCount: 1 };
    },
    preparePendingReuseEvidence: async (resultPath) => {
      calls.push(["evidence", resultPath]);
      return { ok: true, prepared: [{ taskId: "task-1", evidencePath: `${SESSION}/analysis/evidence/task-1.json` }] };
    },
    assembleReport: async (sessionDir) => {
      calls.push(["assemble", sessionDir]);
      return {
        reportPath: `${SESSION}/report/report.md`,
        manifestPath: `${SESSION}/report/render-manifest.json`,
      };
    },
    checkSessionLayout: async (sessionDir, options) => {
      calls.push(["layout", sessionDir, options]);
      return { ok: true, phase: "b2", warnings: [] };
    },
  });

  assert.deepEqual(calls, [
    ["state", SESSION],
    ["contract", SESSION],
    ["evidence", RESULT],
    ["assemble", SESSION],
    ["layout", SESSION, { phase: "b2" }],
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.producer, "finalize-editor-stage.mjs");
  assert.deepEqual(result.analysisContract, { analysisContractVersion: 1, taskCount: 1 });
  assert.equal(result.nextAction, "stage_gate_finish_B25_EDITOR");
  assert.equal(Object.hasOwn(result, "gate"), false);
});

test("Editor finalizer fails closed at the first bad step and never advances the Gate", async () => {
  const cases = [
    {
      name: "wrong Gate",
      overrides: { readPipelineState: async () => ({ status: "running", currentStage: "B3_RESEARCH", stages: {} }) },
      expected: /B25_EDITOR must be running/,
    },
    {
      name: "analysis contract failure",
      overrides: { stampAnalysisContractTasks: async () => { throw new Error("analysis contract failed"); } },
      expected: /analysis contract failed/,
    },
    {
      name: "evidence failure",
      overrides: { preparePendingReuseEvidence: async () => { throw new Error("evidence failed"); } },
      expected: /evidence failed/,
    },
    {
      name: "assembly failure",
      overrides: { assembleReport: async () => { throw new Error("assemble failed"); } },
      expected: /assemble failed/,
    },
    {
      name: "layout failure",
      overrides: { checkSessionLayout: async () => ({ ok: false, errors: ["bad layout"] }) },
      expected: /b2 layout failed: bad layout/,
    },
  ];

  for (const item of cases) {
    const calls = [];
    const defaults = {
      readPipelineState: async () => runningEditorState(),
      stampAnalysisContractTasks: async () => {
        calls.push("contract");
        return { analysisContractVersion: 1, taskCount: 0 };
      },
      preparePendingReuseEvidence: async () => {
        calls.push("evidence");
        return { ok: true, prepared: [] };
      },
      assembleReport: async () => {
        calls.push("assemble");
        return { reportPath: `${SESSION}/report/report.md`, manifestPath: `${SESSION}/report/render-manifest.json` };
      },
      checkSessionLayout: async () => {
        calls.push("layout");
        return { ok: true, phase: "b2", warnings: [] };
      },
    };
    await assert.rejects(
      finalizeEditorStage(RESULT, { ...defaults, ...item.overrides }),
      item.expected,
      item.name
    );
  }
});

test("Editor finalizer stamps new tasks and requires structured analysis while preserving empty task lists", () => {
  const empty = stampAnalysisContractDocument({ version: 2, round: 0, maxRounds: 2, tasks: [] });
  assert.deepEqual(empty.tasks, []);

  const task = {
    id: "task-1",
    evidencePlan: {
      operations: [{ id: "stats", type: "stats", fields: ["value"] }],
    },
    analysisRequirements: [{
      id: "answer",
      question: "回答业务问题",
      evidenceViewIds: ["stats"],
      targetRubric: ["R1"],
    }],
  };
  const stamped = stampAnalysisContractDocument({ version: 2, tasks: [task] });
  assert.equal(stamped.tasks[0].analysisContractVersion, 1);
  assert.equal(Object.hasOwn(task, "analysisContractVersion"), false, "stamping must not mutate the Editor object");

  assert.throws(
    () => stampAnalysisContractDocument({ version: 2, tasks: [{ ...task, analysisRequirements: [] }] }),
    /analysisRequirements must be a non-empty array/
  );
  assert.throws(
    () => stampAnalysisContractDocument({
      version: 2,
      tasks: [{
        ...task,
        analysisRequirements: [{ ...task.analysisRequirements[0], minScore: null }],
      }],
    }),
    /minScore must be 1 or 2/
  );
});
