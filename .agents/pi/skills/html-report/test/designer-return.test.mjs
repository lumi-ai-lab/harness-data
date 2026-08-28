import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildDesignerReturnSchema,
  designerExpectedFromAssignment,
  designerReturnPaths,
  parseDesignerReturnText,
  validateDesignerArtifacts,
  validateDesignerReturn,
} from "../scripts/designer-return.mjs";

async function seedDesignerSession(t) {
  const root = await mkdtemp(join(tmpdir(), "html-report-designer-return-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  const expected = designerReturnPaths({ sessionDir: session });
  await mkdir(dirname(expected.resultPath), { recursive: true });
  await writeFile(expected.resultPath, JSON.stringify({ status: "confirmed" }));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, session, expected };
}

function successReturn(expected, overrides = {}) {
  return {
    status: "ok",
    paths: {
      reportHtml: expected.reportHtml,
      renderMeta: expected.renderMeta,
      designResult: expected.designResult,
      desktopScreenshot: expected.desktopScreenshot,
      mobileScreenshot: expected.mobileScreenshot,
    },
    layoutOk: true,
    repairRounds: 0,
    elapsedMs: 0,
    residualNotes: [],
    ...overrides,
  };
}

function failedReturn(expected, overrides = {}) {
  return {
    ...successReturn(expected),
    status: "failed",
    layoutOk: false,
    error: "capture-report failed",
    residualNotes: ["检查浏览器依赖后由用户重试当前阶段"],
    ...overrides,
  };
}

test("Designer assignment pins the current SESSION and result.json", async (t) => {
  const seeded = await seedDesignerSession(t);
  const assignment = [
    "B5 autonomous design",
    `SESSION=${seeded.session}`,
    `result.json=${seeded.expected.resultPath}`,
  ].join("\n");
  assert.deepEqual(
    designerExpectedFromAssignment(assignment, { sessionDir: seeded.session }),
    seeded.expected
  );

  const forged = designerExpectedFromAssignment(
    assignment.replace(seeded.expected.resultPath, join(seeded.root, "other", "result.json")),
    { sessionDir: seeded.session }
  );
  assert.match(forged.error, /当前 html-report session/);

  const relative = designerExpectedFromAssignment(
    "SESSION=relative\nresult.json=relative/result.json",
    { sessionDir: seeded.session }
  );
  assert.match(relative.error, /规范绝对路径/);
});

test("Designer schema fixes all five paths and separates ok from failed", async (t) => {
  const { expected } = await seedDesignerSession(t);
  const schema = buildDesignerReturnSchema(expected);
  const ok = schema.oneOf[0];
  const failed = schema.oneOf[1];
  assert.equal(ok.properties.status.const, "ok");
  assert.equal(ok.properties.layoutOk.const, true);
  assert.equal(failed.properties.status.const, "failed");
  assert.equal(failed.properties.layoutOk.const, false);
  assert.equal(failed.properties.residualNotes.minItems, 1);
  for (const key of [
    "reportHtml",
    "renderMeta",
    "designResult",
    "desktopScreenshot",
    "mobileScreenshot",
  ]) {
    assert.equal(ok.properties.paths.properties[key].const, expected[key]);
  }
});

test("Designer return rejects forged paths and generic acceptance fields", async (t) => {
  const { expected } = await seedDesignerSession(t);
  assert.equal(validateDesignerReturn(successReturn(expected), expected).ok, true);
  assert.equal(validateDesignerReturn(failedReturn(expected), expected).ok, true);

  const forged = successReturn(expected);
  forged.paths.reportHtml = "/tmp/forged.html";
  assert.match(validateDesignerReturn(forged, expected).errors.join("; "), /reportHtml/);

  const generic = { ...successReturn(expected), commandsRun: ["layout"] };
  assert.match(validateDesignerReturn(generic, expected).errors.join("; "), /unexpected or missing/);

  const noFailureNote = failedReturn(expected, { residualNotes: [] });
  assert.match(validateDesignerReturn(noFailureNote, expected).errors.join("; "), /at least one residual note/);
});

test("Designer artifact validation requires fixed screenshots and authoritative html layout", async (t) => {
  const { expected } = await seedDesignerSession(t);
  const value = successReturn(expected);
  let layoutCalls = 0;
  const missing = await validateDesignerArtifacts(value, expected, {
    layoutCheck: async () => {
      layoutCalls += 1;
      return { ok: true, errors: [] };
    },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("; "), /reportHtml.*desktopScreenshot.*mobileScreenshot/);
  assert.equal(layoutCalls, 0, "layout must not run while fixed artifacts are missing");

  for (const key of [
    "reportHtml",
    "renderMeta",
    "designResult",
    "desktopScreenshot",
    "mobileScreenshot",
  ]) {
    await mkdir(dirname(expected[key]), { recursive: true });
    await writeFile(expected[key], `fixture:${key}`);
  }
  const valid = await validateDesignerArtifacts(value, expected, {
    layoutCheck: async (sessionDir, options) => {
      layoutCalls += 1;
      assert.equal(sessionDir, expected.sessionDir);
      assert.deepEqual(options, { phase: "html" });
      return { ok: true, errors: [], warnings: [] };
    },
  });
  assert.equal(valid.ok, true);
  assert.equal(layoutCalls, 1);

  const invalidLayout = await validateDesignerArtifacts(value, expected, {
    layoutCheck: async () => ({ ok: false, errors: ["screenshot fingerprint mismatch"] }),
  });
  assert.equal(invalidLayout.ok, false);
  assert.match(invalidLayout.errors.join("; "), /screenshot fingerprint mismatch/);
});

test("Designer failed terminal is valid without pretending artifacts exist", async (t) => {
  const { expected } = await seedDesignerSession(t);
  const checked = await validateDesignerArtifacts(failedReturn(expected), expected, {
    layoutCheck: async () => {
      throw new Error("must not run");
    },
  });
  assert.deepEqual(checked, { ok: true, errors: [] });
});

test("Designer text parser accepts JSON only", async (t) => {
  const { expected } = await seedDesignerSession(t);
  const value = successReturn(expected);
  assert.deepEqual(parseDesignerReturnText(JSON.stringify(value)), value);
  assert.throws(() => parseDesignerReturnText(`result:\n${JSON.stringify(value)}`), /without prose/);
});
