import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../lib/exec.js";
import { packageVersion } from "../lib/package.js";
import { binaryName, isExecutable, platformKey } from "../lib/platform.js";
import { setupCommand } from "./setup.js";

const PLUGIN_ID = "qdm-harness-qwenpaw";
const actions = new Set(["setup", "doctor", "migrate", "update", "install", "uninstall"]);
// Mirrors DEFAULT_AGENT_SCOPE_PATTERNS in .agents/qwenpaw/qdm_config.py.  The
// host registers one plugin's hooks and tools in every workspace, so the
// plugin narrows itself back down with these agent id patterns.
const DEFAULT_AGENT_SCOPE_PATTERNS = ["harness-data-*"];
const TOOL_POLICIES = new Set(["preserve", "strict"]);
// What a strictly governed QDM agent may keep enabled. The host reads a missing
// ``enabled`` as enabled, so this list is an allow-list, not a deny-list.
const QDM_ALLOWED_TOOLS = {
  get_current_time: "获取当前时间，用于相对日期计算。",
  qdm_query: "执行受限的 QDM 指标查询；只接受已注入 QDM 手册中的指标代码和参数。",
  qdm_scope_summary: "返回当前渠道用户的脱敏 QDM 数据权限摘要。",
};
const AGENT_SCOPE_PATTERN = /^(\*|[A-Za-z0-9][A-Za-z0-9_.*?-]*)$/;
const MAX_AGENT_SCOPE_PATTERNS = 32;
const MAX_AGENT_SCOPE_PATTERN_CHARS = 64;

