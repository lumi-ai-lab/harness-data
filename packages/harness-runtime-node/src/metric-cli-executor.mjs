import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadAuthzConfig,
  resolveAuthBlob,
  resolveMetricCliPath,
} from "./authz-config.mjs";
import {
  metricCliPayload,
  metricComparisonArgs,
  normalizeMetricQuery,
  queryHasMeasures,
} from "../../html-report-kernel/src/query/metric-query-contract.mjs";
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

export function metricAuthContext({ projectRoot, context = null, sessionId, environment = process.env, secretRef = null }) {
  const root = context || projectRoot;
  const { path, config } = trustedMetricCli(root, environment);
  if (config.mode !== "on") return { mode: "off", metricCli: path };
  const resolved = resolveAuthBlob({
    projectRoot: context?.workspaceRoot || projectRoot,
    config,
    sessionId,
    env: environment,
    secretRef: secretRef || context?.secretRef || null,
  });
  if (!resolved.ok) throw new Error(`METRIC_AUTH_CONTEXT_REQUIRED: ${resolved.error}`);
  return {
    mode: "on",
    metricCli: path,
    blob: resolved.blob,
    authArg: process.platform === "win32" || !resolved.sourcePath ? resolved.blob : resolved.sourcePath,
    userId: resolved.userId,
    source: resolved.source,
  };
}

function appendCommonExecuteArgs(args, normalized, { timeoutMs, authContext } = {}) {
  args.push("--output", "envelope", "--dim-labels", "only", ...metricComparisonArgs(normalized));
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    args.push("--timeout", `${Math.max(1, Math.floor(timeoutMs))}ms`);
  }
  if (authContext?.mode === "on") {
    args.push("--data-auth", "--auth-blob", authContext.authArg || authContext.blob);
  }
  return args;
}

function buildMeasuresExecuteArgs(normalized, options = {}) {
  const args = [
    "analysis",
    "execute",
    "--measures-json",
    JSON.stringify(normalized.measures),
    "--start-date",
    normalized.time.startDate,
    "--end-date",
    normalized.time.endDate,
  ];
  if (normalized.time.grain) args.push("--time-grain", normalized.time.grain);
  for (const dimension of normalized.dimensions) args.push("--agg-dim", dimension);
  for (const field of Object.keys(normalized.filters || {}).sort()) {
    const values = normalized.filters[field];
    if (Array.isArray(values) && values.length) args.push("--filter", `${field}=${values.join(",")}`);
  }
  if (normalized.scopes) args.push("--scope-json", JSON.stringify(normalized.scopes));
  if (normalized.orderBy) {
    args.push("--order-by", `${normalized.orderBy.field} ${normalized.orderBy.direction}`);
  }
  args.push("--page-size", String(normalized.pageSize));
  return appendCommonExecuteArgs(args, normalized, options);
}

export function buildMetricExecuteArgs(query, { timeoutMs, authContext } = {}) {
  const normalized = normalizeMetricQuery(query);
  if (queryHasMeasures(normalized)) {
    return buildMeasuresExecuteArgs(normalized, { timeoutMs, authContext });
  }
  return appendCommonExecuteArgs(
    [
      "analysis",
      "execute",
      "--payload-json",
      JSON.stringify(metricCliPayload(normalized)),
    ],
    normalized,
    { timeoutMs, authContext }
  );
}

export function runMetricQuery(
  query,
  { projectRoot, context = null, sessionId, timeoutMs = 600_000, environment = process.env, secretRef = null, spawn = spawnSync } = {}
) {
  const authContext = metricAuthContext({ projectRoot, context, sessionId, environment, secretRef });
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
    cwd: context?.workspaceRoot || projectRoot,
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

/**
 * Async version of runMetricQuery using child_process.spawn.
 * Does not block the Node event loop, enabling parallel CLI queries.
 * Returns a Promise resolving to the same result shape as runMetricQuery.
 */
export function runMetricQueryAsync(
  query,
  { projectRoot, context = null, sessionId, timeoutMs = 600_000, environment = process.env, secretRef = null } = {}
) {
  const authContext = metricAuthContext({ projectRoot, context, sessionId, environment, secretRef });
  const args = buildMetricExecuteArgs(query, { timeoutMs, authContext });
  const childEnv = { ...environment };
  for (const key of AUTH_SOURCE_ENV) delete childEnv[key];
  delete childEnv.QDM_INDICATORS_TOKEN;
  delete childEnv.QDM_INDICATORS_CLI;
  delete childEnv.QDM_CAS_CLI;
  const started = Date.now();
  const effectiveTimeout = Math.max(1, Math.min(600_000, Math.floor(timeoutMs)));

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let errorCode = "";
    let settled = false;

    const child = spawn(authContext.metricCli, args, {
      encoding: "utf8",
      env: childEnv,
      cwd: context?.workspaceRoot || projectRoot,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, effectiveTimeout);

    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      errorCode = error?.code || "";
      const result = {
        status: null,
        signal: null,
        errorCode,
        error: redactMetricSecrets(String(error?.message || error || "")),
        stdout: redactMetricSecrets(stdout),
        stderr: redactMetricSecrets(stderr),
        durationMs: Date.now() - started,
        authz: {
          mode: authContext.mode,
          ...(authContext.mode === "on"
            ? { userId: authContext.userId, source: authContext.source }
            : {}),
        },
      };
      resolvePromise({ ...result, timedOut: isMetricTimeout(result) });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        status: code,
        signal,
        errorCode,
        error: "",
        stdout: redactMetricSecrets(stdout),
        stderr: redactMetricSecrets(stderr),
        durationMs: Date.now() - started,
        authz: {
          mode: authContext.mode,
          ...(authContext.mode === "on"
            ? { userId: authContext.userId, source: authContext.source }
            : {}),
        },
      };
      resolvePromise({ ...result, timedOut: isMetricTimeout(result) });
    });
  });
}
