import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultB2Result,
  loadB2SessionResult,
  normalizeSessionResult,
  parseSetupB2Args,
  validateSessionResult,
} from "../scripts/setup-b2-test.mjs";

const repoRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const fixturePath = join(repoRoot, "result.json");

test("parseSetupB2Args reads an absolute --result path", () => {
  assert.deepEqual(parseSetupB2Args([]), { fixturePath: "" });
  assert.equal(
    parseSetupB2Args(["--result", fixturePath]).fixturePath,
    resolve(fixturePath)
  );
  assert.throws(() => parseSetupB2Args(["--result"]), /--result requires a path/);
});

test("default B2 result is one confirmed card and passes the query contract", () => {
  const result = defaultB2Result({
    sessionId: "test-b2",
    sessionDir: "/tmp/test-b2",
    startDate: "2026-08-01",
    endDate: "2026-08-10",
  });
  assert.equal(result.cards.length, 1);
  assert.equal(validateSessionResult(result).ok, true);
});

test("repo result.json is rewritten into the current session envelope", () => {
  const sessionDir = "/tmp/html-report-test-b2";
  const result = loadB2SessionResult({
    fixturePath,
    sessionId: "test-b2",
    sessionDir,
  });
  assert.equal(result.status, "confirmed");
  assert.equal(result.session_id, "test-b2");
  assert.equal(result.result_path, join(sessionDir, "result.json"));
  assert.equal(result.recommendations_path, join(sessionDir, "recommendations.json"));
  assert.equal(result.userQuestion, result.title);
  assert.equal(result.cards.length, 14);
  assert.equal(validateSessionResult(result).ok, true);
});

test("invalid fixture cards fail closed with every query error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "setup-b2-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const badPath = join(dir, "result.json");
  await writeFile(badPath, JSON.stringify({
    status: "draft",
    title: "",
    cards: [
      { id: "ok-card", query: { request: { metrics: ["bf19CustNum"] } } },
      { id: "legacy", requestBody: {} },
    ],
  }));
  const checked = validateSessionResult(normalizeSessionResult(
    JSON.parse(await readFile(badPath, "utf8")),
    { sessionId: "test-b2", sessionDir: dir },
  ));
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("\n"), /userQuestion/);
  assert.match(checked.errors.join("\n"), /legacy|query/);
  assert.throws(
    () => loadB2SessionResult({ fixturePath: badPath, sessionId: "test-b2", sessionDir: dir }),
    /invalid --result/
  );
});
