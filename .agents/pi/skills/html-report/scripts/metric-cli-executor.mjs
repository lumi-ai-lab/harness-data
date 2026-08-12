import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadAuthzConfig,
  resolveAuthBlob,
  resolveMetricCliPath,
} from "../../../extensions/qdm-harness/authz-config.mjs";
import {
  metricCliPayload,
  metricComparisonArgs,
  normalizeMetricQuery,
} from "./metric-query-contract.mjs";
import { isMetricTimeout } from "./metric-timeout.mjs";

const AUTH_SOURCE_ENV = [
  "HARNESS_AUTH_BLOB",
  "HARNESS_AUTH_BLOB_FILE",
  "HARNESS_AUTH_USER_ID",
  "LUMI_REQUESTER_CONTEXT_DIR",
];

export function redactMetricSecrets(value) {
  return String(value || "").replace(/qdm1enc\.[A-Za-z0-9_-]+/g, "<redacted-auth-blob>");
}
export function trustedMetricCli(projectRoot, environment = process.env) {
  const config = loadAuthzConfig(projectRoot, environment);
  const configured = resolveMetricCliPath(projectRoot, config, environment);
  let path;
  try {
    const configuredPath = resolve(configured);
    const configuredInfo = lstatSync(configuredPath);
    if (configuredInfo.isSymbolicLink()) throw new Error("configured path must not be a symbolic link");
    path = realpathSync(configuredPath);
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("not a regular file");
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(`QDM_METRIC_CLI_UNAVAILABLE: ${resolve(configured)} (${error.message || error})`);
  }
  return { path, config };
}

export function metricAuthContext({ projectRoot, sessionId, environment = process.env }) {
  const { path, config } = trustedMetricCli(projectRoot, environment);
  if (config.mode !== "on") return { mode: "off", metricCli: path };
  const resolved = resolveAuthBlob({
    projectRoot,
    config,
    sessionId,
    env: environment,
  });
  if (!resolved.ok) throw new Error(`METRIC_AUTH_CONTEXT_REQUIRED: ${resolved.error}`);
  return {
    mode: "on",
    metricCli: path,
    blob: resolved.blob,
    userId: resolved.userId,
    source: resolved.source,
  };
}

export function buildMetricExecuteArgs(query, { timeoutMs, authContext } = {}) {
  const normalized = normalizeMetricQuery(query);
  const args = [
    "analysis",
    "execute",
    "--payload-json",
    JSON.stringify(metricCliPayload(normalized)),
    "--output",
    "data",
    ...metricComparisonArgs(normalized),
  ];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    args.push("--timeout", `${Math.max(1, Math.floor(timeoutMs))}ms`);
  }
  if (authContext?.mode === "on") {
    args.push("--data-auth", "--auth-blob", authContext.blob);
  }
  return args;
}

export function runMetricQuery(
  query,
  { projectRoot, sessionId, timeoutMs = 600_000, environment = process.env, spawn = spawnSync } = {}
) {
  const authContext = metricAuthContext({ projectRoot, sessionId, environment });
  const args = buildMetricExecuteArgs(query, { timeoutMs, authContext });
  const childEnv = { ...environment };
  for (const key of AUTH_SOURCE_ENV) delete childEnv[key];
  delete childEnv.QDM_INDICATORS_TOKEN;
  delete childEnv.QDM_INDICATORS_CLI;
  delete childEnv.QDM_CAS_CLI;
  const started = Date.now();
  const out = spawn(authContext.metricCli, args, {
    encoding: "utf8",
    env: childEnv,
    timeout: Math.max(1, Math.min(600_000, Math.floor(timeoutMs))),
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    cwd: projectRoot,
  });
  const result = {
    status: out.status,
    signal: out.signal,
    errorCode: out.error?.code || "",
    error: redactMetricSecrets(out.error ? String(out.error.message || out.error) : ""),
    stdout: redactMetricSecrets(out.stdout || ""),
    stderr: redactMetricSecrets(out.stderr || ""),
    durationMs: Date.now() - started,
    authz: {
      mode: authContext.mode,
      ...(authContext.mode === "on"
        ? { userId: authContext.userId, source: authContext.source }
        : {}),
    },
  };
  return { ...result, timedOut: isMetricTimeout(result) };
}
