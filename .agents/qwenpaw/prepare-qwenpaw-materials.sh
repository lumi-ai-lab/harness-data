#!/usr/bin/env sh
set -eu

secret_dir=${1:-/srv/qdm-secrets}
auth_file="$secret_dir/channel-auth.json"
hmac_file="$secret_dir/session-hmac.secret"

for file in "$auth_file" "$hmac_file"; do
    [ -f "$file" ] || { echo "missing regular file: $file" >&2; exit 1; }
    [ ! -L "$file" ] || { echo "symlink rejected: $file" >&2; exit 1; }
    chmod 600 "$file"
done

chmod go-w "$secret_dir"
uid=$(id -u)
gid=$(id -g)
chown "$uid:$gid" "$auth_file" "$hmac_file"
echo "QwenPaw Linux Secret permissions prepared: $secret_dir"
