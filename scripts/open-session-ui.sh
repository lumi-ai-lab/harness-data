#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_ID="${1:-}"
ADDR="${2:-127.0.0.1:18080}"

if [[ -z "$SESSION_ID" ]]; then
  echo "usage: scripts/open-session-ui.sh <session-id> [addr]" >&2
  exit 2
fi

exec "$ROOT_DIR/scripts/html-report-test.sh" ui "$SESSION_ID" "$ADDR"
