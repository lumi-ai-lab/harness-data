#!/usr/bin/env bash

# Legacy compatibility builder for historical local-runtime tests. It is not a
# Harness Data user release artifact; Codex users install the Plugin from the
# main repository Marketplace.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR=""
VERSION_TAG=""
RUN_SELF_TEST=1

usage() {
  cat <<'EOF'
Usage: scripts/build-runtime-artifact.sh --output-dir PATH --version TAG [--no-self-test]

Build and verify the relocatable Harness runtime artifact.

The output directory is replaced as a generated staging directory. It must not
be a source or user-data directory.
EOF
}

die() {
  printf '[build-runtime-artifact] ERROR: %s\n' "$*" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --version)
      VERSION_TAG="${2:-}"
      shift 2
      ;;
    --no-self-test)
      RUN_SELF_TEST=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "$OUTPUT_DIR" ]] || die "--output-dir is required"
[[ -n "$VERSION_TAG" ]] || die "--version is required"

case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$ROOT_DIR/$OUTPUT_DIR" ;;
esac
OUTPUT_PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$OUTPUT_PARENT"
OUTPUT_DIR="$(cd "$OUTPUT_PARENT" && pwd)/$(basename "$OUTPUT_DIR")"

case "$OUTPUT_DIR" in
  "$ROOT_DIR"|"$ROOT_DIR/"|"$ROOT_DIR/wikis"|"$ROOT_DIR/packages"|"$ROOT_DIR/plugins"|"$ROOT_DIR/npm")
    die "refusing to replace a source directory: $OUTPUT_DIR"
    ;;
esac

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/agents" "$OUTPUT_DIR/config" "$OUTPUT_DIR/bootstrap" "$OUTPUT_DIR/packages" "$OUTPUT_DIR/bin"

copy_tree() {
  local source="$1"
  local destination="$2"
  [[ -e "$source" ]] || die "missing source: $source"
  mkdir -p "$(dirname "$destination")"
  cp -R "$source" "$destination"
}

copy_tree "$ROOT_DIR/.agents/claude" "$OUTPUT_DIR/agents/claude"
copy_tree "$ROOT_DIR/.agents/codex" "$OUTPUT_DIR/agents/codex"
copy_tree "$ROOT_DIR/.agents/pi" "$OUTPUT_DIR/agents/pi"
copy_tree "$ROOT_DIR/.agents/workbuddy" "$OUTPUT_DIR/agents/workbuddy"
copy_tree "$ROOT_DIR/.agents/.codebuddy-plugin" "$OUTPUT_DIR/agents/.codebuddy-plugin"
copy_tree "$ROOT_DIR/.agents/plugins" "$OUTPUT_DIR/agents/plugins"

node "$ROOT_DIR/scripts/build-claude-marketplace.mjs" \
  build \
  --output-dir "$OUTPUT_DIR/agents/claude-marketplace" \
  --version "$VERSION_TAG" \
  --marketplace-name lumi-ai-lab

copy_tree "$ROOT_DIR/plugins" "$OUTPUT_DIR/plugins"
find "$OUTPUT_DIR/plugins" -type d -name .harness -prune -exec rm -rf {} +
node "$ROOT_DIR/plugins/harness-data/scripts/bundle-dist.mjs" \
  --output-dir "$OUTPUT_DIR/plugins/harness-data/dist"
node -e 'const fs = require("fs"); const file = process.argv[1]; const version = process.argv[2]; const manifest = JSON.parse(fs.readFileSync(file, "utf8")); fs.writeFileSync(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);' \
  "$OUTPUT_DIR/plugins/harness-data/.codex-plugin/plugin.json" \
  "$VERSION_TAG"

copy_tree "$ROOT_DIR/packages/data-harness-cli" "$OUTPUT_DIR/packages/data-harness-cli"
copy_tree "$ROOT_DIR/packages/html-report-kernel" "$OUTPUT_DIR/packages/html-report-kernel"
copy_tree "$ROOT_DIR/packages/harness-runtime-node" "$OUTPUT_DIR/packages/harness-runtime-node"

cp "$ROOT_DIR/bootstrap/cli-manifest.json" "$OUTPUT_DIR/bootstrap/cli-manifest.json"
mkdir -p "$OUTPUT_DIR/plugins/harness-data/bootstrap"
cp "$ROOT_DIR/bootstrap/cli-manifest.json" "$OUTPUT_DIR/plugins/harness-data/bootstrap/cli-manifest.json"
cp "$ROOT_DIR/config/harness-config.yaml.example" "$OUTPUT_DIR/config/harness-config.yaml"
cp "$ROOT_DIR/config/harness-config.yaml.example" "$OUTPUT_DIR/config/harness-config.yaml.example"
cp "$ROOT_DIR/config/qdm-cli-paths.env.example" "$OUTPUT_DIR/config/qdm-cli-paths.env.example"
cp "$ROOT_DIR/bin/data-harness-cli" "$OUTPUT_DIR/bin/data-harness-cli"
cp "$ROOT_DIR/bin/data-harness-cli.cmd" "$OUTPUT_DIR/bin/data-harness-cli.cmd"
chmod +x "$OUTPUT_DIR/bin/data-harness-cli"

