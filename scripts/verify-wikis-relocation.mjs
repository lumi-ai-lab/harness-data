#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../packages/data-harness-cli/src/main.js";
import { findShowDocument } from "../packages/data-harness-cli/src/commands/show.js";
import { build } from "../packages/data-harness-cli/src/lib/context/build.js";
import { normalizeRootContext } from "../packages/data-harness-cli/src/lib/root-context.js";
import { runAllChecks } from "../packages/data-harness-cli/src/lib/wikis/checks.js";
import { buildIndex, loadIndex, loadRuntimeIndex } from "../packages/data-harness-cli/src/lib/wikis/index.js";
import { verifyPinnedWikis } from "./verify-pinned-wikis.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultSourceRoot = path.join(repoRoot, "plugins", "harness-data", "resources", "wikis");

export async function verifyWikiRelocation({ sourceRoot = defaultSourceRoot, keep = false } = {}) {
  const pinned = verifyPinnedWikis({ wikisRoot: sourceRoot });
  if (!pinned.ok) throw new Error(pinned.message);
  const source = path.resolve(sourceRoot);
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "qdm-wikis-relocation-"));
  const buildRoot = path.join(tempRoot, "build");
  const relocatedRoot = path.join(tempRoot, "relocated");
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  try {
    cpSync(source, buildRoot, {
      recursive: true,
      filter: (candidate) => {
        const base = path.basename(candidate);
        return base !== ".git" && base !== ".harness" && base !== "resource-manifest.json";
      },
    });
    const checks = runAllChecks(buildRoot, { maxErrors: 500 });
    const checkErrors = checks.reduce((sum, result) => sum + result.totalErrors, 0);
    if (checkErrors) throw new Error(`pinned Wikis checks failed with ${checkErrors} error(s)`);
    const built = buildIndex(buildRoot, false);
    cpSync(buildRoot, relocatedRoot, { recursive: true });

    const context = normalizeRootContext({
      schemaVersion: 1,
      host: "codex",
      pluginRoot: relocatedRoot,
      dataRoot,
      workspaceRoot,
      sessionId: "wikis-relocation",
    });
    const index = loadIndex(context);
    const runtime = loadRuntimeIndex(context);
    const question = runtime.recall?.[0]?.term || "销售额";
    const response = build(context, question);
    const firstPath = index.docs?.[0]?.path || Object.keys(runtime.docsByPath || {})[0];
    if (!firstPath) throw new Error("relocated Wikis index contains no documents");
    const shown = findShowDocument(context, firstPath);
    if (!shown) throw new Error(`relocated Wikis show lookup failed: ${firstPath}`);

    const contextFile = writeContext(tempRoot, context, "context.json");
    const contextIo = memoryIO();
    await run(["--context-file", contextFile, "context", "--question", question, "--json"], contextIo);
    const contextOutput = parseJSON(contextIo.stdoutText, "context");
    if (!Array.isArray(contextOutput.contextFiles)) throw new Error("relocated context output has no contextFiles");
    for (const entry of contextOutput.contextFiles) {
      const physical = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(relocatedRoot, entry.path);
      if (!physical.startsWith(`${relocatedRoot}${path.sep}`)) {
        throw new Error(`relocated context escaped its resource root: ${entry.path}`);
      }
    }

    const showIo = memoryIO();
    await run(["--context-file", contextFile, "show", firstPath, "--json"], showIo);
    const showOutput = parseJSON(showIo.stdoutText, "show");
    if (!showOutput || typeof showOutput !== "object") throw new Error("relocated show output is incomplete");

    const recallIo = memoryIO();
    await run(["--context-file", contextFile, "wikis", "recall-debug", "--question", question, "--json"], recallIo);
    const recallOutput = parseJSON(recallIo.stdoutText, "recall");
    if (!Array.isArray(recallOutput.matches) || !Array.isArray(recallOutput.contextFiles)) {
      throw new Error("relocated recall output is incomplete");
    }

    const generated = [
      path.join(buildRoot, ".harness", "index", "wikis-index.json"),
      path.join(buildRoot, ".harness", "index", "wikis-runtime-index.json"),
      path.join(buildRoot, "resource-manifest.json"),
    ];
    for (const filePath of generated) {
      const text = readFileSync(filePath, "utf8");
      if (text.includes(source) || text.includes(buildRoot) || text.includes(relocatedRoot)) {
        throw new Error(`generated resource file contains an absolute build path: ${filePath}`);
      }
      if (/\/Users\/[^\s"']+|\/home\/[^\s"']+|[A-Za-z]:[\\/]/.test(text)) {
        throw new Error(`generated resource file contains an absolute path: ${filePath}`);
      }
    }
    return {
      ok: true,
      sourceRoot: source,
      revision: pinned.actual,
      checks: checks.map((result) => ({ check: result.check, totalErrors: result.totalErrors })),
      docCount: built.docCount,
      recallCount: built.recallCount,
      runtimeDocCount: built.runtimeDocCount,
      question,
      shownPath: shown.path,
      contextFileCount: contextOutput.contextFiles.length,
      recallMatchCount: recallOutput.matches.length,
      responseFileCount: response.contextFiles.length,
    };
  } finally {
    if (!keep) rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writeContext(tempRoot, context, name) {
  const contextPath = path.join(tempRoot, name);
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  return contextPath;
}

function memoryIO() {
  let stdout = "";
  let stderr = "";
  return {
    stdin: Buffer.alloc(0),
    stdout: { write(value) { stdout += String(value); } },
    stderr: { write(value) { stderr += String(value); } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

function parseJSON(text, label) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    throw new Error(`expected JSON output for ${label}, got: ${String(text || "").slice(0, 240)}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let sourceRoot = defaultSourceRoot;
  let json = false;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--source-root") {
      sourceRoot = String(argv[++index] || "");
    } else if (token === "--json") {
      json = true;
    } else if (token === "--keep") {
      keep = true;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  const report = await verifyWikiRelocation({ sourceRoot, keep });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`wikis relocation ok: revision=${report.revision} docs=${report.docCount} recall=${report.recallCount}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
