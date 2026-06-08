#!/bin/sh
set -eu
root="${HERMES_PROJECT_DIR:-$PWD}"
while [ "$root" != "/" ] && [ ! -x "$root/bin/data-harness-cli" ]; do
  root="$(dirname "$root")"
done
if [ ! -x "$root/bin/data-harness-cli" ]; then
  echo "data-harness-cli not found from $PWD" >&2
  exit 1
fi
"$root/bin/data-harness-cli" posttool --format agent-hook
