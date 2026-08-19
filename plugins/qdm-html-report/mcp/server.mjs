#!/usr/bin/env node
/**
 * html-report MCP server for Codex CLI / ChatGPT App.
 *
 * Stdio JSON-RPC 2.0 server, no external dependencies.
 * Exposes four tools that drive the pipeline from A_CONFIG to B2_MAIN:
 *
 *   html_report_start         create session, open qdm-metric-cli ui
 *   html_report_next          advance pipeline (B0 → B2 per-card fetch)
 *   html_report_submit_writer accept host caption, write caption.md
 *   html_report_status        query current state
 *
 * Reuses PI scripts in place — no code duplication, no PI runtime dependency.
 * B0 does NOT check for four PI agents (unlike PI B0).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ── path resolution ────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from cwd to find the harness workspace root (has config/harness-config.yaml). */
function findWorkspaceRoot(start = process.cwd()) {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "config", "harness-config.yaml")) ||
        existsSync(join(dir, "bin", "data-harness-cli"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const workspace = findWorkspaceRoot();
// Source repo: <workspace>/.agents/pi/...  Runtime: <workspace>/agents/pi/...
function resolveAgentsPath(...rel) {
  for (const prefix of [".agents", "agents"]) {
    const p = join(workspace, prefix, ...rel);
    if (existsSync(p)) return p;
  }
  return join(workspace, ".agents", ...rel);
}
const scriptsDir = resolveAgentsPath("pi", "skills", "html-report", "scripts");
const authzConfigPath = resolveAgentsPath("pi", "extensions", "qdm-harness", "authz-config.mjs");

// ── lazy script imports (resolved at call time so missing files don't crash startup) ──

async function importScript(rel) {
  return import(join(scriptsDir, rel));
}

// ── pipeline state ────────────────────────────────────────────────────

function statePath(sessionDir) {
  return join(sessionDir, "debug", "mcp-pipeline-state.json");
}

async function readState(sessionDir) {
  try {
    return JSON.parse(await readFile(statePath(sessionDir), "utf8"));
  } catch {
    return null;
  }
}

async function writeState(sessionDir, state) {
  await mkdir(dirname(statePath(sessionDir)), { recursive: true });
  await writeFile(statePath(sessionDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sessionDirFor(sessionId) {
  const safe = String(sessionId || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe) throw new Error("sessionId is required");
  return join(workspace, ".harness", "state", "html-report", safe);
}

// ── tool implementations ──────────────────────────────────────────────

/**
 * html_report_start: create session, open qdm-metric-cli ui.
 * The UI lifetime is tied to this MCP server process via --watch-pid.
 */
async function htmlReportStart(args) {
  const sessionId = String(args.sessionId || "").trim() || `mcp-${randomUUID().slice(0, 8)}`;
  const userQuestion = String(args.userQuestion || "").trim();
  const sessionDir = sessionDirFor(sessionId);

  const { openMetricCliUi } = await importScript("open-metric-cli-ui.mjs");
  const opened = await openMetricCliUi({
    projectRoot: workspace,
    sessionId,
    userQuestion,
    open: true,
    spawnUi: true,
    detach: true,
    watchPid: process.pid,
  });

  await writeState(sessionDir, {
    version: 1,
    sessionId,
    stage: "a_config",
    cards: [],
    currentIndex: -1,
    startedAt: new Date().toISOString(),
  });

  return {
    sessionId,
    sessionDir,
    stage: "a_config",
    uiUrl: opened.serverUrl || null,
    message: "qdm-metric-cli ui is open. Tell the user: build cards, click 保存, then reply 继续.",
  };
}

/**
 * html_report_next: advance the pipeline.
 * a_config → B0 preflight → B2_WRITER (per-card fetch + evidence)
 * all cards captioned → compose-main.mjs → B2_MAIN
 */
async function htmlReportNext(args) {
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const sessionDir = sessionDirFor(sessionId);
  const state = await readState(sessionDir);
  if (!state) throw new Error(`no active session: ${sessionId}`);

  // ── A_CONFIG → B0 ──
  if (state.stage === "a_config") {
    const resultPath = join(sessionDir, "result.json");
    if (!existsSync(resultPath)) {
      return { stage: "a_config", message: "result.json not found. User must click 保存 in qdm-metric-cli ui first." };
    }

    // B0 preflight: validate result.json + metric CLI (no PI Agent check)
    const { loadAuthzConfig, resolveMetricCliPath } = await import(
      authzConfigPath
    );
    const config = loadAuthzConfig(workspace);
    const cliPath = resolveMetricCliPath(workspace, config);
    if (!existsSync(cliPath)) {
      throw new Error(`B0 failed: qdm-metric-cli not found at ${cliPath}`);
    }

    let result;
    try {
      result = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      throw new Error("B0 failed: result.json is not valid JSON");
    }
    if (result.status !== "confirmed") {
      throw new Error(`B0 failed: result.status must be "confirmed", got ${JSON.stringify(result.status)}`);
    }
    if (!Array.isArray(result.cards) || result.cards.length === 0) {
      throw new Error("B0 failed: result.json must contain a non-empty cards[]");
    }

    // B0 passed → start B2_WRITER: fetch first card
    state.stage = "b2_writer";
    state.cards = result.cards.map((c) => ({ id: c.id, captioned: false }));
    state.currentIndex = 0;
    await writeState(sessionDir, state);

    return await fetchCurrentCard(sessionDir, sessionId, result, state);
  }

  // ── B2_WRITER: fetch next card or finish ──
  if (state.stage === "b2_writer") {
    // Check if all cards are captioned
    const allDone = state.cards.every((c) => c.captioned);
    if (allDone) {
      // compose-main.mjs
      const { composeMain } = await importScript("compose-main.mjs");
      const output = await composeMain(sessionDir);
      state.stage = "b2_main";
      state.mainPath = join(sessionDir, "analysis", "main.md");
      await writeState(sessionDir, state);
      return {
        stage: "b2_main",
        mainPath: state.mainPath,
        message: "analysis/main.md is ready. Pipeline stops here for the first version.",
      };
    }

    // Find next uncaptioned card
    const nextIdx = state.cards.findIndex((c) => !c.captioned);
    if (nextIdx < 0) {
      // All done — shouldn't reach here, but handle gracefully
      state.stage = "b2_main";
      await writeState(sessionDir, state);
      return { stage: "b2_main", message: "All cards captioned. Call html_report_next again to compose main.md." };
    }
    state.currentIndex = nextIdx;
    await writeState(sessionDir, state);

    const resultPath = join(sessionDir, "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    return await fetchCurrentCard(sessionDir, sessionId, result, state);
  }

  // ── B2_MAIN: already done ──
  if (state.stage === "b2_main") {
    return {
      stage: "b2_main",
      mainPath: state.mainPath || join(sessionDir, "analysis", "main.md"),
      message: "Pipeline already completed. analysis/main.md is ready.",
    };
  }

  throw new Error(`unknown stage: ${state.stage}`);
}

/** Fetch data for the current card and prepare caption evidence. */
async function fetchCurrentCard(sessionDir, sessionId, result, state) {
  const cardIdx = state.currentIndex;
  const card = result.cards[cardIdx];
  if (!card) throw new Error(`no card at index ${cardIdx}`);

  const resultPath = join(sessionDir, "result.json");

  // fetch-entry.mjs (CLI)
  const { fetchAllEntries } = await importScript("fetch-entry.mjs");
  const fetchResult = await fetchAllEntries(resultPath, { cardId: card.id });
  const cardResult = fetchResult.cards.find((c) => c.cardId === card.id || c.id === card.id);
  if (!cardResult || cardResult.fetchStatus === "failed") {
    throw new Error(`fetch failed for card ${card.id}: ${cardResult?.error || "unknown"}`);
  }

  // prepare-card-caption-evidence.mjs
  const { prepareCardCaptionEvidence } = await importScript("prepare-card-caption-evidence.mjs");
  const evidence = await prepareCardCaptionEvidence({ resultPath, cardId: card.id });

  return {
    stage: "b2_writer",
    sessionId,
    cardId: card.id,
    cardTitle: card.title || card.id,
    evidence: {
      evidencePath: evidence.evidencePath,
      views: evidence.evidence.views,
    },
    message: "Data fetched. Write 1-3 short caption paragraphs (who is high/low, what stands out). Every number must come from evidence views. Then call html_report_submit_writer.",
  };
}

/**
 * html_report_submit_writer: validate and write the host's caption.
 */
async function htmlReportSubmitWriter(args) {
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const cardId = String(args.cardId || "").trim();
  if (!cardId) throw new Error("cardId is required");
  const paragraphs = Array.isArray(args.paragraphs) ? args.paragraphs : [];
  const pointers = Array.isArray(args.pointers) ? args.pointers : [];

  const sessionDir = sessionDirFor(sessionId);
  const state = await readState(sessionDir);
  if (!state) throw new Error(`no active session: ${sessionId}`);
  if (state.stage !== "b2_writer") {
    throw new Error(`cannot submit caption in stage ${state.stage}; expected b2_writer`);
  }

  const cardEntry = state.cards.find((c) => c.id === cardId);
  if (!cardEntry) throw new Error(`card ${cardId} not found in session`);
  if (cardEntry.captioned) throw new Error(`card ${cardId} already has a caption`);

  // Resolve paths
  const { writerReturnPaths } = await importScript("writer-return.mjs");
  const paths = writerReturnPaths({ sessionDir, cardId });

  // submit-card-caption.mjs: input must contain ONLY paragraphs + pointers (no cardId)
  const { writeCardCaption } = await importScript("submit-card-caption.mjs");
  const result = await writeCardCaption({
    input: { paragraphs, pointers },
    evidencePath: paths.evidencePath,
    captionPath: paths.captionPath,
  });

  cardEntry.captioned = true;
  await writeState(sessionDir, state);

  return {
    accepted: true,
    cardId,
    violations: result.violations || [],
    message: `Caption accepted for card ${cardId}. Call html_report_next to proceed.`,
  };
}

/**
 * html_report_status: return current session state.
 */
async function htmlReportStatus(args) {
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const sessionDir = sessionDirFor(sessionId);
  const state = await readState(sessionDir);
  if (!state) return { sessionId, stage: "none", message: "No active session. Call html_report_start first." };

  return {
    sessionId,
    stage: state.stage,
    cards: state.cards,
    currentIndex: state.currentIndex,
    mainPath: state.mainPath || null,
    startedAt: state.startedAt || null,
  };
}

// ── MCP tool schemas ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: "html_report_start",
    description: "Create a new html-report session and open qdm-metric-cli ui for the user to configure cards.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Unique session identifier. Auto-generated if omitted." },
        userQuestion: { type: "string", description: "The user's original analysis question." },
      },
    },
  },
  {
    name: "html_report_next",
    description: "Advance the pipeline: B0 preflight, per-card data fetch, or compose main.md when all cards are done.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID from html_report_start." },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "html_report_submit_writer",
    description: "Submit caption paragraphs and evidence pointers for the current card.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cardId: { type: "string" },
        paragraphs: { type: "array", items: { type: "string" }, description: "1-3 short caption paragraphs." },
        pointers: { type: "array", items: { type: "string" }, description: "JSON pointers into evidence views, e.g. /views/<id>/rows/0/value" },
      },
      required: ["sessionId", "cardId", "paragraphs", "pointers"],
    },
  },
  {
    name: "html_report_status",
    description: "Query the current pipeline state for a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
];