for required in \
  "$OUTPUT_DIR/agents/.codebuddy-plugin/marketplace.json" \
  "$OUTPUT_DIR/agents/plugins/marketplace.json" \
  "$OUTPUT_DIR/agents/workbuddy/.codebuddy-plugin/plugin.json" \
  "$OUTPUT_DIR/agents/workbuddy/hooks/hooks.json" \
  "$OUTPUT_DIR/agents/workbuddy/scripts/harness-hook.mjs" \
  "$OUTPUT_DIR/agents/workbuddy/skills/qdm-harness/SKILL.md" \
  "$OUTPUT_DIR/agents/codex/hooks.json" \
  "$OUTPUT_DIR/agents/codex/hooks/cli-shim.mjs" \
  "$OUTPUT_DIR/agents/claude-marketplace/.claude-plugin/marketplace.json" \
  "$OUTPUT_DIR/agents/claude-marketplace/qdm-harness-claude/.claude-plugin/plugin.json" \
  "$OUTPUT_DIR/agents/claude-marketplace/qdm-harness-claude/scripts/data-harness-cli" \
  "$OUTPUT_DIR/plugins/harness-data/.codex-plugin/plugin.json" \
  "$OUTPUT_DIR/plugins/harness-data/bootstrap/cli-manifest.json" \
  "$OUTPUT_DIR/plugins/harness-data/.mcp.json" \
  "$OUTPUT_DIR/plugins/harness-data/hooks/hooks.json" \
  "$OUTPUT_DIR/plugins/harness-data/scripts/setup.mjs" \
  "$OUTPUT_DIR/plugins/harness-data/scripts/context-store.mjs" \
  "$OUTPUT_DIR/plugins/harness-data/scripts/data-harness-cli" \
  "$OUTPUT_DIR/plugins/harness-data/dist/harness-data-installer/src/cli.js" \
  "$OUTPUT_DIR/plugins/harness-data/dist/data-harness-cli/src/main.js" \
  "$OUTPUT_DIR/plugins/harness-data/mcp/server.mjs" \
  "$OUTPUT_DIR/plugins/harness-data/skills/html-report/SKILL.md"; do
  [[ -f "$required" ]] || die "runtime artifact is missing required file: $required"
done

node -e 'const fs = require("fs"); for (const file of process.argv.slice(1)) { const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks; for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) { if (!hooks[event]?.length) throw new Error("missing Codex hook: " + event + " in " + file); } }' "$OUTPUT_DIR/agents/codex/hooks.json" "$OUTPUT_DIR/plugins/harness-data/hooks/hooks.json"

find "$OUTPUT_DIR/agents" -type d \( -name test -o -name tests \) -prune -exec rm -rf {} +
find "$OUTPUT_DIR/agents" -type f \( \
  -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' -o \
  -name '*.test.ts' -o -name '*.test.mts' -o -name '*.test.cts' -o \
  -name '*.spec.js' -o -name '*.spec.mjs' -o -name '*.spec.cjs' -o \
  -name '*.spec.ts' -o -name '*.spec.mts' -o -name '*.spec.cts' \
\) -delete
find "$OUTPUT_DIR/plugins" -type d \( -name test -o -name tests \) -prune -exec rm -rf {} +
find "$OUTPUT_DIR/plugins" -type f \( \
  -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' -o \
  -name '*.test.ts' -o -name '*.test.mts' -o -name '*.test.cts' -o \
  -name '*.spec.js' -o -name '*.spec.mjs' -o -name '*.spec.cjs' -o \
  -name '*.spec.ts' -o -name '*.spec.mts' -o -name '*.spec.cts' \
\) -delete
rm -rf "$OUTPUT_DIR/packages/data-harness-cli/test"
rm -rf "$OUTPUT_DIR/packages/html-report-kernel/test" "$OUTPUT_DIR/packages/harness-runtime-node/test"

node "$ROOT_DIR/scripts/build-plugin-manifest.mjs" \
  --artifact-root "$OUTPUT_DIR" \
  --host runtime \
  --plugin-name qdm-harness \
  --plugin-version "$VERSION_TAG" \
  --resource-mode external
node "$ROOT_DIR/scripts/build-plugin-manifest.mjs" \
  --artifact-root "$OUTPUT_DIR/plugins/harness-data" \
  --host codex \
  --plugin-version "$VERSION_TAG" \
  --resource-mode external
node "$ROOT_DIR/scripts/verify-artifact.mjs" "$OUTPUT_DIR" --kind runtime

if [[ "$RUN_SELF_TEST" == "1" ]]; then
  (cd "$OUTPUT_DIR" && node plugins/harness-data/mcp/server.mjs --self-test)
fi

printf 'runtime artifact ok: %s\n' "$OUTPUT_DIR"
