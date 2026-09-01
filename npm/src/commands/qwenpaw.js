import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../lib/exec.js";
import { packageVersion } from "../lib/package.js";
import { binaryName, isExecutable, platformKey } from "../lib/platform.js";
import { setupCommand } from "./setup.js";

const PLUGIN_ID = "qdm-harness-qwenpaw";
const actions = new Set(["setup", "doctor", "migrate", "update", "install", "uninstall"]);

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
  const workspaceRoot = path.resolve(String(options.workspaceRoot || options.workspaceAllowlist?.[0] || process.cwd()).trim());

  const setupReport = await setupCommand({
    ...options,
    host: "qwenpaw",
    pluginRoot: installedRoot,
    resourceRoot: instanceRoot,
    dataRoot,
    workspaceRoot,
    json: true,
  });

  const configPath = writeReferenceConfig({ installedRoot, instanceRoot, version, options, setupReport });
  return {
    ok: true,
    pluginRoot: installedRoot,
    instanceRoot,
    dataRoot,
    workspaceRoot,
    configPath,
    version,
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

function writeReferenceConfig({ installedRoot, instanceRoot, version, options, setupReport }) {
  const agentId = String(options.agentId || "qdmDataAgent").trim();
  const config = {
    schema_version: 2,
    plugin_id: PLUGIN_ID,
    plugin_version: version,
    root_context_path: path.join(instanceRoot, "context.json"),
    secret_ref: String(options.secretDir || defaultSensitiveDir()).trim(),
    enabled_agents: [agentId],
    qdm_agent_id: agentId,
    user_id_display_mode: String(options.userIdDisplayMode || "off").trim(),
    tool_policy: "preserve",
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
