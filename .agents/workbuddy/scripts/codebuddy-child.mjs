#!/usr/bin/env node
/**
 * M0: independent CodeBuddy CLI child launcher for html-report Stage Runner.
 *
 * A child is a one-shot `codebuddy -p` invocation pinned to a fixed role/model,
 * with all built-in tools disabled (`--tools ""`) and a sanitized environment,
 * that returns one JSON object on stdout. `--json-schema` is only a hint to the
 * model (verified: codebuddy does NOT enforce it) — the Runner validates the
 * output itself via validateJsonSchema + role/taskId/cardId/evidence checks.
 *
 * This module adapts the battle-tested launcher machinery from the reference
 * implementation (docs/implementer/ref-b345-workbuddy/codebuddy-process.mjs):
 * launcher resolution (WorkBuddy.app / development CLI), process-group kill,
 * AbortSignal cancellation, provider-quota / turn-budget detection, output
 * overflow guard, environment sanitization and credential redaction. The one
 * deliberate divergence is the output contract: the reference parsed a
 * stream-json transcript's `result.structured_output`, which does NOT exist
 * when tools are disabled (verified on codebuddy 2.137.1 — the JSON arrives in
 * the final assistant text). So this child keeps plain `-p` output and extracts
 * the JSON object directly from stdout.
 *
 * Contract (docs/implementer/html-report-stage-runner-alignment-2026-08-22.md §4):
 *  - exit code 0 + no timeout + output JSON that parses and matches the schema;
 *  - no QDM credentials, no shell/file/agent tools, no write access to the
 *    official session.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { redactMetricSecrets } from "../../../packages/harness-runtime-node/src/metric-cli-executor.mjs";

export const CODEBUDDY_CHILD_TRANSPORT = "codebuddy-child";
export const CODEBUDDY_CHILD_MODEL = "custom-local:gpt-5.5";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Resolve the codebuddy CLI path: env CODEBUDDY_CLI, else PATH. */
export function resolveCodeBuddyCli(env = process.env) {
  const explicit = typeof env.CODEBUDDY_CLI === "string" ? env.CODEBUDDY_CLI.trim() : "";
  if (explicit) {
    if (!isAbsolute(explicit) || !existsSync(explicit)) {
      throw new Error(`CODEBUDDY_CLI must be an existing absolute path, got ${JSON.stringify(explicit)}`);
    }
    return resolve(explicit);
  }
  const parts = String(env.PATH || "").split(":").filter(Boolean);
  const candidate = parts.map((part) => join(part, "codebuddy")).find((path) => existsSync(path));
  if (!candidate) throw new Error("codebuddy CLI not found on PATH; set CODEBUDDY_CLI to the absolute launcher path");
  return resolve(candidate);
}

// ── Launcher resolution (adapted from ref codebuddy-process.mjs) ─────────────

function normalizeWorkBuddyAppRoot(value) {
  const candidate = resolve(value);
  const resources = dirname(candidate);
  const contents = dirname(resources);
  if (
    basename(candidate).toLowerCase() === "app.asar"
    && basename(resources).toLowerCase() === "resources"
    && basename(contents).toLowerCase() === "contents"
  ) {
    return dirname(contents);
  }
  return candidate;
}

function codeBuddyVersion(packagePath) {
  try {
    const packageJSON = JSON.parse(readFileSync(packagePath, "utf8"));
    return String(packageJSON?.publishConfig?.customPackage?.version || "").trim();
  } catch {
    return "";
  }
}