function normalizeAgentScope(values) {
  const patterns = [];
  for (const value of values.flat().flatMap((item) => String(item ?? "").split(","))) {
    const pattern = value.trim();
    if (!pattern) continue;
    if (pattern.length > MAX_AGENT_SCOPE_PATTERN_CHARS || !AGENT_SCOPE_PATTERN.test(pattern)) {
      throw new Error(`invalid QwenPaw agent id pattern: ${pattern}`);
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  if (patterns.length > MAX_AGENT_SCOPE_PATTERNS) throw new Error("too many --enabled-agents patterns");
  return patterns;
}

function agentScopeAllows(patterns, agentId) {
  return patterns.some((pattern) => {
    if (pattern === agentId) return true;
    if (!pattern.includes("*") && !pattern.includes("?")) return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(agentId || "");
  });
}

function qwenPawWorkingDir(options) {
  const explicit = String(options.qwenpawWorkingDir || "").trim();
  return explicit || path.join(os.homedir(), ".qwenpaw");
}

function listQwenPawAgentIds(options) {
  const file = path.join(qwenPawWorkingDir(options), "config.json");
  if (!isRegularFile(file)) return { file, agents: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const profiles = parsed?.agents?.profiles;
    if (!profiles || typeof profiles !== "object") return { file, agents: null };
    return { file, agents: Object.keys(profiles).sort() };
  } catch {
    return { file, agents: null };
  }
}

function agentScopeCheck(reference, options) {
  let patterns;
  try {
    patterns = normalizeAgentScope([reference.enabled_agents ?? [], reference.qdm_agent_id ?? []]);
  } catch (error) {
    return { name: "agent-scope", ok: false, detail: error.message };
  }
  const scope = patterns.length ? patterns : [...DEFAULT_AGENT_SCOPE_PATTERNS];
  const { file, agents } = listQwenPawAgentIds(options);
  if (agents === null && !fs.existsSync(file)) {
    // Nothing to compare against yet: a fresh image seed before any agent exists.
    return { name: "agent-scope", ok: true, detail: `patterns=${scope.join(",")} (no ${file})` };
  }
  if (agents === null) return { name: "agent-scope", ok: false, detail: `patterns=${scope.join(",")} unreadable ${file}` };
  const matched = agents.filter((agentId) => agentScopeAllows(scope, agentId));
  // An empty match means every runtime hook stands down and the tools stay
  // hidden: the install looks healthy while still answering "QDM 数据查询不可用".
  return {
    name: "agent-scope",
    ok: matched.length > 0,
    detail: `patterns=${scope.join(",")} matched=${matched.join(",") || "none"} agents=${agents.join(",")}`,
  };
}

function resolveToolPolicy(options, reference) {
  const requested = String(options.toolPolicy || "").trim();
  if (requested) {
    if (!TOOL_POLICIES.has(requested)) throw new Error(`unknown --tool-policy: ${requested}`);
    return requested;
  }
  const carried = String(reference?.tool_policy || "").trim();
  // Re-running setup must not quietly widen or narrow a governed install.
  return TOOL_POLICIES.has(carried) ? carried : "preserve";
}

function agentConfigFile(options, agentId) {
  return path.join(qwenPawWorkingDir(options), "workspaces", agentId, "agent.json");
}

function enabledBuiltinTools(data) {
  const entries = data?.tools?.builtin_tools;
  if (!entries || typeof entries !== "object") return null;
  return Object.entries(entries)
    .filter(([, value]) => value && typeof value === "object" && value.enabled !== false)
    .map(([name]) => name);
}

function inScopeAgents(options, patterns) {
  const { agents } = listQwenPawAgentIds(options);
  return (agents || []).filter((agentId) => agentScopeAllows(patterns, agentId));
}

/**
 * Narrow every in-scope agent to the QDM tools. ``preserve`` never calls this, so
 * an opt-out policy leaves the host's own agent configuration untouched.
 */
function applyStrictToolAllowlist(options, patterns) {
  const { agents, file } = listQwenPawAgentIds(options);
  if (agents === null) {
    throw new Error(`--tool-policy strict needs the host agent list, but ${file} is unreadable`);
  }
  const touched = [];
  for (const agentId of agents.filter((id) => agentScopeAllows(patterns, id))) {
    const configFile = agentConfigFile(options, agentId);
    if (!isRegularFile(configFile)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (error) {
      throw new Error(`--tool-policy strict cannot narrow ${configFile}: ${error.message}`);
    }
    const light = data.light_context_config && typeof data.light_context_config === "object"
      ? data.light_context_config : (data.light_context_config = {});
    const pruning = light.tool_result_pruning_config && typeof light.tool_result_pruning_config === "object"
      ? light.tool_result_pruning_config : (light.tool_result_pruning_config = {});
    // A pruned QDM result would silently drop rows the answer depends on.
    pruning.enabled = false;
    const tools = data.tools && typeof data.tools === "object" ? data.tools : (data.tools = {});
    const entries = tools.builtin_tools && typeof tools.builtin_tools === "object"
      ? tools.builtin_tools : (tools.builtin_tools = {});
    for (const [name, value] of Object.entries(entries)) {
      if (value && typeof value === "object") value.enabled = Object.hasOwn(QDM_ALLOWED_TOOLS, name);
    }
    for (const [name, description] of Object.entries(QDM_ALLOWED_TOOLS)) {
      const existing = entries[name];
      if (existing && typeof existing === "object") {
        existing.enabled = true;
        continue;
      }
      entries[name] = {
        name,
        enabled: true,
        description,
        display_to_user: true,
        async_execution: false,
        icon: "🛠️",
        config: {},
      };
    }
    fs.writeFileSync(configFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    touched.push(agentId);
  }
  return touched;
}

function toolAllowlistCheck(reference, options) {
  const policy = TOOL_POLICIES.has(String(reference.tool_policy || "").trim())
    ? String(reference.tool_policy).trim() : "preserve";
  if (policy !== "strict") return { name: "tool-allowlist", ok: true, detail: `policy=${policy}` };
  let patterns;
  try {
    patterns = normalizeAgentScope([reference.enabled_agents ?? [], reference.qdm_agent_id ?? []]);
  } catch (error) {
    return { name: "tool-allowlist", ok: false, detail: error.message };
  }
  const scope = patterns.length ? patterns : [...DEFAULT_AGENT_SCOPE_PATTERNS];
  const offenders = [];
  for (const agentId of inScopeAgents(options, scope)) {
    const file = agentConfigFile(options, agentId);
    if (!isRegularFile(file)) continue;
    let enabled;
    try {
      enabled = enabledBuiltinTools(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      offenders.push(`${agentId}:unparsable`);
      continue;
    }
    if (enabled === null) {
      offenders.push(`${agentId}:no-tool-section`);
      continue;
    }
    const extra = enabled.filter((name) => !Object.hasOwn(QDM_ALLOWED_TOOLS, name));
    if (extra.length) offenders.push(`${agentId}(${extra.join(",")})`);
  }
  return {
    name: "tool-allowlist",
    ok: offenders.length === 0,
    detail: `policy=strict offenders=${offenders.join(" ") || "none"}`,
  };
}

function pluginConfigFile() {
  if (process.platform === "win32") return path.join("C:", "ProgramData", "QDM", "qwenpaw", "plugin-config.json");
  return "/etc/qdm/qwenpaw/plugin-config.json";
}

function defaultSensitiveDir() {
  return process.platform === "win32" ? path.join(process.env.ProgramData || "C:/ProgramData", "QDM", "qwenpaw") : "/run/secrets";
}

function defaultInstanceBase() {
  return path.join(os.homedir(), ".qdm", "harness-data");
}

function firstWorkspaceAllowlist(options) {
  const value = options.workspaceAllowlist;
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

export async function qwenpawCommand(options = {}) {
  const action = String(options._?.[0] || "").toLowerCase();
  if (!actions.has(action)) {
    throw new Error("usage: harness-data qwenpaw <setup|doctor|update|install|uninstall> [options]");
  }
  if (action === "install" || action === "uninstall") return legacyQwenPaw(options, action);
  if (action === "setup") return setupQwenPaw(options);
  if (action === "doctor") return doctorQwenPaw(options);
  if (action === "update") return updateQwenPaw(options);
  throw new Error("qwenpaw migrate: use `harness-data migrate --host qwenpaw` (QwenPaw-specific migration lands with the runtime adapter)");
}

/**
 * Install or update the QwenPaw plugin through the unified lifecycle:
 *  1. discover QwenPaw version and Plugin API capability
 *  2. install/locate the native Plugin (QwenPaw plugin install)
 *  3. build the instanceRoot via harness-data setup --host qwenpaw
 *  4. write the reference-model plugin-config.json pointing at the Root Context
 *  5. record the enabled agent; setup owns staging and snapshot rollback
 *
 * --channel-auth-only (QwenPaw channel authorization, e.g. WeCom/Feishu)
 * keeps authz enabled but skips the auth.blob / --auth-user-id contract: the
 * runtime resolves each requester's blob from channel-auth.json instead.
 */
export async function setupQwenPaw(options = {}) {
  const source = resolvePluginSource(options);
  const python = String(options.qwenpawPython || "python").trim();
  await probeQwenPaw(python, source, options);

  const installedRoot = await installNativePlugin(python, source, options);
  const version = discoverPluginVersion(source) || packageVersion();
  const instanceRoot = path.resolve(
    String(options.instanceRoot || path.join(defaultInstanceBase(), "instance", version)).trim(),
  );
  const dataRoot = path.resolve(String(options.dataRoot || path.join(defaultInstanceBase(), "data")).trim());
  const workspaceRoot = path.resolve(String(options.workspaceRoot || firstWorkspaceAllowlist(options) || process.cwd()).trim());
  const secretRoot = path.resolve(String(options.secretDir || defaultSensitiveDir()).trim());

  const setupReport = await setupCommand({
    ...options,
    host: "qwenpaw",
    pluginRoot: installedRoot,
    resourceRoot: instanceRoot,
    dataRoot,
    workspaceRoot,
    secretRoot,
    json: true,
  });

  const configPath = writeReferenceConfig({
    installedRoot,
    instanceRoot,
    version,
    options,
    setupReport,
    patterns: resolveAgentScopePatterns(options),
    toolPolicy: resolveToolPolicy(options, readReferenceConfig(options)),
  });
  const written = readReferenceConfig(options) || {};
  const allowlistedAgents = String(written.tool_policy || "") === "strict"
    ? applyStrictToolAllowlist(options, written.enabled_agents || [])
    : [];
  return {
    ok: true,
    pluginRoot: installedRoot,
    instanceRoot,
    dataRoot,
    workspaceRoot,
    configPath,
    version,
    toolPolicy: written.tool_policy || "preserve",
    allowlistedAgents,
    setup: setupReport,
  };
}

export async function updateQwenPaw(options = {}) {
  const previous = readReferenceConfig(options);
  const report = await setupQwenPaw(options);
  if (previous && previous.root_context_path && report.instanceRoot !== path.dirname(previous.root_context_path)) {
    // The pointer now references the new instance; the old instance is kept
    // for rollback.  setup's snapshot already covered the shared roots.
    report.previousInstance = path.dirname(previous.root_context_path);
  }
  return report;
}

export async function doctorQwenPaw(options = {}) {
  const json = options.json === true;
  const rawPluginRoot = String(options.pluginRoot || "").trim();
  const pluginRoot = rawPluginRoot ? path.resolve(rawPluginRoot) : "";
  const reference = readReferenceConfig(options);
  const contextPath = reference?.root_context_path
    ? path.resolve(reference.root_context_path)
    : options.contextFile ? path.resolve(String(options.contextFile).trim()) : "";
  const instanceRoot = contextPath ? path.dirname(contextPath) : "";

  const checks = [];
  if (pluginRoot) {
    checks.push({
      name: "plugin-source",
      ok: fs.existsSync(path.join(pluginRoot, "plugin.json")) && fs.existsSync(path.join(pluginRoot, "plugin.py")),
      detail: pluginRoot,
    });
  }
  if (contextPath) {
    checks.push({ name: "root-context", ok: isRegularFile(contextPath), detail: contextPath });
  }
  if (instanceRoot) {
    checks.push({
      name: "settings",
      ok: isRegularFile(path.join(instanceRoot, "config", "settings.json")),
      detail: path.join(instanceRoot, "config", "settings.json"),
    });
    checks.push({
      name: "wikis-index",
      ok: isRegularFile(path.join(instanceRoot, ".harness", "index", "wikis-index.json")),
      detail: path.join(instanceRoot, ".harness", "index", "wikis-index.json"),
    });
    const runtimes = path.join(instanceRoot, "runtimes");
    const metric = fs.existsSync(runtimes)
      ? fs.readdirSync(runtimes).map((platform) => path.join(runtimes, platform, binaryName("qdm-metric-cli"))).find(isExecutable)
      : "";
    checks.push({ name: "metric-cli", ok: Boolean(metric), detail: metric || path.join(instanceRoot, "runtimes", "<platform>") });
  }
  if (reference) {
    checks.push({ name: "reference-config", ok: true, detail: reference.plugin_id });
    const secretDir = reference.secret_ref || defaultSensitiveDir();
    checks.push({
      name: "secret-ref",
      ok: !reference.secret_ref || fs.existsSync(reference.secret_ref),
      detail: secretDir,
    });
  }
  if (reference) {
    checks.push(agentScopeCheck(reference, options));
    checks.push(toolAllowlistCheck(reference, options));
  }
  const failures = checks.filter((check) => !check.ok);
  const report = {
    ok: failures.length === 0,
    host: "qwenpaw",
    pluginId: PLUGIN_ID,
    pluginRoot,
    instanceRoot,
    reference: reference ? { plugin_id: reference.plugin_id, plugin_version: reference.plugin_version, root_context_path: reference.root_context_path } : null,
    checks,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}\n`);
  }
  if (failures.length) process.exitCode = 1;
  return report;
}

async function legacyQwenPaw(options, action) {
  const runtime = path.resolve(options.runtime || options.dir || process.cwd());
  const source = path.resolve(options.source || path.join(runtime, "agents", "qwenpaw"));
  const script = path.join(source, "install-qwenpaw-plugin.py");
  if (!fs.existsSync(script)) throw new Error(`legacy QwenPaw installer is missing: ${script}`);
  const python = options.qwenpawPython || "python";
  const args = [script, action, "--runtime", runtime, "--source", source];
  if (options.qwenpawWorkingDir) args.push("--qwenpaw-working-dir", options.qwenpawWorkingDir);
  if (options.agentId) args.push("--agent-id", options.agentId);
  if (options.agentConfig) args.push("--agent-config", options.agentConfig);
  if (action === "install") args.push("--user-id-display-mode", options.userIdDisplayMode || "off");
  const result = await run(python, args, { cwd: runtime });
  if (result.stdout.trim()) process.stdout.write(result.stdout.trim() + "\n");
}

function resolvePluginSource(options) {
  const value = String(options.source || options.pluginSource || "").trim();
  if (!value) throw new Error("qwenpaw setup requires --source <plugin directory or zip>");
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`QwenPaw plugin source is missing: ${resolved}`);
  if (fs.statSync(resolved).isFile() && !resolved.endsWith(".zip")) {
    throw new Error("qwenpaw setup --source must be a plugin directory (or a zip that QwenPaw can install)");
  }
  return resolved;
}

function pluginManifest(source) {
  const file = path.join(source, "plugin.json");
  if (!fs.existsSync(file)) throw new Error(`plugin.json not found in ${source}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.id || !parsed.version) {
    throw new Error(`plugin.json must declare id and version: ${file}`);
  }
  return parsed;
}

function discoverPluginVersion(source) {
  try {
    return String(pluginManifest(source).version || "");
  } catch {
    return "";
  }
}

async function probeQwenPaw(python, source, options) {
  const code = "import importlib.metadata; from qwenpaw.plugins.api import PluginApi; v=importlib.metadata.version('qwenpaw'); assert callable(getattr(PluginApi,'register_runtime_hook',None)), 'register_runtime_hook missing'; print(v)";
  const result = await run(python, ["-c", code], { allowFailure: true, env: { ...process.env, QWENPAW_WORKING_DIR: String(options.qwenpawWorkingDir || "").trim() || undefined } });
  if (result.code !== 0) {
    throw new Error("QwenPaw 2.1.x with register_runtime_hook_now() is required (probe failed)");
  }
  const version = result.stdout.trim();
  if (version && !version.startsWith("2.1.") && !version.startsWith("2.2.")) {
    throw new Error(`QwenPaw ${version} is outside the supported 2.1.x/2.2.x range`);
  }
  return version;
}

async function installNativePlugin(python, source, options) {
  const workingDir = String(options.qwenpawWorkingDir || "").trim();
  const env = workingDir ? { ...process.env, QWENPAW_WORKING_DIR: workingDir } : process.env;
  const validate = await run(python, ["-m", "qwenpaw", "plugin", "validate", source], { allowFailure: true, env });
  if (validate.code !== 0) {
    throw new Error(`QwenPaw plugin validate failed: ${(validate.stderr || validate.stdout || "").trim().slice(0, 300)}`);
  }
  const install = await run(python, ["-m", "qwenpaw", "plugin", "install", source, "--force"], { allowFailure: true, env });
  if (install.code !== 0) {
    throw new Error(`QwenPaw plugin install failed: ${(install.stderr || install.stdout || "").trim().slice(0, 300)}`);
  }
  const workingBase = workingDir ? path.resolve(workingDir) : path.join(os.homedir(), ".qwenpaw");
  return path.join(workingBase, "plugins", PLUGIN_ID);
}

function resolveAgentScopePatterns(options) {
  const requested = normalizeAgentScope([options.enabledAgents ?? [], options.agentId ?? []]);
  if (requested.length) return requested;
  const previous = readReferenceConfig(options);
  const carried = normalizeAgentScope([previous?.enabled_agents ?? [], previous?.qdm_agent_id ?? []]);
  // Re-running setup must never silently re-scope a working install.
  if (carried.length) return carried;
  return [...DEFAULT_AGENT_SCOPE_PATTERNS];
}

function writeReferenceConfig({ installedRoot, instanceRoot, version, options, setupReport, patterns, toolPolicy }) {
  const config = {
    schema_version: 2,
    plugin_id: PLUGIN_ID,
    plugin_version: version,
    root_context_path: path.join(instanceRoot, "context.json"),
    secret_ref: String(options.secretDir || defaultSensitiveDir()).trim(),
    enabled_agents: patterns,
    user_id_display_mode: String(options.userIdDisplayMode || "off").trim(),
    tool_policy: toolPolicy,
    context_limits: { base_context_bytes: null, wiki_file_bytes: null, wiki_total_bytes: null },
    query_limits: { success_bytes: null, timeout_seconds: 120 },
    report_limits: { additional_context_bytes: null },
  };
  const file = options.pluginConfigFile ? path.resolve(String(options.pluginConfigFile).trim()) : pluginConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return file;
}

function readReferenceConfig(options) {
  const file = options.pluginConfigFile ? path.resolve(String(options.pluginConfigFile).trim()) : pluginConfigFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schema_version !== 2) return null;
    return {
      plugin_id: String(parsed.plugin_id || ""),
      plugin_version: String(parsed.plugin_version || ""),
      root_context_path: String(parsed.root_context_path || ""),
      secret_ref: String(parsed.secret_ref || ""),
      enabled_agents: Array.isArray(parsed.enabled_agents) ? parsed.enabled_agents : [],
      qdm_agent_id: String(parsed.qdm_agent_id || ""),
      tool_policy: String(parsed.tool_policy || ""),
    };
  } catch {
    return null;
  }
}

function isRegularFile(filePath) {
  try {
    const info = fs.lstatSync(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}
