import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";

export const agentChoices = ["claude", "codex", "pi", "openclaw", "hermes", "workbuddy", "both", "all"];
export const concreteAgentNames = ["claude", "codex", "pi", "openclaw", "hermes"];
export const agentLinks = {
  claude: [["agents/claude", ".claude"]],
  codex: [["agents/codex", ".codex"]],
  pi: [["agents/pi", ".pi"]],
  openclaw: [["agents/openclaw", ".openclaw"]],
  hermes: [["agents/hermes", ".hermes"]],
  // WorkBuddy uses its plugin package directly; it must not be represented by
  // a misleading project symlink such as .workbuddy.
  workbuddy: [],
  both: [["agents/claude", ".claude"], ["agents/codex", ".codex"]],
  all: [
    ["agents/claude", ".claude"],
    ["agents/codex", ".codex"],
    ["agents/pi", ".pi"],
    ["agents/openclaw", ".openclaw"],
    ["agents/hermes", ".hermes"],
  ],
};
export const agentChoiceText = agentChoices.join(", ");
export const qdmCliBinaries = [
  "data-harness-cli",
  "qdm-metric-cli",
];
export const localPathToolNames = [
  "qdm-metric-cli",
];
export const removedDataCliBinaries = [
  "qdm-cmr-cli",
  "qdm-indicators-cli",
  "qdm-sql-cli",
  "cas-cli",
];

/** Relative path of the committed local-test encrypted auth blob fixture. */
export const localTestAuthFixtureRel = "config/fixtures/local-test-auth.blob";
/** Working copy path written by install --data-auth (gitignored). */
export const localTestAuthBlobRel = "config/dev-auth.blob";
/** Slot user id for the local-test fixture; must match blob userId. */
export const localTestAuthUserId = "local-test-user";
/** Auth blob written by qdm-metric-cli dev beside its managed binary. */
export const devAdminAuthBlobRel = "bin/.qdm-auth.blob";
/** Local slot key for the embedded qdm development administrator. */
export const devAdminUserId = "dev-admin";

export function assertCodexAuthPlatform(_agent, authEnabled, platform = process.platform) {
  // Codex authz is cross-platform. Windows uses the Node hook shim while
  // macOS/Linux keep the existing shell hook path.
}

export function hasAnyAgentHook(workspace) {
  return concreteAgentNames.some((name) => fs.existsSync(path.join(workspace, `.${name}`)));
}

/**
 * Parse authz fields from an existing harness-config.yaml (light line scan).
 * @returns {{ mode: string, blobFile: string, devUserId: string, allowLocalBlob: boolean } | null}
 */
export function readAuthzFromHarnessConfig(harnessPath) {
  if (!fs.existsSync(harnessPath)) return null;
  const raw = fs.readFileSync(harnessPath, "utf8");
  let section = "";
  /** @type {{ mode?: string, blobFile?: string, devUserId?: string, allowLocalBlob?: boolean }} */
  const out = {};
  let sawAuthz = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const cut = trimmed.indexOf(":");
    if (cut < 0) continue;
    const key = trimmed.slice(0, cut).trim();
    let value = trimmed.slice(cut + 1).trim();
    const hash = value.indexOf("#");
    if (hash >= 0) value = value.slice(0, hash).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (indent === 0) {
      section = value === "" ? key : "";
      if (section === "authz") sawAuthz = true;
      continue;
    }
    if (section !== "authz") continue;
    switch (key) {
      case "mode":
        out.mode = value.toLowerCase() === "on" ? "on" : "off";
        break;
      case "blob_file":
        out.blobFile = value;
        break;
      case "dev_user_id":
        out.devUserId = value;
        break;
      case "allow_local_blob":
        out.allowLocalBlob = parseConfigBool(value, true);
        break;
      default:
        break;
    }
  }
  if (!sawAuthz) return null;
  return {
    mode: out.mode === "on" ? "on" : "off",
    blobFile: out.blobFile || "",
    devUserId: out.devUserId || "",
    allowLocalBlob: out.allowLocalBlob !== false,
  };
}

/**
 * Resolve authz block for writeLocalConfig.
 * Priority: explicit dev/dataAuth/authBlob → preserve an enabled runtime.
 */