/** Resolve the CodeBuddy CLI bundled inside WorkBuddy.app (macOS). */
export function resolveWorkBuddyCodeBuddy({ appPath = "/Applications/WorkBuddy.app", platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("WorkBuddy CodeBuddy launcher resolution currently supports macOS only");
  const appRoot = normalizeWorkBuddyAppRoot(appPath);
  const cliRoot = join(appRoot, "Contents", "Resources", "app.asar.unpacked", "cli");
  const launcherPath = join(cliRoot, "bin", "codebuddy");
  try {
    if (!statSync(launcherPath).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new Error(`WorkBuddy CodeBuddy launcher is unavailable: ${error.message || error}`);
  }
  const version = codeBuddyVersion(join(cliRoot, "package.json"));
  if (!version) throw new Error("WorkBuddy CodeBuddy launcher has no package version");
  return { launcherPath, nodePath: process.execPath, version };
}

/** Resolve a development CodeBuddy CLI launcher path. */
export function resolveDevelopmentCodeBuddy({ launcherPath, nodePath = process.execPath } = {}) {
  if (!isAbsolute(launcherPath) || !existsSync(launcherPath)) {
    throw new Error("development CodeBuddy launcherPath must be an existing absolute path");
  }
  if (!isAbsolute(nodePath) || !existsSync(nodePath)) {
    throw new Error("development CodeBuddy nodePath must be an existing absolute path");
  }
  return { launcherPath: resolve(launcherPath), nodePath: resolve(nodePath) };
}

// ── Minimal JSON Schema draft-07 validator (fuller version from ref) ─────────

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asTypes(value) {
  return Array.isArray(value) ? value : [value];
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isSafeInteger(value);
  return false;
}

export function validateJsonSchema(value, schema, pointer = "$") {
  if (!isObject(schema)) return { ok: false, errors: [`${pointer}: schema must be an object`] };
  const errors = [];
  if (schema.const !== undefined && !sameJson(value, schema.const)) errors.push(`${pointer}: must equal const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(value, item))) {
    errors.push(`${pointer}: must equal one enum value`);
  }
  if (schema.type !== undefined && !asTypes(schema.type).some((type) => matchesType(value, type))) {
    errors.push(`${pointer}: must be ${asTypes(schema.type).join(" or ")}`);
    return { ok: false, errors };
  }
  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) errors.push(...validateJsonSchema(value, item, pointer).errors);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((item) => validateJsonSchema(value, item, pointer).ok).length;
    if (matches !== 1) errors.push(`${pointer}: must match exactly one oneOf branch`);
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${pointer}: below minLength`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${pointer}: above maxLength`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${pointer}: does not match pattern`);
      } catch {
        errors.push(`${pointer}: schema pattern is invalid`);
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${pointer}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${pointer}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${pointer}: below minItems`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${pointer}: above maxItems`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${pointer}: items must be unique`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, `${pointer}[${index}]`).errors));
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) errors.push(`${pointer}: missing ${key}`);
      }
    }
    for (const [key, item] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validateJsonSchema(value[key], item, `${pointer}.${key}`).errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${pointer}: unexpected ${key}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── Environment sanitization + credential redaction (from ref) ───────────────

/** Keep only env vars the child needs; never leak QDM/Harness credentials. */
export function sanitizeCodeBuddyEnvironment(environment = process.env) {
  const allowed = new Set([
    "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER",
    "CODEBUDDY_CONFIG_DIR", "CODEBUDDY_DISABLE_AUTOUPDATER", "CODEBUDDY_OAUTH_TOKEN",
    "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_EXTRA_PATHS", "WORKBUDDY_APP_PATH",
  ]);
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    sanitized[key] = value;
  }
  return sanitized;
}

const SENSITIVE_ENVIRONMENT = new Set([
  "CODEBUDDY_OAUTH_TOKEN",
  "HARNESS_AUTH_BLOB",
  "HARNESS_AUTH_BLOB_FILE",
  "LUMI_REQUESTER_CONTEXT_DIR",
  "QDM_INDICATORS_TOKEN",
  "QDM_METRIC_TOKEN",
]);

export function codeBuddySensitiveValues(environment = {}) {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_ENVIRONMENT.has(key) && typeof value === "string" && value)
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactCodeBuddyOutput(value, sensitiveValues = []) {
  let redacted = redactMetricSecrets(value)
    .replace(/(HARNESS_AUTH_BLOB|HARNESS_AUTH_BLOB_FILE|LUMI_REQUESTER_CONTEXT_DIR|QDM_INDICATORS_TOKEN|QDM_METRIC_TOKEN)=[^\s]+/g, "$1=<redacted>");
  for (const secret of sensitiveValues) {
    redacted = redacted.replace(new RegExp(escapedRegExp(secret), "g"), "<redacted-sensitive-source>");
  }
  return redacted;
}

export function redactChildOutput(value, sensitiveValues = []) {
  return redactCodeBuddyOutput(value, sensitiveValues);
}

// ── Output extraction (new contract: plain -p JSON on stdout) ────────────────

/** Extract the first top-level JSON object from codebuddy stdout (model may add prose). */
export function extractJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── Command building (new contract: --tools "" disables all built-in tools) ──

export function buildCodeBuddyChildArgs({ cli, prompt, schema, sessionId, model = CODEBUDDY_CHILD_MODEL, tools = [] }) {
  if (!isAbsolute(cli)) throw new Error("codebuddy CLI path must be absolute");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("child prompt must be non-empty");
  if (!isObject(schema)) throw new Error("child schema must be one object");
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) {
    throw new Error(`child sessionId must be a safe identifier, got ${JSON.stringify(sessionId)}`);
  }
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
    throw new Error("child tools must be an array of names");
  }
  const args = [
    cli, "-p",
    "--json-schema", JSON.stringify(schema),
    "--model", String(model),
    "--session-id", sessionId,
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
    "--tools", tools.join(","),
    prompt,
  ];
  return { command: cli, args };
}

// ── Process lifecycle (process-group kill, overflow guard from ref) ──────────

function stopProcessGroup(child) {
  if (!child || !child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); } catch { }
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { }
    }, 1_000).unref();
    return;
  }
  try { child.kill("SIGTERM"); } catch { }
}

function providerFailureFromOutput(output) {
  const text = String(output || "");
  if (/\b429\b[\s\S]{0,200}(?:quota|额度|limit|用尽|不足)|(?:quota|额度)[\s\S]{0,200}(?:\b429\b|exhausted|用尽)/iu.test(text)) {
    return { code: "provider_quota_exhausted", message: "CodeBuddy provider quota is exhausted." };
  }
  return null;
}

function turnBudgetExhaustedFromOutput(output) {
  return /max turns\s*\(\d+\)\s*exceeded/i.test(String(output || ""));
}

/**
 * Launch one CodeBuddy child and return { status, code?, value?, exitCode?,
 * timedOut?, message, stdout, stderr }. Never throws for a failed child — it
 * returns a structured failure so the Runner can record an attempt without
 * polluting the official session. Accepts an AbortSignal for cancellation.
 */
export async function runCodeBuddyChild({
  prompt, schema, sessionId, cli, cwd, env = process.env,
  model = CODEBUDDY_CHILD_MODEL, tools = [], timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  const resolvedCli = cli || resolveCodeBuddyCli(env);
  const { command, args } = buildCodeBuddyChildArgs({ cli: resolvedCli, prompt, schema, sessionId, model, tools });
  const requestedEnvironment = { ...env };
  const sensitiveValues = codeBuddySensitiveValues(requestedEnvironment);
  const environment = sanitizeCodeBuddyEnvironment(requestedEnvironment);
  const redact = (value) => redactCodeBuddyOutput(value, sensitiveValues);
  if (signal?.aborted) {
    return { status: "failed", code: "cancelled", timedOut: false, message: "CodeBuddy child was cancelled before launch.", stdout: "", stderr: "" };
  }
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = Boolean(signal?.aborted);
    let overflow = false;
    let providerFailure = null;
    let turnBudgetExhausted = false;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    };
    const child = spawn(command, args, {
      cwd: cwd && isAbsolute(cwd) ? cwd : process.cwd(),
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const onAbort = () => {
      cancelled = true;
      stopProcessGroup(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessGroup(child);
    }, Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    const append = (target, chunk) => {
      if (stdout.length + stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        stopProcessGroup(child);
        return target;
      }
      return target + chunk;
    };
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = append(stdout, text);
      providerFailure ||= providerFailureFromOutput(stdout);
      turnBudgetExhausted ||= turnBudgetExhaustedFromOutput(stdout);
      if (providerFailure) stopProcessGroup(child);
      if (turnBudgetExhausted) stopProcessGroup(child);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, String(chunk));
    });
    child.on("error", (error) => finish({
      status: "failed", code: "transport_unavailable", exitCode: null, timedOut: false,
      message: redact(`Cannot start CodeBuddy: ${error.message || error}`), stdout: redact(stdout), stderr: redact(stderr),
    }));
    child.on("close", (exitCode, processSignal) => {
      const redactedOut = redact(stdout);
      if (timedOut) {
        finish({ status: "failed", code: "timed_out", exitCode, timedOut: true, message: "CodeBuddy child timed out.", stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      if (cancelled) {
        finish({ status: "failed", code: "cancelled", exitCode, timedOut: false, message: "CodeBuddy child was cancelled.", stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      if (overflow) {
        finish({ status: "failed", code: "output_overflow", exitCode, timedOut: false, message: "CodeBuddy child output exceeded the safety limit.", stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      if (providerFailure) {
        finish({ status: "failed", ...providerFailure, exitCode, timedOut: false, signal: processSignal, stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      if (turnBudgetExhausted) {
        finish({ status: "failed", code: "turn_budget_exhausted", exitCode, timedOut: false, message: "CodeBuddy exhausted its turn budget.", signal: processSignal, stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      if (exitCode !== 0) {
        finish({ status: "failed", code: "child_exit_nonzero", exitCode, timedOut: false, message: `CodeBuddy child exited with code ${exitCode}.`, stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      const parsed = extractJsonObject(redactedOut);
      if (parsed === null) {
        finish({ status: "failed", code: "json_parse_failed", exitCode, timedOut: false, message: "CodeBuddy child did not return a JSON object.", stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      const validated = validateJsonSchema(parsed, schema);
      if (!validated.ok) {
        finish({ status: "failed", code: "schema_violation", exitCode, timedOut: false, message: `CodeBuddy child output failed schema validation: ${validated.errors.join("; ")}`, stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      finish({ status: "completed", code: "ok", exitCode, timedOut: false, value: parsed, message: "ok", stdout: redactedOut, stderr: redact(stderr) });
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    const cli = resolveCodeBuddyCli();
    process.stdout.write(`${JSON.stringify({ ok: true, cli, version: statSync(cli)?.size ? "present" : "missing" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2)}\n`);
    process.exit(1);
  }
}
