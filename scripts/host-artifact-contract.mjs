// Internal adapter validation contract; these artifacts are not published as
// Harness Data user-facing release assets.
export const HOST_ARTIFACT_HOSTS = Object.freeze([
  "claude",
  "codex",
  "workbuddy",
  "pi",
  "qwenpaw",
]);

const COMMON_REQUIRED_PATHS = Object.freeze([
  "host-artifact.json",
  "host-artifact-contract.mjs",
  "plugin-manifest.json",
  "self-test.mjs",
  "bootstrap/cli-manifest.json",
  "bin/data-harness-cli",
  "scripts/data-harness-cli",
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
    adapterManifest: "adapter/.claude-plugin/plugin.json",
    requiredPaths: [
      "adapter/.claude-plugin/plugin.json",
      "adapter/hooks/hooks.json",
      "adapter/settings.json",
    ],
  },
  codex: {
    pluginName: "harness-data",
    source: "plugins/harness-data",
    adapterManifest: "adapter/.codex-plugin/plugin.json",
    requiredPaths: [
      "adapter/.codex-plugin/plugin.json",
      "adapter/.mcp.json",
      "adapter/mcp/server.mjs",
      "adapter/skills/html-report/SKILL.md",
      "adapter/hooks/hooks.json",
      "adapter/scripts/setup.mjs",
      "adapter/scripts/context-store.mjs",
      "adapter/scripts/data-harness-cli",
      "adapter/dist/harness-data-installer/src/cli.js",
      "adapter/dist/data-harness-cli/src/main.js",
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
    requiredPaths: [
      "adapter/plugin.json",
      "adapter/plugin.py",
      "adapter/qdm_cli.py",
      "adapter/qdm_harness_context.py",
      "adapter/qdm_channel_auth.py",
      "adapter/qdm_config.py",
      "adapter/qdm_identity.py",
      "adapter/qdm_report_lifecycle.py",
      "adapter/qdm_runtime_hooks.py",
      "adapter/skills/qdm-harness/SKILL.md",
      "adapter/scripts/data-harness-cli",
    ],
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