export function resolveAuthzForWrite(options = {}, existing = null) {
  if (Object.hasOwn(options, "noAuth")) {
    throw new Error("--no-auth has been removed; install requires authorization");
  }
  if (options.dev === true) {
    return {
      mode: "on",
      blobFile: devAdminAuthBlobRel,
      devUserId: devAdminUserId,
      allowLocalBlob: true,
    };
  }
  // --data-auth: 用内置 fixture（向后兼容，开发/测试用）
  if (options.dataAuth === true) {
    return {
      mode: "on",
      blobFile: localTestAuthBlobRel,
      devUserId: localTestAuthUserId,
      allowLocalBlob: true,
    };
  }
  if (options.dataAuth === false) {
    throw new Error("--data-auth cannot be disabled; install requires authorization");
  }
  // 用户提供了 blob（默认 install 路径）
  if (options.authBlob === true) {
    return {
      mode: "on",
      blobFile: localTestAuthBlobRel,
      devUserId: options.devUserId || "",
      allowLocalBlob: true,
    };
  }
  // 无显式 flag 时只允许沿用已有的授权 runtime。
  if (existing) {
    if (existing.mode !== "on") {
      throw new Error("legacy authorization mode is not supported; reinstall with --auth-blob and --auth-user-id");
    }
    const mode = "on";
    let allowLocalBlob = existing.allowLocalBlob !== false;
    // MVP convergence: Host/Lumi auth fallback has been removed, so
    // allow_local_blob=false with mode=on is a dead-end config that can
    // never authorize any gated command. Migrate it to true on update.
    if (mode === "on" && !allowLocalBlob) {
      allowLocalBlob = true;
    }
    return {
      mode,
      blobFile: existing.blobFile || "",
      devUserId: existing.devUserId || "",
      allowLocalBlob,
    };
  }
  throw new Error("authorization is required; provide --auth-blob and --auth-user-id, --data-auth, or --dev");
}

function formatAuthzYaml(authz) {
  const lines = ["authz:", `  mode: ${authz.mode}`];
  if (authz.mode === "on" && authz.blobFile) {
    lines.push(`  blob_file: ${authz.blobFile}`);
  }
  if (authz.mode === "on" && authz.devUserId) {
    lines.push(`  dev_user_id: ${authz.devUserId}`);
  }
  lines.push(`  allow_local_blob: ${authz.allowLocalBlob ? "true" : "false"}`);
  return `${lines.join("\n")}\n`;
}

