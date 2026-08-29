#!/usr/bin/env node
/**
 * html-report MCP server for Codex CLI / ChatGPT App.
 *
 * Stdio JSON-RPC 2.0 server, no external dependencies.
 * Exposes six tools that drive the pipeline from A_CONFIG to B2_MAIN:
 *
 *   html_report_start          create session, open qdm-metric-cli ui
 *   html_report_next           advance pipeline (B0 → B2 per-card fetch)
 *   html_report_close_ui       stop the qdm-metric-cli UI without deleting session data
 *   html_report_submit_writer  accept host caption, write caption.md
 *   html_report_generate_html  optional main.md → sibling main.html export
 *   html_report_status         query current state
 *
 * Loads the bundled Kernel / Runtime (plugin dist, else repo packages).
 * Does not import .agents/pi or agents/pi at runtime.
 * B0 does NOT check for four PI agents (unlike PI B0).
 */
import { existsSync } from "node:fs";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadKernel, loadRuntime, resolveKernelPath, resolveRuntimePath, kernelSource } from "./kernel-loader.mjs";
import { getRootContext } from "./runtime-resolver.mjs";

function requireContext() {
  return getRootContext(process.env, { requireWorkspace: true });
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

async function publishWorkspaceArtifact(context, sourcePath, fileName) {
  const outputDir = join(context.workspaceRoot, "analysis");
  const outputPath = join(outputDir, fileName);
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(outputDir, { recursive: true });
  await copyFile(sourcePath, temporaryPath);
  await rename(temporaryPath, outputPath);
  return outputPath;
}

function normalizedSessionId(sessionId) {
  const safe = String(sessionId || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe) throw new Error("sessionId is required");
  return safe;
}

/**
 * The qdm-metric-cli UI owns the canonical session directory convention.
 * Keep the MCP side byte-for-byte compatible with its workbuddy hash so that
 * the UI's result.json and the pipeline state always share one directory.
 */
function sessionDirFor(sessionId, context = requireContext()) {
  const safe = normalizedSessionId(sessionId);
  const key = createHash("sha256").update(`workbuddy:${safe}`).digest("hex");
  return join(context.stateRoot, "html-report", key);
}

/** Workspace-local sessions are read only for one-time compatibility recovery. */
function legacySessionDirsFor(sessionId, context = requireContext()) {
  const safe = normalizedSessionId(sessionId);
  const key = createHash("sha256").update(`workbuddy:${safe}`).digest("hex");
  const base = join(context.workspaceRoot, ".harness", "state", "html-report");
  return [join(base, key), join(base, safe)];
}

async function assertSafeSessionTree(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`QDM_CONTEXT_INVALID: legacy session root must be a regular directory: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink() || (!childInfo.isDirectory() && !childInfo.isFile())) {
      throw new Error(`QDM_CONTEXT_INVALID: legacy session contains an unsafe entry: ${child}`);
    }
    if (childInfo.isDirectory()) await assertSafeSessionTree(child);
  }
}

async function assertSafeLegacySource(workspaceRoot, source) {
  const rel = relative(workspaceRoot, source);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`QDM_CONTEXT_INVALID: legacy session is outside workspaceRoot: ${source}`);
  }
  let cursor = workspaceRoot;
  const components = rel.split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(`QDM_CONTEXT_INVALID: legacy session path contains a symlink: ${cursor}`);
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`QDM_CONTEXT_INVALID: legacy session ancestor must be a directory: ${cursor}`);
    }
  }
  await assertSafeSessionTree(source);
}

async function migrateLegacySessionTrees(canonical, sources, workspaceRoot) {
  const available = sources.filter(existsSync);
  if (!available.length) return false;
  for (const source of available) await assertSafeLegacySource(workspaceRoot, source);
  if (existsSync(canonical)) await assertSafeSessionTree(canonical);

  const staging = `${canonical}.migration-${process.pid}-${Date.now()}`;
  const backup = `${canonical}.backup-${process.pid}-${Date.now()}`;
  await mkdir(dirname(canonical), { recursive: true });
  try {
    if (existsSync(canonical)) await cp(canonical, staging, { recursive: true, force: false, errorOnExist: false });
    for (const source of available) {
      await cp(source, staging, { recursive: true, force: false, errorOnExist: false });
    }
    await assertSafeSessionTree(staging);
    if (existsSync(canonical)) await rename(canonical, backup);
    await rename(staging, canonical);
    await rm(backup, { recursive: true, force: true });
    return true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(canonical)) await rename(backup, canonical);
    throw error;
  }
}

/**
 * Versions before this fix put MCP state in the readable session-id directory
 * while qdm-metric-cli saved result.json in the canonical hashed directory.
 * Migrate both validated trees into stateRoot without mutating the workspace.
 */
async function resolveSessionDir(sessionId) {
  const context = requireContext();
  const canonical = sessionDirFor(sessionId, context);
  if (existsSync(statePath(canonical))) return canonical;

  const legacySources = legacySessionDirsFor(sessionId, context);
  await migrateLegacySessionTrees(canonical, legacySources, context.workspaceRoot);
  return canonical;
}

function uiMarkerPath(sessionDir) {
  return join(sessionDir, "debug", "metric-cli-ui.json");
}

function pidAlive(pid) {
  const numericPid = Number(pid) || 0;
  if (numericPid <= 1) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function metricCliUiStatus(sessionDir) {
  const markerPath = uiMarkerPath(sessionDir);
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "closed", serverUrl: null };
    }
    return {
      state: "unknown",
      serverUrl: null,
      warning: `Unable to read qdm-metric-cli UI status: ${error?.message || error}`,
    };
  }

  const pids = [...new Set([marker?.pid, marker?.cliPid].map((pid) => Number(pid) || 0).filter((pid) => pid > 1))];
  return {
    state: pids.some(pidAlive) ? "open" : "stale",
    serverUrl: typeof marker?.url === "string" ? marker.url : null,
  };
}

async function closeMetricCliUi(sessionId) {
  const sessionDir = await resolveSessionDir(sessionId);
  try {
    const { stopMetricCliUi } = await loadRuntime("open-metric-cli-ui.mjs");
    const stopped = await stopMetricCliUi({ context: requireContext(), sessionId });
    return {
      ...(await metricCliUiStatus(sessionDir)),
      closeRequested: true,
      stopped: Boolean(stopped?.stopped),
    };
  } catch (error) {
    const current = await metricCliUiStatus(sessionDir);
    return {
      ...current,
      closeRequested: true,
      warning: `Unable to stop qdm-metric-cli UI: ${error?.message || error}`,
    };
  }
}

/** Read result cards opportunistically so progress never changes existing error semantics. */
async function readResultCards(sessionDir) {
  try {
    const result = JSON.parse(await readFile(join(sessionDir, "result.json"), "utf8"));
    return Array.isArray(result?.cards) ? result.cards : [];
  } catch {
    return [];
  }
}

function progressCard(card, number) {
  if (!card) return null;
  return {
    number,
    id: card.id,
    title: card.title || card.id,
  };
}

function progressCardById(resultCards, cardId) {
  const index = resultCards.findIndex((card) => card?.id === cardId);
  return index < 0 ? null : progressCard(resultCards[index], index + 1);
}

/**
 * Derive visible card progress from the confirmed input and persisted caption flags.
 * State deliberately remains title-free so older sessions stay compatible.
 */
async function reportProgress(sessionDir, state) {
  const resultCards = await readResultCards(sessionDir);
  const stateCards = Array.isArray(state?.cards) ? state.cards : [];
  const captioned = new Map(
    stateCards
      .filter((card) => card && typeof card === "object")
      .map((card) => [card.id, card.captioned === true]),
  );
  const total = resultCards.length;
  const completed = resultCards.filter((card) => captioned.get(card?.id) === true).length;
  const allCompleted = total === 0 || completed === total;
  const currentIndex = Number.isInteger(state?.currentIndex) ? state.currentIndex : -1;
  const currentCard = stateCards[currentIndex];
  const active = !allCompleted && state?.stage === "b2_writer"
    ? progressCardById(resultCards, currentCard?.id)
    : null;
  const pendingStateCard = stateCards.find((card) => card?.captioned !== true);
  let next = allCompleted ? null : progressCardById(resultCards, pendingStateCard?.id);
  if (!next && !allCompleted) {
    const nextIndex = resultCards.findIndex((card) => captioned.get(card?.id) !== true);
    next = nextIndex < 0 ? null : progressCard(resultCards[nextIndex], nextIndex + 1);
  }

  return { total, completed, active, next };
}

// ── tool implementations ──────────────────────────────────────────────

/**
 * html_report_start: create session, open qdm-metric-cli ui.
 * The UI lifetime is tied to this MCP server process via --watch-pid.
 */
async function htmlReportStart(args) {
  const sessionId = String(args.sessionId || "").trim() || `mcp-${randomUUID().slice(0, 8)}`;
  const userQuestion = String(args.userQuestion || "").trim();
  const context = requireContext();
  const sessionDir = sessionDirFor(sessionId, context);

  const { bindCliScriptPath, openMetricCliUi } = await loadRuntime("open-metric-cli-ui.mjs");
  bindCliScriptPath(resolveRuntimePath("open-metric-cli-ui.mjs"));
  const opened = await openMetricCliUi({
    context,
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
    ui: { state: "open", serverUrl: opened.serverUrl || null },
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
  const sessionDir = await resolveSessionDir(sessionId);
  const state = await readState(sessionDir);
  if (!state) throw new Error(`no active session: ${sessionId}`);

  // ── A_CONFIG → B0 ──
  if (state.stage === "a_config") {
    const resultPath = join(sessionDir, "result.json");
    if (!existsSync(resultPath)) {
      return {
        stage: "a_config",
        progress: await reportProgress(sessionDir, state),
        message: "result.json not found. User must click 保存 in qdm-metric-cli ui first.",
      };
    }

    // B0 preflight: validate result.json + metric CLI (no PI Agent check)
    const { loadAuthzConfig, resolveMetricCliPath } = await loadRuntime("authz-config.mjs");
    const context = requireContext();
    const config = loadAuthzConfig(context);
    const cliPath = resolveMetricCliPath(context, config);
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

    // B0 passed → configuration is locked; stop the editor before B2 fetches data.
    state.stage = "b2_writer";
    state.cards = result.cards.map((c) => ({ id: c.id, captioned: false }));
    state.currentIndex = 0;
    await writeState(sessionDir, state);

    const ui = await closeMetricCliUi(sessionId);
    const next = await fetchCurrentCard(sessionDir, sessionId, result, state);
    return { ...next, ui };
  }

  // ── B2_WRITER: fetch next card or finish ──
  if (state.stage === "b2_writer") {
    // Check if all cards are captioned
    const allDone = state.cards.every((c) => c.captioned);
    if (allDone) {
      // compose-main.mjs
      const { composeMain } = await loadKernel("artifacts/compose-main.mjs");
      await composeMain(sessionDir);
      const context = requireContext();
      state.stage = "b2_main";
      state.sessionMainPath = join(sessionDir, "analysis", "main.md");
      state.mainPath = await publishWorkspaceArtifact(context, state.sessionMainPath, "main.md");
      state.htmlGeneration = { required: true, phrase: "生成 HTML" };
      await writeState(sessionDir, state);
      return {
        stage: "b2_main",
        mainPath: state.mainPath,
        html: "awaiting_confirmation",
        htmlConfirmation: "生成 HTML",
        progress: await reportProgress(sessionDir, state),
        message: "analysis/main.md is ready. Ask the user whether to generate analysis/main.html. Call html_report_generate_html only after explicit confirmation.",
      };
    }

    // Find next uncaptioned card
    const nextIdx = state.cards.findIndex((c) => !c.captioned);
    if (nextIdx < 0) {
      // All done — shouldn't reach here, but handle gracefully
      state.stage = "b2_main";
      await writeState(sessionDir, state);
      return {
        stage: "b2_main",
        progress: await reportProgress(sessionDir, state),
        message: "All cards captioned. Call html_report_next again to compose main.md.",
      };
    }
    state.currentIndex = nextIdx;
    await writeState(sessionDir, state);

    const resultPath = join(sessionDir, "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    return await fetchCurrentCard(sessionDir, sessionId, result, state);
  }

  // ── B2_MAIN: already done ──
  if (state.stage === "b2_main") {
    const { htmlExportSummary } = await loadKernel("artifacts/export-main-html.mjs");
    const html = await htmlExportSummary(sessionDir);
    return {
      stage: "b2_main",
      mainPath: state.mainPath || join(requireContext().workspaceRoot, "analysis", "main.md"),
      html: html.status,
      ...(html.status === "awaiting_confirmation" ? { htmlConfirmation: "生成 HTML" } : {}),
      htmlPath: html.htmlPath,
      progress: await reportProgress(sessionDir, state),
      message: html.status === "awaiting_confirmation"
        ? "Pipeline already completed. analysis/main.md is ready. Ask the user whether to generate analysis/main.html."
        : "Pipeline already completed. analysis/main.md is ready.",
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
  const { fetchAllEntries } = await loadKernel("data/fetch-entry.mjs");
  const context = requireContext();
  const fetchResult = await fetchAllEntries(resultPath, { cardId: card.id, context, projectRoot: context.workspaceRoot });
  const cardResult = fetchResult.cards.find((c) => c.cardId === card.id || c.id === card.id);
  if (!cardResult || cardResult.fetchStatus === "failed") {
    throw new Error(`fetch failed for card ${card.id}: ${cardResult?.error || "unknown"}`);
  }

  // prepare-card-caption-evidence.mjs
  const { prepareCardCaptionEvidence } = await loadKernel("evidence/prepare-card-caption-evidence.mjs");
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
    progress: await reportProgress(sessionDir, state),
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

  const sessionDir = await resolveSessionDir(sessionId);
  const state = await readState(sessionDir);
  if (!state) throw new Error(`no active session: ${sessionId}`);
  if (state.stage !== "b2_writer") {
    throw new Error(`cannot submit caption in stage ${state.stage}; expected b2_writer`);
  }

  const cardEntry = state.cards.find((c) => c.id === cardId);
  if (!cardEntry) throw new Error(`card ${cardId} not found in session`);
  if (cardEntry.captioned) throw new Error(`card ${cardId} already has a caption`);

  // Resolve paths
  const { writerReturnPaths } = await loadKernel("session/writer-return.mjs");
  const paths = writerReturnPaths({ sessionDir, cardId });

  // Reject invalid evidence references before writing or completing the card.
  // The shared writer intentionally supports soft violations for the PI caption
  // gate, but the Codex MCP path must leave the card retryable on any violation.
  const { loadCaptionEvidence, validateCaptionSubmission, writeCardCaption } = await loadKernel("captions/submit-card-caption.mjs");
  const input = { paragraphs, pointers };
  const evidence = await loadCaptionEvidence(paths.evidencePath);
  validateCaptionSubmission(input, evidence);

  // submit-card-caption.mjs: input must contain ONLY paragraphs + pointers (no cardId)
  const result = await writeCardCaption({
    input,
    evidencePath: paths.evidencePath,
    captionPath: paths.captionPath,
  });

  cardEntry.captioned = true;
  await writeState(sessionDir, state);

  return {
    accepted: true,
    cardId,
    violations: result.violations || [],
    progress: await reportProgress(sessionDir, state),
    message: `Caption accepted for card ${cardId}. Call html_report_next to proceed.`,
  };
}

function rejectUnexpectedArgs(args, allowed, toolName) {
  const extra = Object.keys(args || {}).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`${toolName} only accepts ${[...allowed].join(", ")}; unexpected: ${extra.join(", ")}`);
  }
}

/**
 * html_report_generate_html: optional sibling HTML export after B2_MAIN.
 * Skill must obtain explicit user confirmation before calling this tool.
 */
async function htmlReportGenerateHtml(args) {
  rejectUnexpectedArgs(args, new Set(["sessionId", "confirmation"]), "html_report_generate_html");
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const confirmation = String(args.confirmation || "").trim();
  if (confirmation !== "生成 HTML") {
    throw new Error('explicit user confirmation is required; pass confirmation="生成 HTML" only after the user agrees');
  }
  const sessionDir = await resolveSessionDir(sessionId);
  const state = await readState(sessionDir);
  if (!state) throw new Error(`no active session: ${sessionId}`);
  if (state.stage !== "b2_main") {
    throw new Error(`cannot generate HTML in stage ${state.stage}; expected b2_main`);
  }
  const { exportMainHtml } = await loadKernel("artifacts/export-main-html.mjs");
  const exported = await exportMainHtml(sessionDir);
  if (exported?.htmlPath && existsSync(exported.htmlPath)) {
    exported.workspaceHtmlPath = await publishWorkspaceArtifact(requireContext(), exported.htmlPath, "main.html");
    state.htmlGeneration = { required: false, confirmedAt: new Date().toISOString() };
    await writeState(sessionDir, state);
  }
  return exported;
}

/**
 * html_report_close_ui: explicitly close the UI without deleting report state.
 */
async function htmlReportCloseUi(args) {
  rejectUnexpectedArgs(args, new Set(["sessionId"]), "html_report_close_ui");
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const ui = await closeMetricCliUi(sessionId);
  return {
    sessionId,
    ui,
    message: ui.warning
      ? "UI close was requested, but cleanup could not be fully verified."
      : "qdm-metric-cli UI close was requested. The report session data was kept.",
  };
}

/**
 * html_report_status: return current session state.
 */
async function htmlReportStatus(args) {
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const sessionDir = await resolveSessionDir(sessionId);
  const state = await readState(sessionDir);
  if (!state) {
    return {
      sessionId,
      stage: "none",
      progress: await reportProgress(sessionDir, null),
      message: "No active session. Call html_report_start first.",
    };
  }

  const { htmlExportSummary } = await loadKernel("artifacts/export-main-html.mjs");
  const html = state.stage === "b2_main"
    ? await htmlExportSummary(sessionDir)
    : { status: "not_applicable", htmlPath: null, error: null, attempt: null };

  return {
    sessionId,
    stage: state.stage,
    cards: state.cards,
    currentIndex: state.currentIndex,
    mainPath: state.mainPath || null,
    startedAt: state.startedAt || null,
    ui: await metricCliUiStatus(sessionDir),
    html,
    progress: await reportProgress(sessionDir, state),
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
    description: "Advance the pipeline: B0 preflight, per-card data fetch, or compose main.md when all cards are done. Returns per-card progress and current/next card metadata.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID from html_report_start." },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "html_report_close_ui",
    description: "Close qdm-metric-cli ui for a session without deleting its report state. Use when the user explicitly cancels or asks to close the editor.",
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
    description: "Submit caption paragraphs and evidence pointers for the current card. Returns per-card progress and current/next card metadata.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cardId: { type: "string" },
        paragraphs: { type: "array", items: { type: "string" }, description: "1-3 short caption paragraphs." },
        pointers: { type: "array", items: { type: "string" }, description: "JSON pointers to evidence views you used, e.g. /views/<id>. Row-level paths such as /views/<id>/rows/0/metricValue are folded to that view. Omit or pass [] to default to all views." },
      },
      required: ["sessionId", "cardId", "paragraphs"],
    },
  },
  {
    name: "html_report_generate_html",
    description: "Export analysis/main.md to sibling analysis/main.html via md2html. Call only after the user explicitly confirms HTML generation and pass confirmation=生成 HTML.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID from html_report_start." },
        confirmation: { type: "string", description: "The exact user confirmation phrase: 生成 HTML." },
      },
      required: ["sessionId", "confirmation"],
    },
  },
  {
    name: "html_report_status",
    description: "Query the current pipeline state for a session, including per-card progress and card metadata.",
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
  html_report_close_ui: htmlReportCloseUi,
  html_report_submit_writer: htmlReportSubmitWriter,
  html_report_generate_html: htmlReportGenerateHtml,
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
            serverInfo: { name: "html-report", version: "0.0.50" },
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
      error: {
        code: -32603,
        message: error?.code ? `${error.code}: ${error.message || error}` : (error instanceof Error ? error.message : String(error)),
      },
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
  eq("tool count", TOOLS.length, 6);
  eq("tool names", TOOLS.map((t) => t.name), [
    "html_report_start",
    "html_report_next",
    "html_report_close_ui",
    "html_report_submit_writer",
    "html_report_generate_html",
    "html_report_status",
  ]);

  eq("kernel source", ["dist", "packages"].includes(kernelSource()), true);
  eq("open-metric-cli-ui exists", existsSync(resolveRuntimePath("open-metric-cli-ui.mjs")), true);
  eq("fetch-entry exists", existsSync(resolveKernelPath("data/fetch-entry.mjs")), true);
  eq("compose-main exists", existsSync(resolveKernelPath("artifacts/compose-main.mjs")), true);
  eq("export-main-html exists", existsSync(resolveKernelPath("artifacts/export-main-html.mjs")), true);
  eq("submit-card-caption exists", existsSync(resolveKernelPath("captions/submit-card-caption.mjs")), true);
  eq("prepare-card-caption-evidence exists", existsSync(resolveKernelPath("evidence/prepare-card-caption-evidence.mjs")), true);
  eq("authz-config exists", existsSync(resolveRuntimePath("authz-config.mjs")), true);

  const passed = asserts.filter((a) => a.ok).length;
  const failed = asserts.length - passed;
  console.log(`self-test: ${passed}/${asserts.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv.includes("--self-test")) {
  selfTest();
}
