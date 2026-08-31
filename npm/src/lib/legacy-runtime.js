import fs from "node:fs";
import path from "node:path";

export function inspectLegacyRuntime(value) {
  const text = String(value || "").trim();
  if (!text || !path.isAbsolute(text)) {
    return { detected: false, valid: false, root: "", reason: "explicit legacy runtime path is not supplied" };
  }
  const root = path.resolve(text);
  const required = [
    ["bootstrap/cli-manifest.json", "manifest", false],
    ["config/harness-config.yaml", "config", false],
    ["wikis", "wikis", true],
  ];
  const missing = [];
  for (const [relative, name, expectedDirectory] of required) {
    const full = path.join(root, relative);
    let info;
    try {
      info = fs.lstatSync(full);
    } catch {
      missing.push(name);
      continue;
    }
    if (info.isSymbolicLink()) {
      return { detected: false, valid: false, root, reason: `legacy runtime contains a symbolic link at ${relative}` };
    }
    if (expectedDirectory ? !info.isDirectory() : !info.isFile()) missing.push(name);
  }
  const agentDirectory = ["agents", ".agents"].find((relative) => {
    const full = path.join(root, relative);
    try {
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) return false;
      return info.isDirectory();
    } catch {
      return false;
    }
  });
  if (!agentDirectory) missing.push("agents");
  if (missing.length) {
    return { detected: false, valid: false, root, reason: `legacy runtime is incomplete; missing ${missing.join(", ")}` };
  }

  if (hasModernRuntimeMarkers(root)) {
    return { detected: false, valid: true, root, modern: true, reason: "runtime already carries the structured artifact contract" };
  }

  let runtimeTag = "";
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "bootstrap", "cli-manifest.json"), "utf8"));
    runtimeTag = String(manifest.releaseTag || manifest.version || "").trim();
  } catch {
    return { detected: false, valid: false, root, reason: "legacy runtime manifest is not valid JSON" };
  }
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, ".harness", "installer-state.json"), "utf8"));
    runtimeTag ||= String(state.runtimeTag || state.packageVersion || "").trim();
  } catch {
    // installer state is optional for legacy detection
  }
  return {
    detected: true,
    valid: true,
    modern: false,
    root,
    runtimeTag,
    hint: migrationHint({ root, runtimeTag }),
  };
}

export function migrationHint({ root, runtimeTag = "" } = {}) {
  const version = runtimeTag ? `（${runtimeTag}）` : "";
  return `发现旧版 Harness runtime${version}：请先运行 qdm-harness migrate --check --from "${root}"；不会自动迁移或修改旧目录。`;
}

function hasModernRuntimeMarkers(root) {
  return fs.existsSync(path.join(root, "plugin-manifest.json"))
    && fs.existsSync(path.join(root, "packages", "data-harness-cli", "package.json"))
    && fs.existsSync(path.join(root, "packages", "html-report-kernel", "package.json"))
    && fs.existsSync(path.join(root, "packages", "harness-runtime-node", "package.json"));
}