const HANDLERS = {
  html_report_start: htmlReportStart,
  html_report_next: htmlReportNext,
  html_report_submit_writer: htmlReportSubmitWriter,
  html_report_status: htmlReportStatus,
};

// ── stdio JSON-RPC 2.0 ────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  try {
    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "html-report", version: "0.0.46" },
          },
        });
        break;
      case "notifications/initialized":
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        break;
      case "tools/call": {
        const name = params?.name;
        const handler = HANDLERS[name];
        if (!handler) throw new Error(`unknown tool: ${name}`);
        const result = await handler(params.arguments || {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
        break;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

// ── main loop ─────────────────────────────────────────────────────────

let buf = "";

process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handle(JSON.parse(line)).catch((error) => {
      process.stderr.write(`unhandled error: ${error.message || error}\n`);
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// ── self-test ─────────────────────────────────────────────────────────

async function selfTest() {
  const asserts = [];
  const eq = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    asserts.push({ label, ok });
    if (!ok) console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  };

  // tool list
  eq("tool count", TOOLS.length, 4);
  eq("tool names", TOOLS.map((t) => t.name), ["html_report_start", "html_report_next", "html_report_submit_writer", "html_report_status"]);

  // path resolution
  eq("scriptsDir exists", existsSync(scriptsDir), true);
  eq("open-metric-cli-ui exists", existsSync(join(scriptsDir, "open-metric-cli-ui.mjs")), true);
  eq("fetch-entry exists", existsSync(join(scriptsDir, "fetch-entry.mjs")), true);
  eq("compose-main exists", existsSync(join(scriptsDir, "compose-main.mjs")), true);
  eq("submit-card-caption exists", existsSync(join(scriptsDir, "submit-card-caption.mjs")), true);
  eq("prepare-card-caption-evidence exists", existsSync(join(scriptsDir, "prepare-card-caption-evidence.mjs")), true);

  const passed = asserts.filter((a) => a.ok).length;
  const failed = asserts.length - passed;
  console.log(`self-test: ${passed}/${asserts.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) {
  selfTest();
}
