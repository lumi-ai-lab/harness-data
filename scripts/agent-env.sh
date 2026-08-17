#!/usr/bin/env bash
set -euo pipefail
_AGENT_ENV_FILE="${BASH_SOURCE:-}"
if [[ -z "$_AGENT_ENV_FILE" && -n "${ZSH_VERSION:-}" ]]; then
  eval '_AGENT_ENV_FILE="${(%):-%x}"'
fi
if [[ -z "$_AGENT_ENV_FILE" ]]; then
  _AGENT_ENV_FILE="$0"
fi
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$_AGENT_ENV_FILE")/.." && pwd)"
export QDM_METRIC_CLI="$ROOT_DIR/bin/qdm-metric-cli"
export QDM_HARNESS_CLI="$ROOT_DIR/bin/data-harness-cli"
export DATA_HARNESS_CLI="$ROOT_DIR/bin/data-harness-cli"
export PATH="$ROOT_DIR/bin:$PATH"
echo "QDM html-report test env loaded: $ROOT_DIR"
echo "QDM_METRIC_CLI=$QDM_METRIC_CLI"
echo "QDM_HARNESS_CLI=$QDM_HARNESS_CLI"
