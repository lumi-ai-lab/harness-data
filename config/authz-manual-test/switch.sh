#!/usr/bin/env bash
# Switch harness authz profile for manual PI testing.
# Usage (from repo root):
#   bash config/authz-manual-test/switch.sh on|off|deny|restore|status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$ROOT/config/harness-config.yaml"
DIR="$ROOT/config/authz-manual-test"

profile="${1:-}"
case "$profile" in
  on)
    cp "$DIR/harness-config.authz-on.yaml" "$CFG"
    echo "OK: switched to authz ON (valid blob)"
    ;;
  off)
    cp "$DIR/harness-config.authz-off.yaml" "$CFG"
    echo "OK: switched to authz OFF"
    ;;
  deny)
    cp "$DIR/harness-config.authz-deny.yaml" "$CFG"
    echo "OK: switched to authz DENY (missing blob file)"
    ;;
  restore)
    if [[ -f "$DIR/harness-config.restore.yaml" ]]; then
      cp "$DIR/harness-config.restore.yaml" "$CFG"
      echo "OK: restored harness-config.yaml from snapshot"
    else
      cp "$DIR/harness-config.authz-on.yaml" "$CFG"
      echo "OK: no snapshot; restored to authz ON default"
    fi
    ;;
  status)
    echo "config: $CFG"
    if [[ -f "$CFG" ]]; then
      grep -nE 'mode:|blob_file:|dev_user_id:|qdm_metric_cli:' "$CFG" || true
    else
      echo "missing harness-config.yaml"
      exit 1
    fi
    echo "env HARNESS_AUTH_BLOB=${HARNESS_AUTH_BLOB:-<unset>}"
    echo "env HARNESS_AUTH_BLOB_FILE=${HARNESS_AUTH_BLOB_FILE:-<unset>}"
    ;;
  *)
    echo "usage: $0 on|off|deny|restore|status" >&2
    exit 2
    ;;
esac

# Always show brief status after switch
if [[ "$profile" != "status" ]]; then
  echo "---"
  bash "$0" status
fi
