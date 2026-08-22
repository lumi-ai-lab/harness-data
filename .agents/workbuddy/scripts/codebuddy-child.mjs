#!/usr/bin/env node
/**
 * M0: independent CodeBuddy CLI child launcher for html-report Stage Runner.
 *
 * A child is a one-shot `codebuddy -p` invocation pinned to a fixed role/model,
 * with all built-in tools disabled and a sanitized environment, that returns
 * one JSON object on stdout. `--json-schema` is only a hint to the model
 * (verified: codebuddy does NOT enforce it) — the Runner validates the output
 * itself via validateJsonSchema + role/taskId/cardId/evidence checks.
 *
 * Contract (docs/implementer/html-report-stage-runner-alignment-2026-08-22.md §4):
 *  - exit code 0 + no timeout + output JSON that parses and matches the schema;
 *  - no QDM credentials, no shell/file/agent tools, no write access to the
 *    official session.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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

/** Minimal JSON Schema draft-07 subset validator (reused from prior codebuddy-process). */
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
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${pointer}: below minLength`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${pointer}: above maxLength`);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${pointer}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${pointer}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${pointer}: below minItems`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${pointer}: above maxItems`);
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
  "CODEBUDDY_OAUTH_TOKEN", "HARNESS_AUTH_BLOB", "HARNESS_AUTH_BLOB_FILE",
  "LUMI_REQUESTER_CONTEXT_DIR", "QDM_INDICATORS_TOKEN", "QDM_METRIC_TOKEN",
]);

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactChildOutput(value, sensitiveValues = []) {
  let redacted = redactMetricSecrets(value)
    .replace(/(HARNESS_AUTH_BLOB|HARNESS_AUTH_BLOB_FILE|LUMI_REQUESTER_CONTEXT_DIR|QDM_INDICATORS_TOKEN|QDM_METRIC_TOKEN)=[^\s]+/g, "$1=<redacted>");
  for (const secret of sensitiveValues) {
    redacted = redacted.replace(new RegExp(escapedRegExp(secret), "g"), "<redacted-sensitive-source>");
  }
  return redacted;
}

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

export function buildCodeBuddyChildArgs({ cli, prompt, schema, sessionId, model = CODEBUDDY_CHILD_MODEL, tools = [] }) {
  if (!isAbsolute(cli)) throw new Error("codebuddy CLI path must be absolute");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("child prompt must be non-empty");
  if (!isObject(schema)) throw new Error("child schema must be one object");
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) {
    throw new Error(`child sessionId must be a safe identifier, got ${JSON.stringify(sessionId)}`);
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

/**
 * Launch one CodeBuddy child and return { status, code?, value?, exitCode?,
 * timedOut?, message, stdout, stderr }. Never throws for a failed child — it
 * returns a structured failure so the Runner can record an attempt without
 * polluting the official session.
 */
export async function runCodeBuddyChild({
  prompt, schema, sessionId, cli, cwd, env = process.env,
  model = CODEBUDDY_CHILD_MODEL, tools = [], timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (cli) {
    if (!isAbsolute(cli) || !existsSync(cli)) throw new Error(`codebuddy CLI is not an existing absolute path: ${cli}`);
  }
  const resolvedCli = cli || resolveCodeBuddyCli(env);
  const { command, args } = buildCodeBuddyChildArgs({ cli: resolvedCli, prompt, schema, sessionId, model, tools });
  const environment = sanitizeCodeBuddyEnvironment({ ...env });
  const sensitiveValues = [];
  const redact = (value) => redactChildOutput(value, sensitiveValues);
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    const child = spawn(command, args, {
      cwd: cwd && isAbsolute(cwd) ? cwd : process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { }
    }, Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (stdout.length + stderr.length + text.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        try { child.kill("SIGKILL"); } catch { }
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (stdout.length + stderr.length + text.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        try { child.kill("SIGKILL"); } catch { }
        return;
      }
      stderr += text;
    });
    child.on("error", (error) => finish({
      status: "failed", code: "transport_unavailable", exitCode: null, timedOut: false,
      message: redact(`Cannot start CodeBuddy: ${error.message || error}`), stdout: redact(stdout), stderr: redact(stderr),
    }));
    child.on("close", (exitCode) => {
      const redactedOut = redact(stdout);
      if (timedOut) {
        finish({ status: "failed", code: "timed_out", exitCode, timedOut: true, message: "CodeBuddy child timed out.", stdout: redactedOut, stderr: redact(stderr) });
        return;
      }
      if (overflow) {
        finish({ status: "failed", code: "output_overflow", exitCode, timedOut: false, message: "CodeBuddy child output exceeded the safety limit.", stdout: redactedOut, stderr: redact(stderr) });
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
