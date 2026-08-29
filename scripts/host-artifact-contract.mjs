export const HOST_ARTIFACT_HOSTS = Object.freeze([
  "claude",
  "codex",
  "workbuddy",
  "pi",
  "qwenpaw",
  "hermes",
  "openclaw",
]);

const COMMON_REQUIRED_PATHS = Object.freeze([
  "host-artifact.json",
  "host-artifact-contract.mjs",
  "plugin-manifest.json",
  "self-test.mjs",
  "bootstrap/cli-manifest.json",
  "vendor/data-harness-cli/src/main.js",
  "vendor/data-harness-cli/package.json",
  "vendor/html-report-kernel/src/index.mjs",
  "vendor/html-report-kernel/package.json",
  "vendor/harness-runtime-node/src/index.mjs",
  "vendor/harness-runtime-node/package.json",
  "skills/html-report/SKILL.md",
  "skills/qdm-harness/SKILL.md",
]);

export const HOST_ARTIFACT_SPECS = Object.freeze({
  claude: {
    pluginName: "qdm-harness-claude",
    source: ".agents/claude",
    adapterManifest: "adapter/settings.json",
    requiredPaths: ["adapter/settings.json"],
  },
  codex: {
    pluginName: "qdm-html-report",
    source: "plugins/qdm-html-report",
    adapterManifest: "adapter/.codex-plugin/plugin.json",
    requiredPaths: [
      "adapter/.codex-plugin/plugin.json",
      "adapter/.mcp.json",
      "adapter/mcp/server.mjs",
      "adapter/skills/html-report/SKILL.md",
    ],
  },
  workbuddy: {
    pluginName: "qdm-harness-workbuddy",
    source: ".agents/workbuddy",
    adapterManifest: "adapter/.codebuddy-plugin/plugin.json",
    requiredPaths: [
      "adapter/.codebuddy-plugin/plugin.json",
      "adapter/hooks/hooks.json",
      "adapter/scripts/harness-hook.mjs",
      "adapter/skills/qdm-harness/SKILL.md",
    ],
  },
  pi: {
    pluginName: "@lumi-ai-lab/pi-html-report",
    source: "plugins/pi-html-report",
    adapterManifest: "adapter/package.json",
    requiredPaths: [
      "adapter/package.json",
      "adapter/dist/manifest.json",
      "adapter/dist/extensions/qdm-harness/index.ts",
      "adapter/dist/skills/html-report/SKILL.md",
      "adapter/dist/agents",
    ],
  },
  qwenpaw: {
    pluginName: "qdm-harness-qwenpaw",
    source: ".agents/qwenpaw",
    adapterManifest: "adapter/plugin.json",
    requiredPaths: ["adapter/plugin.json", "adapter/plugin.py"],
  },
  hermes: {
    pluginName: "qdm-harness-hermes",
    source: ".agents/hermes/plugins/qdm-harness",
    adapterManifest: "adapter/plugin.yaml",
    requiredPaths: ["adapter/plugin.yaml", "adapter/hooks.py"],
  },
  openclaw: {
    pluginName: "qdm-harness-openclaw",
    source: ".agents/openclaw/plugins/qdm-harness",
    adapterManifest: "adapter/package.json",
    requiredPaths: ["adapter/package.json", "adapter/src/index.ts"],
  },
});

export function requireHostArtifactSpec(host) {
  const normalized = String(host || "").trim().toLowerCase();
  const spec = HOST_ARTIFACT_SPECS[normalized];
  if (!spec) throw new Error(`unsupported host artifact: ${host}`);
  return { host: normalized, ...spec };
}

export function hostArtifactKind(host) {
  return `host-${requireHostArtifactSpec(host).host}`;
}

export function isHostArtifactKind(kind) {
  return HOST_ARTIFACT_HOSTS.some((host) => kind === `host-${host}`);
}

export function hostFromArtifactKind(kind) {
  const value = String(kind || "").trim().toLowerCase();
  if (!isHostArtifactKind(value)) return "";
  return value.slice("host-".length);
}

export function requiredPathsForHost(host) {
  const spec = requireHostArtifactSpec(host);
  return [...COMMON_REQUIRED_PATHS, ...spec.requiredPaths];
}
