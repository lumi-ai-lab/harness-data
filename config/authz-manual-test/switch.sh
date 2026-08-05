#!/usr/bin/env bash
# Switch harness authz profile for manual PI testing.
# Usage (from repo root):
#   bash config/authz-manual-test/switch.sh on|off|deny|restore|status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$ROOT/config/harness-config.yaml"
ENV_FILE="$ROOT/config/qdm-cli-paths.env"
DIR="$ROOT/config/authz-manual-test"

# Keep qdm-cli-paths.env metric path workspace-relative via absolute resolved bin.
ensure_metric_env() {
  local metric_abs="$ROOT/bin/qdm-metric-cli"
  if [[ ! -f "$ENV_FILE" ]]; then
    cat >"$ENV_FILE" <<EOF
export QDM_METRIC_CLI="${metric_abs}"
export QDM_SQL_CLI="/absolute/path/to/qdm-sql-cli"
export QDM_CAS_CLI="/absolute/path/to/cas-cli"
export QDM_CAS_CONFIG_DIR="${ROOT}/.qdm-auth/cas"
EOF
    echo "wrote $ENV_FILE"
    return
  fi
  if grep -q '^export QDM_METRIC_CLI=' "$ENV_FILE"; then
    # portable in-place replace of metric line only
    local tmp
    tmp="$(mktemp)"
    sed "s|^export QDM_METRIC_CLI=.*|export QDM_METRIC_CLI=\"${metric_abs}\"|" "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    echo "export QDM_METRIC_CLI=\"${metric_abs}\"" >>"$ENV_FILE"
  fi
}

profile="${1:-}"
case "$profile" in
  on)
    cp "$DIR/harness-config.authz-on.yaml" "$CFG"
    ensure_metric_env
    echo "OK: switched to authz ON (valid blob + local-test-user)"
    ;;
  off)
    cp "$DIR/harness-config.authz-off.yaml" "$CFG"
    ensure_metric_env
    echo "OK: switched to authz OFF"
    ;;
  deny)
    cp "$DIR/harness-config.authz-deny.yaml" "$CFG"
    ensure_metric_env
    echo "OK: switched to authz DENY (missing blob file)"
    ;;
  restore)
    if [[ -f "$DIR/harness-config.restore.yaml" ]]; then
      cp "$DIR/harness-config.restore.yaml" "$CFG"
    else
      cp "$DIR/harness-config.authz-on.yaml" "$CFG"
    fi
    ensure_metric_env
    echo "OK: restored harness-config.yaml"
    ;;
  status)
    echo "config: $CFG"
    if [[ -f "$CFG" ]]; then
      grep -nE 'mode:|blob_file:|dev_user_id:|qdm_metric_cli:|allow_local_blob:' "$CFG" || true
    else
      echo "missing harness-config.yaml"
      exit 1
    fi
    echo "env HARNESS_AUTH_BLOB=${HARNESS_AUTH_BLOB:-<unset>}"
    echo "env HARNESS_AUTH_BLOB_FILE=${HARNESS_AUTH_BLOB_FILE:-<unset>}"
    if [[ -f "$ENV_FILE" ]]; then
      grep -E '^export QDM_METRIC_CLI=' "$ENV_FILE" || true
    fi
    ;;
  *)
    echo "usage: $0 on|off|deny|restore|status" >&2
    exit 2
    ;;
esac

if [[ "$profile" != "status" ]]; then
  echo "---"
  bash "$0" status
fi