export function writeLocalConfig(workspace, options = {}) {
  const configDir = path.join(workspace, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const harness = path.join(configDir, "harness-config.yaml");
  const env = path.join(configDir, "qdm-cli-paths.env");
  if ((fs.existsSync(harness) || fs.existsSync(env)) && !options.overwrite) {
    throw new Error("local config already exists; rerun interactively and confirm overwrite or remove the files");
  }
  const existing = options.overwrite ? readAuthzFromHarnessConfig(harness) : null;
  const authz = resolveAuthzForWrite(options, existing);
  const bin = (name) => path.join(workspace, "bin", binaryName(name)).replaceAll("\\", "/");
  const metricPath = bin("qdm-metric-cli");
  fs.writeFileSync(
    harness,
    `paths:\n  knowledge: wikis\n\ncli:\n  qdm_metric_cli: ${metricPath}\n\n${formatAuthzYaml(authz)}`,
  );
  // .env — POSIX export format (all platforms; Codex hooks use cli-shim.mjs which
  // directly spawns the CLI, so this file is only for interactive shell usage)
  fs.writeFileSync(
    env,
    `export QDM_METRIC_CLI="${metricPath}"\n`,
  );
  return { authz };
}

/**
 * Copy committed local-test fixture to config/dev-auth.blob when missing.
 * @returns {{ copied: boolean, path: string }}
 */
export function ensureLocalAuthBlob(workspace, options = {}) {
  const target = path.join(workspace, localTestAuthBlobRel);
  const fixture = path.join(workspace, localTestAuthFixtureRel);
  if (fs.existsSync(target) && !options.force) {
    fs.chmodSync(target, 0o600);
    return { copied: false, path: target };
  }
  if (!fs.existsSync(fixture)) {
    throw new Error(
      `data-auth fixture missing: ${localTestAuthFixtureRel} (expected under runtime). ` +
        "Ensure the runtime bundle includes config/fixtures/local-test-auth.blob.",
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fixture, target);
  fs.chmodSync(target, 0o600);
  return { copied: true, path: target };
}

/**
 * Write user-provided auth blob string to config/dev-auth.blob.
 * @param {string} workspace - runtime dir
 * @param {string} blobContent - the encrypted blob string (qdm1enc...)
 * @returns {{ path: string }}
 */
export function writeAuthBlob(workspace, blobContent) {
  const target = path.join(workspace, localTestAuthBlobRel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${blobContent}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return { path: target };
}

export function removeLegacyDataCLIs(runtimeDir) {
  const removed = [];
  for (const name of removedDataCliBinaries) {
    const destination = path.join(runtimeDir, "bin", binaryName(name));
    if (!fs.existsSync(destination)) continue;
    fs.rmSync(destination, { force: true });
    removed.push(name);
  }
  return removed;
}

export function linkAgents(workspace, agent) {
  const pairs = agentLinks[agent];
  if (!pairs) throw new Error(`agent must be ${agentChoiceText}`);
  for (const [sourceRel, targetRel] of pairs) {
    const source = path.join(workspace, sourceRel);
    const target = path.join(workspace, targetRel);
    if (!fs.existsSync(source)) throw new Error(`agent template missing: ${sourceRel}`);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(source, target, "junction");
  }
  return pairs;
}

/**
 * On Windows, patch agents/codex/hooks.json: replace each `bash -c '...'`
 * command with `node "cli-shim.mjs" <args>`. The shim directly spawns
 * data-harness-cli via spawnSync with shell:false, bypassing all Windows
 * shells (PowerShell/CMD) and their incompatible quoting rules.
 *
 * `node` is a bare executable name in PATH (required by the npm package),
 * recognised as a command — not a string expression — by every shell.
 */
export function patchCodexHooksForWindows(workspace) {
  if (process.platform !== "win32") return;
  const codexDir = path.join(workspace, "agents", "codex");
  const hooksFile = path.join(codexDir, "hooks.json");
  if (!fs.existsSync(hooksFile)) throw new Error("Windows Codex hooks are missing: agents/codex/hooks.json");
  const shimPath = path.join(codexDir, "hooks", "cli-shim.mjs").replaceAll("\\", "/");
  if (!fs.existsSync(shimPath)) throw new Error("Windows Codex hook shim is missing: agents/codex/hooks/cli-shim.mjs");

  const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  const requiredHooks = new Map([
    ["UserPromptSubmit", "context --format codex-hook"],
    ["PreToolUse", "authz-hook --agent codex"],
    ["PostToolUse", "posttool --format codex-hook"],
  ]);
  for (const [event, expectedArgs] of requiredHooks) {
    let ready = false;
    for (const entry of hooks.hooks?.[event] || []) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command !== "string") continue;
        const shimCommand = `node "${shimPath}" ${expectedArgs}`;
        if (hook.command === shimCommand) {
          if (ready) throw new Error(`Windows Codex hook patch found duplicate commands for ${event}`);
          ready = true;
          continue;
        }
        // Extract only the final CLI invocation from:
        // bash -c '... [ -z "$cli" ]; ...; "$cli" context --format codex-hook'
        const invocationStart = hook.command.lastIndexOf('"$cli"');
        if (invocationStart < 0) continue;
        const m = hook.command.slice(invocationStart).match(/^"\$cli"\s+(.+?)'\s*$/);
        if (!m || m[1] !== expectedArgs) continue;
        if (ready) throw new Error(`Windows Codex hook patch found duplicate commands for ${event}`);
        hook.command = shimCommand;
        ready = true;
      }
    }
    if (!ready) throw new Error(`Windows Codex hook patch failed for ${event}`);
  }
  const tempDir = fs.mkdtempSync(path.join(codexDir, ".hooks-update-"));
  const tempFile = path.join(tempDir, "hooks.json");
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(hooks, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(tempFile, hooksFile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseConfigBool(value, fallback) {
  switch (String(value).toLowerCase()) {
    case "true":
    case "yes":
    case "1":
    case "on":
      return true;
    case "false":
    case "no":
    case "0":
    case "off":
      return false;
    default:
      return fallback;
  }
}
