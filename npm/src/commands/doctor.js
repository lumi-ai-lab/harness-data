import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { findWorkspaceDir, readWorkspaceState } from "../lib/paths.js";
import { binaryName, isExecutable } from "../lib/platform.js";
import { concreteAgentNames, qdmCliBinaries, readAuthzFromHarnessConfig } from "../lib/config.js";
import { packageVersion } from "../lib/package.js";
import {
  codeBuddyMinimumVersion,
  detectCodeBuddyVersion,
  detectWorkBuddyPluginEnabled,
  detectWorkBuddyVersion,
  inspectWorkBuddyAuth,
  inspectWorkBuddyPlugin,
  versionAtLeast,
  workBuddyAuthMinimumVersion,
  workBuddyMinimumVersion,
  workBuddyPluginRel,
} from "../lib/workbuddy.js";

function agentOk(workspace, name) {
  const target = path.join(workspace, `.${name}`);
  const source = path.join(workspace, "agents", name);
  if (!fs.existsSync(target) || !fs.existsSync(source)) return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(source);
  } catch {
    return false;
  }
}

function codexHooksStatus(workspace) {
  const hooksFile = path.join(workspace, "agents", "codex", "hooks.json");
  const shimFile = path.join(workspace, "agents", "codex", "hooks", "cli-shim.mjs");
  if (!fs.existsSync(hooksFile)) return { ok: false, detail: "agents/codex/hooks.json is missing" };
  if (process.platform === "win32" && !fs.existsSync(shimFile)) {
    return { ok: false, detail: "agents/codex/hooks/cli-shim.mjs is missing" };
  }
  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {
    return { ok: false, detail: "agents/codex/hooks.json is invalid JSON" };
  }
  const expected = {
    UserPromptSubmit: "context --format codex-hook",
    PreToolUse: "authz-hook --agent codex",
    PostToolUse: "posttool --format codex-hook",
  };
  for (const [event, args] of Object.entries(expected)) {
    const commands = (hooks.hooks?.[event] || []).flatMap((entry) => (entry.hooks || []).map((hook) => hook.command).filter((command) => typeof command === "string"));
    const matches = commands.filter((command) => command.includes(args));
    if (matches.length !== 1) return { ok: false, detail: `${event} must contain exactly one ${args} hook` };
    if (process.platform === "win32" && !matches[0].includes("cli-shim.mjs")) {
      return { ok: false, detail: `${event} must use cli-shim.mjs on Windows` };
    }
    if (process.platform !== "win32" && !matches[0].includes("bash -c")) {
      return { ok: false, detail: `${event} must use the Bash hook on this platform` };
    }
  }
  return { ok: true, detail: process.platform === "win32" ? "Codex hooks and Node shim" : "Codex hooks" };
}

function configPathsValid(workspace) {
  const configDir = path.join(workspace, "config");

  // .env (POSIX export — all platforms)
  const envFile = path.join(configDir, "qdm-cli-paths.env");
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf8");
    const values = new Map([...content.matchAll(/^export\s+([A-Z0-9_]+)="([^"]+)"/gm)].map((m) => [m[1], m[2]]));
    if (values.has("QDM_METRIC_CLI") && fs.existsSync(values.get("QDM_METRIC_CLI"))) return true;
  }

  return false;
}

function selectedAgent(workspace, options = {}) {
  if (options.agent) return String(options.agent).toLowerCase();
  const state = readWorkspaceState(workspace, { userState: options.userState });
  return String(state.agent || "").toLowerCase();
}

const qdmMinimumSafeVersion = "0.1.10";
const maxAuthBlobBytes = 1 << 20;
const authEnvironmentNames = [
  "HARNESS_AUTH_BLOB",
  "HARNESS_AUTH_BLOB_FILE",
  "HARNESS_AUTH_USER_ID",
  "LUMI_REQUESTER_CONTEXT_DIR",
  "HARNESS_AUTHZ_BINDING_V1",
];

function selectedAgents(agent) {
  switch (String(agent || "").toLowerCase()) {
    case "both": return ["claude", "codex"];
    case "all": return ["claude", "codex", "pi", "openclaw", "hermes"];
    case "workbuddy": return ["workbuddy"];
    default: return agent ? [String(agent).toLowerCase()] : [];
  }
}

function cleanAuthEnvironment(options = {}) {
  const env = { ...(options.env === undefined ? process.env : options.env) };
  for (const name of authEnvironmentNames) delete env[name];
  return env;
}

