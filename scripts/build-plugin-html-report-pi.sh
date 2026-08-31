#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${PI_HTML_REPORT_PLUGIN_DIR:-$ROOT_DIR/plugins/pi-html-report}"
PLUGIN_DIR="$(cd "$PLUGIN_DIR" 2>/dev/null && pwd)" || {
  printf '[build-plugin-html-report-pi] ERROR: PI plugin directory is missing: %s\n' "$PLUGIN_DIR" >&2
  exit 1
}
RUN_TESTS="${BUILD_PI_HTML_REPORT_RUN_TESTS:-0}"

log() {
  printf '[build-plugin-html-report-pi] %s\n' "$*"
}

die() {
  printf '[build-plugin-html-report-pi] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/build-plugin-html-report-pi.sh

Build and verify the local PI HTML Report plugin package.

Environment:
  PI_HTML_REPORT_PLUGIN_DIR       Plugin source directory.
                                  Default: <repo>/plugins/pi-html-report
  BUILD_PI_HTML_REPORT_RUN_TESTS=1
                                  Run the plugin test suite after build/verify.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[[ -f "$PLUGIN_DIR/package.json" ]] || die "PI HTML Report plugin source is missing: $PLUGIN_DIR"
[[ -f "$PLUGIN_DIR/scripts/build-package.mjs" ]] || die "missing plugin build script: $PLUGIN_DIR/scripts/build-package.mjs"

log "plugin source: $PLUGIN_DIR"
if [[ "$RUN_TESTS" == "1" ]]; then
  node --test --test-concurrency=1 "$PLUGIN_DIR"/test/*.test.mjs
fi
npm --prefix "$PLUGIN_DIR" run build
npm --prefix "$PLUGIN_DIR" run verify

[[ -f "$PLUGIN_DIR/dist/manifest.json" ]] || die "build completed without dist/manifest.json"
[[ -d "$PLUGIN_DIR/dist/extensions" ]] || die "build completed without dist/extensions"
[[ -d "$PLUGIN_DIR/dist/skills" ]] || die "build completed without dist/skills"
[[ -d "$PLUGIN_DIR/dist/agents" ]] || die "build completed without dist/agents"

for agent in report-writer report-researcher report-reviewer report-designer; do
  agent_file="$PLUGIN_DIR/dist/agents/$agent.md"
  extension_path="$(sed -n 's/^subagentOnlyExtensions: //p' "$agent_file")"
  [[ -n "$extension_path" ]] || die "$agent agent has no subagentOnlyExtensions path"
  [[ -f "$(dirname "$agent_file")/$extension_path" ]] || die "$agent child extension is missing: $extension_path"
done

if grep -Rqs '/Users/pengmd/c/qdm/extensions/' "$PLUGIN_DIR/dist/agents"; then
  die "dist agents still reference the obsolete /Users/pengmd/c/qdm/extensions path"
fi

log "build complete"
log "artifact: $PLUGIN_DIR/dist"
log "local install: pi install \"$PLUGIN_DIR\" -l --approve"
