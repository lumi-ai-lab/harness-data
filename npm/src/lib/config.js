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
 * Priority: explicit dataAuth true/false → preserve existing → default off.
 */
export function resolveAuthzForWrite(options = {}, existing = null) {
  if (options.dataAuth === true) {
    return {
      mode: "on",
      blobFile: localTestAuthBlobRel,
      devUserId: localTestAuthUserId,
      allowLocalBlob: true,
    };
  }
  if (options.dataAuth === false) {
    return {
      mode: "off",
      blobFile: "",
      devUserId: "",
      allowLocalBlob: true,
    };
  }
  if (existing) {
    const mode = existing.mode === "on" ? "on" : "off";
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
  return {
    mode: "off",
    blobFile: "",
    devUserId: "",
    allowLocalBlob: true,
  };
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
  return { copied: true, path: target };
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
  if (!fs.existsSync(hooksFile)) return;
  const shimPath = path.join(codexDir, "hooks", "cli-shim.mjs").replaceAll("\\", "/");
  if (!fs.existsSync(shimPath)) return; // cli-shim.mjs ships in the runtime bundle

  const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  for (const event of Object.keys(hooks.hooks || {})) {
    for (const entry of hooks.hooks[event]) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command !== "string") continue;
        // Extract only the final CLI invocation from:
        // bash -c '... [ -z "$cli" ]; ...; "$cli" context --format codex-hook'
        const invocationStart = hook.command.lastIndexOf('"$cli"');
        if (invocationStart < 0) continue;
        const m = hook.command.slice(invocationStart).match(/^"\$cli"\s+(.+?)'\s*$/);
        if (!m) continue;
        hook.command = `node "${shimPath}" ${m[1]}`;
      }
    }
  }
  fs.writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
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