function safeBlobPath(file, workspace) {
  if (!file) return { ok: false, detail: "authz.blob_file is not configured" };
  const configDir = path.join(workspace, "config");
  try {
    const configStat = fs.lstatSync(configDir);
    if (!configStat.isDirectory() || configStat.isSymbolicLink()) {
      return { ok: false, detail: "config directory contains a symbolic link or reparse point" };
    }
    const workspaceRoot = path.resolve(workspace);
    const absoluteFile = path.resolve(file);
    const relative = path.relative(workspaceRoot, absoluteFile);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      const absoluteConfig = path.resolve(configDir);
      const configRelative = path.relative(absoluteConfig, absoluteFile);
      const boundary = configRelative.startsWith("..") || path.isAbsolute(configRelative) ? workspaceRoot : absoluteConfig;
      let current = path.dirname(absoluteFile);
      while (current !== boundary && current !== path.parse(current).root) {
        if (fs.lstatSync(current).isSymbolicLink()) return { ok: false, detail: "Blob parent contains a symbolic link or reparse point" };
        current = path.dirname(current);
      }
    }
    return { ok: true, detail: "Blob parent paths are local" };
  } catch {
    return { ok: false, detail: "Blob parent path is missing or unsafe" };
  }
}

function authBlobFile(workspace, authz, options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const configured = authz?.blobFile || env.HARNESS_AUTH_BLOB_FILE || "";
  return configured ? (path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(workspace, configured)) : "";
}

