#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_QDM_METRIC_CLI="/Users/pengmd/c/qdm/qdm-metric-cli/dist/qdm-metric-cli"
QDM_METRIC_CLI_SOURCE="${QDM_METRIC_CLI_SOURCE:-${QDM_METRIC_CLI:-$DEFAULT_QDM_METRIC_CLI}}"
RUN_TESTS="${INIT_DEV_WORKTREE_RUN_TESTS:-0}"
BUILD_PI_PLUGIN="${INIT_DEV_WORKTREE_BUILD_PI_PLUGIN:-0}"
STRICT_WIKIS="${INIT_DEV_WORKTREE_STRICT_WIKIS:-0}"

log() {
  printf '[init-dev-worktree] %s\n' "$*"
}

die() {
  printf '[init-dev-worktree] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/init-dev-worktree.sh

Initialize a source Git worktree for Harness Data and the local PI HTML Report plugin.

Environment:
  QDM_METRIC_CLI_SOURCE          Absolute path to qdm-metric-cli.
                                  Default: /Users/pengmd/c/qdm/qdm-metric-cli/dist/qdm-metric-cli
  QDM_METRIC_CLI                 Alias for QDM_METRIC_CLI_SOURCE.
  INIT_DEV_WORKTREE_BUILD_PI_PLUGIN=1
                                  Build and verify a local PI HTML Report plugin when present.
  INIT_DEV_WORKTREE_RUN_TESTS=1  Run the PI plugin test suite after building it.
  INIT_DEV_WORKTREE_STRICT_WIKIS=1
                                  Fail when the Wikis content checks report warnings.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "$ROOT_DIR"

[[ -f .gitmodules ]] || die "not a Git worktree with .gitmodules: $ROOT_DIR"
[[ -f packages/data-harness-cli/src/main.js ]] || die "missing Data Harness CLI source"
[[ -x "$QDM_METRIC_CLI_SOURCE" ]] || die "qdm-metric-cli is missing or not executable: $QDM_METRIC_CLI_SOURCE"
if [[ "$RUN_TESTS" == "1" && "$BUILD_PI_PLUGIN" != "1" ]]; then
  die "INIT_DEV_WORKTREE_RUN_TESTS=1 requires INIT_DEV_WORKTREE_BUILD_PI_PLUGIN=1"
fi

log "worktree: $ROOT_DIR"
log "qdm-metric-cli: $QDM_METRIC_CLI_SOURCE"

log "initializing Git submodules"
git submodule update --init --recursive

log "installing bin/data-harness-cli"
mkdir -p bin
chmod 755 bin/data-harness-cli
test -x bin/data-harness-cli || die "missing executable bin/data-harness-cli"

log "writing local CLI configuration"
mkdir -p config
if [[ ! -f config/harness-config.yaml ]]; then
  cp config/harness-config.yaml.example config/harness-config.yaml
fi
if [[ ! -f config/qdm-cli-paths.env ]]; then
  cp config/qdm-cli-paths.env.example config/qdm-cli-paths.env
fi

QDM_METRIC_CLI_SOURCE="$QDM_METRIC_CLI_SOURCE" node \
  --input-type=module \
  -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const configPath = "config/harness-config.yaml";
    const envPath = "config/qdm-cli-paths.env";
    const cliPath = process.env.QDM_METRIC_CLI_SOURCE;
    let config = readFileSync(configPath, "utf8");
    if (/^  qdm_metric_cli:\s*.*$/m.test(config)) {
      config = config.replace(/^  qdm_metric_cli:\s*.*$/m, `  qdm_metric_cli: ${cliPath}`);
    } else {
      const section = `cli:\n  qdm_metric_cli: ${cliPath}\n`;
      config = `${section}\n${config}`;
    }
    writeFileSync(configPath, config.endsWith("\n") ? config : `${config}\n`);
    writeFileSync(envPath, `export QDM_METRIC_CLI="${cliPath}"\n`);
  '

log "linking PI project entrypoint"
if [[ -e .pi || -L .pi ]]; then
  [[ -L .pi && "$(readlink .pi)" == ".agents/pi" ]] || die ".pi already exists and is not the expected .agents/pi symlink"
else
  ln -s .agents/pi .pi
fi

if [[ "$BUILD_PI_PLUGIN" == "1" ]]; then
  [[ -f plugins/pi-html-report/package.json ]] || die "PI HTML Report plugin source is not present in this worktree"
  log "building and verifying PI HTML Report plugin"
  npm --prefix plugins/pi-html-report run build
  npm --prefix plugins/pi-html-report run verify
  if [[ "$RUN_TESTS" == "1" ]]; then
    npm --prefix plugins/pi-html-report test
  fi
else
  log "skipping PI HTML Report plugin build; install the plugin after Runtime initialization"
fi

log "building Wikis index"
./bin/data-harness-cli wikis build-index --skip-checks

log "validating local runtime"
if ! ./bin/data-harness-cli wikis check-all; then
  if [[ "$STRICT_WIKIS" == "1" ]]; then
    die "Wikis validation failed"
  fi
  log "warning: Wikis validation reported content issues; Runtime initialization continues"
fi
./bin/data-harness-cli context --question "生成运营中心管理周例会报告" --json >/dev/null

log "initialization complete"
log "start PI from this worktree root after installing any desired plugin"