function readAuthBlobSecure(file, workspace, platform = process.platform) {
  if (!file) return { regular: false, permissions: false, readable: false, detail: "authz.blob_file is not configured", blob: "" };
  const parents = safeBlobPath(file, workspace);
  if (!parents.ok) return { regular: false, permissions: false, readable: false, detail: parents.detail, blob: "" };
  let lstat;
  try {
    lstat = fs.lstatSync(file);
  } catch {
    return { regular: false, permissions: false, readable: false, detail: "Blob is missing or unreadable", blob: "" };
  }
  const regular = lstat.isFile() && !lstat.isSymbolicLink();
  const permissions = platform === "win32" || (lstat.mode & 0o077) === 0;
  if (!regular || !permissions || lstat.size > maxAuthBlobBytes || lstat.size === 0) {
    return {
      regular,
      permissions,
      readable: false,
      detail: !regular ? "Blob must be a regular non-link file" : (!permissions ? "Blob POSIX mode must be <= 0600" : "Blob is empty or too large"),
      blob: "",
    };
  }

  let fd;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (platform === "win32" && fs.realpathSync.native(file).toLowerCase() !== path.resolve(file).toLowerCase()) {
      return { regular, permissions, readable: false, detail: "Blob is a reparse point", blob: "" };
    }
    if (!opened.isFile() || opened.size > maxAuthBlobBytes || opened.size === 0 ||
        (platform !== "win32" && (opened.mode & 0o077) !== 0)) {
      return { regular, permissions, readable: false, detail: "Blob changed or is not a safe regular file", blob: "" };
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const reread = fs.fstatSync(fd);
    if (offset !== buffer.length || reread.dev !== opened.dev || reread.ino !== opened.ino ||
        reread.size !== opened.size || reread.mtimeMs !== opened.mtimeMs || reread.ctimeMs !== opened.ctimeMs) {
      return { regular, permissions, readable: false, detail: "Blob changed while being read", blob: "" };
    }
    const blob = buffer.toString("utf8").trim();
    return {
      regular,
      permissions,
      readable: Boolean(blob),
      detail: blob ? "safe Blob read" : "Blob is empty",
      blob,
    };
  } catch {
    return { regular, permissions, readable: false, detail: "Blob is missing or unreadable", blob: "" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseQdmVersion(output) {
  return [...String(output || "").matchAll(/(?:^|[^\d])v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?\b/g)].at(-1)?.[1] || "";
}

async function qdmProbe(cli, args, options = {}) {
  try {
    return await run(cli, args, {
      cwd: options.cwd,
      env: cleanAuthEnvironment(options),
      unsetEnv: authEnvironmentNames,
      allowFailure: true,
      sensitiveArgs: options.sensitiveArgs || [],
    });
  } catch {
    return { code: null, stdout: "", stderr: "" };
  }
}

function piAuthBindingStatus(workspace) {
  const files = [
    "agents/pi/extensions/qdm-harness/index.ts",
    "agents/pi/extensions/qdm-harness/authz-inject.mjs",
    "agents/pi/extensions/qdm-harness/authz-store.mjs",
  ];
  if (!files.every((file) => fs.existsSync(path.join(workspace, file)))) {
    return { ok: false, detail: "Pi authz extension is incomplete" };
  }
  try {
    const source = files.map((file) => fs.readFileSync(path.join(workspace, file), "utf8")).join("\n");
    if (!source.includes("applyAuthzToToolCall") || !source.includes("AuthzStateStore") || !source.includes("auth-blob")) {
      return { ok: false, detail: "Pi authz extension does not bind a session Blob" };
    }
  } catch {
    return { ok: false, detail: "Pi authz extension is unreadable" };
  }
  return { ok: true, detail: "Pi session binding and authz injection" };
}

export async function collectDoctor(workspace, options = {}) {
  const checks = [];
  const add = (name, ok, detail = "", status = ok ? "pass" : "fail") => checks.push({ name, ok, detail, status });

  add("runtime", fs.existsSync(path.join(workspace, "bootstrap", "cli-manifest.json")) && fs.existsSync(path.join(workspace, "agents")), workspace);
  add("wikis/index.md", fs.existsSync(path.join(workspace, "wikis", "index.md")));
  add("wikis/metrics", fs.existsSync(path.join(workspace, "wikis", "metrics")));
  add("wikis/reports", fs.existsSync(path.join(workspace, "wikis", "reports")));
  add("wikis/dims", fs.existsSync(path.join(workspace, "wikis", "dims")));
  add("wikis/rules", fs.existsSync(path.join(workspace, "wikis", "rules")));
  for (const binary of qdmCliBinaries) {
    add(`bin/${binary}`, isExecutable(path.join(workspace, "bin", binaryName(binary))));
  }
  add("config/harness-config.yaml", fs.existsSync(path.join(workspace, "config", "harness-config.yaml")));
  const authz = readAuthzFromHarnessConfig(path.join(workspace, "config", "harness-config.yaml"));
  if (authz && authz.mode === "on" && !authz.allowLocalBlob) {
    add("authz allow_local_blob", true, "local Blob fallback disabled; session/host Blob required");
  } else {
    add("authz allow_local_blob", true);
  }

  const metricCli = path.join(workspace, "bin", binaryName("qdm-metric-cli"));
  const qdmVersionResult = isExecutable(metricCli)
    ? await qdmProbe(metricCli, ["version"], { ...options, cwd: workspace })
    : { code: null, stdout: "", stderr: "" };
  const qdmVersion = qdmVersionResult.code === 0 ? parseQdmVersion(`${qdmVersionResult.stdout}\n${qdmVersionResult.stderr}`) : "";
  add(
    `qdm version >= ${qdmMinimumSafeVersion}`,
    Boolean(qdmVersion && versionAtLeast(qdmVersion, qdmMinimumSafeVersion)),
    qdmVersion || "version unavailable",
  );
  const noCredential = isExecutable(metricCli)
    ? await qdmProbe(metricCli, ["auth", "describe"], { ...options, cwd: workspace })
    : { code: null };
  add(
    "qdm auth describe without credentials",
    noCredential.code === 77,
    `exit ${noCredential.code ?? "unavailable"}`,
  );

  const blobFile = authBlobFile(workspace, authz, options);
  const blob = readAuthBlobSecure(blobFile, workspace, options.platform || process.platform);
  add("auth Blob regular non-link", blob.regular, blob.detail);
  add("auth Blob POSIX mode <=0600", blob.permissions, blob.detail);
  add("auth Blob safe read", blob.readable, blob.detail);
  const withCredential = blob.readable && isExecutable(metricCli)
    ? await qdmProbe(metricCli, ["auth", "describe", "--auth-blob", blob.blob], { ...options, cwd: workspace, sensitiveArgs: [3] })
    : { code: null };
  add(
    "qdm auth describe with Blob",
    withCredential.code === 0,
    `exit ${withCredential.code ?? "unavailable"}`,
  );

  add("config/qdm-cli-paths.env", fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")));
  add("config CLI paths", configPathsValid(workspace));
  add("legacy qdm-cmr-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-cmr-cli"))));
  add("legacy qdm-indicators-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-indicators-cli"))));
  add("legacy qdm-sql-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-sql-cli"))));
  add("legacy cas-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("cas-cli"))));

  const configuredAgent = selectedAgent(workspace, options);
  for (const agent of selectedAgents(configuredAgent)) {
    if (agent === "workbuddy") continue;
    const installed = agentOk(workspace, agent);
    add(`Agent install .${agent}`, installed, `agents/${agent}`);
    if (["claude", "openclaw", "hermes"].includes(agent)) {
      add(`Agent authz .${agent}`, true, "authz unavailable: no confirmed pre-tool authorization API", "warning");
    } else if (agent === "pi") {
      const binding = piAuthBindingStatus(workspace);
      add("Pi authz binding", binding.ok, binding.detail);
    }
  }
  const workBuddySelected = configuredAgent === "workbuddy";
  if (workBuddySelected && authz?.mode === "on") {
    const platform = options.platform || process.platform;
    const supported = platform === "darwin" || platform === "win32";
    const platformName = platform === "darwin" ? "macOS" : (platform === "win32" ? "Windows" : platform);
    add("WorkBuddy auth platform", supported, supported ? platformName : `${platform}; auth hook supports macOS and Windows only`);
    const auth = inspectWorkBuddyAuth(workspace, authz, { ...options, platform });
    add("WorkBuddy auth source", auth.ok, auth.detail);
  }
  let workBuddy = null;
  if (fs.existsSync(path.join(workspace, workBuddyPluginRel))) {
    workBuddy = inspectWorkBuddyPlugin(workspace);
    add("WorkBuddy plugin package", workBuddy.prepared, workBuddy.prepared ? `${workBuddyPluginRel} v${workBuddy.version}; marketplace=${workBuddy.marketplaceName}` : workBuddy.errors.join("; "));
    add(
      "WorkBuddy plugin version",
      workBuddy.versionMatchesPackage || !workBuddySelected,
      workBuddy.versionMatchesPackage
        ? workBuddy.version
        : `${workBuddy.version || "missing"}; installer=${packageVersion()} (update runtime before selecting WorkBuddy)`,
    );
    if (workBuddySelected) {
      const clientVersion = detectWorkBuddyVersion(options);
      if (clientVersion) {
        const supported = versionAtLeast(clientVersion);
        add(
          `WorkBuddy version >= ${workBuddyMinimumVersion}`,
          supported,
          supported ? clientVersion : `${clientVersion}; upgrade required before selecting WorkBuddy`,
        );
      } else {
        add(`WorkBuddy version >= ${workBuddyMinimumVersion}`, true, "client not detected; verify manually", "warning");
      }
      if (authz?.mode === "on") {
        add(
          `WorkBuddy auth version >= ${workBuddyAuthMinimumVersion}`,
          Boolean(clientVersion && versionAtLeast(clientVersion, workBuddyAuthMinimumVersion)),
          clientVersion || "client not detected",
        );
        const codeBuddyVersion = detectCodeBuddyVersion(options);
        if (codeBuddyVersion) {
          const supported = versionAtLeast(codeBuddyVersion, codeBuddyMinimumVersion);
          add(
            `CodeBuddy CLI version >= ${codeBuddyMinimumVersion}`,
            supported,
            supported ? codeBuddyVersion : `${codeBuddyVersion}; upgrade WorkBuddy before enabling authz`,
          );
        } else {
          add(`CodeBuddy CLI version >= ${codeBuddyMinimumVersion}`, false, "embedded CLI not detected");
        }
      }
      const enablement = detectWorkBuddyPluginEnabled({ ...options, workspace });
      if (enablement.enabled) {
        add("WorkBuddy plugin enablement", true, `enabled in ${enablement.settingsPath}`);
      } else if (enablement.explicitlyDisabled) {
        add("WorkBuddy plugin enablement", false, `explicitly disabled in ${enablement.settingsPath}; enable qdm-harness and reload plugins`);
      } else {
        add(
          "WorkBuddy plugin enablement",
          true,
          `not detected; install and enable qdm-harness in WorkBuddy, then reload plugins (${enablement.settingsPath})`,
          "warning",
        );
      }
    }
  }

  const codexSelected = configuredAgent === "codex" || configuredAgent === "both" || configuredAgent === "all" || fs.existsSync(path.join(workspace, ".codex"));
  const codexStatus = codexSelected ? codexHooksStatus(workspace) : null;
  if (codexSelected) add("Codex hooks", codexStatus.ok, codexStatus.detail);
  if (configuredAgent === "codex" || configuredAgent === "both" || configuredAgent === "all") {
    add("Codex authz binding", codexStatus.ok, codexStatus.detail);
  }
  if (workBuddySelected) {
    add("WorkBuddy authz binding", Boolean(workBuddy?.prepared), workBuddy?.prepared ? "shared authz-hook transport" : "Marketplace/plugin unavailable");
  }
  add("Agent hook", concreteAgentNames.some((name) => agentOk(workspace, name)) || (workBuddySelected && Boolean(workBuddy?.prepared)));
  for (const name of ["openclaw", "hermes"]) {
    if (fs.existsSync(path.join(workspace, `.${name}`))) {
      add(`Agent hook .${name}`, agentOk(workspace, name), `agents/${name}`);
    }
  }
  if (!fs.existsSync(path.join(workspace, ".harness", "index", "wikis-index.json")) &&
      !fs.existsSync(path.join(workspace, ".harness", "index", "wikis-runtime-index.json"))) {
    checks.push({ name: "wikis index", ok: true, detail: "missing; run data-harness-cli wikis build-index --skip-checks" });
  }

  return {
    workspace,
    checks
  };
}

export async function doctorCommand(options = {}) {
  const workspace = findWorkspaceDir(options.dir);
  const report = await collectDoctor(workspace, options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Harness Data runtime doctor: ${report.workspace}`);
    for (const check of report.checks) {
      const label = check.status === "warning" ? "WARN" : (check.ok ? "PASS" : "FAIL");
      console.log(`${label} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
  }
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
  return report;
}
