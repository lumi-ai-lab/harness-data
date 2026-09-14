#!/bin/sh
# Explicit legacy rollback entrypoint. It never reads a Runtime MCP token.
set -eu

image=${QWENPAW_LEGACY_IMAGE:-harness-data-qwenpaw:0.0.56-amd64}
name=${QWENPAW_CONTAINER_NAME:-qwenpaw}
port=${QWENPAW_PORT:-8088}
bind_addr=${QWENPAW_BIND:-0.0.0.0}
runtime_uid=${QWENPAW_UID:-10001}
runtime_gid=${QWENPAW_GID:-10001}
secret_dir=${QDM_CHANNEL_SECRET_DIR:?set QDM_CHANNEL_SECRET_DIR}
model_key=${QWENPAW_MODEL_API_KEY:?set QWENPAW_MODEL_API_KEY}
mem_limit=${QWENPAW_MEM_LIMIT:-8g}
container_tz=${QWENPAW_TZ:-Asia/Shanghai}

auth_file="$secret_dir/channel-auth.json"
hmac_file="$secret_dir/session-hmac.secret"
test -f "$auth_file" || { echo "missing regular file: $auth_file" >&2; exit 1; }
test ! -L "$auth_file" || { echo "channel authorization file must not be a symlink" >&2; exit 1; }

if [ ! -f "$hmac_file" ]; then
  umask 077
  head -c 48 /dev/urandom > "$hmac_file"
  chmod 600 "$hmac_file"
  if ! chown "${runtime_uid}:${runtime_gid}" "$hmac_file" 2>/dev/null; then
    echo "cannot securely assign $hmac_file to ${runtime_uid}:${runtime_gid}" >&2
    exit 1
  fi
fi
test ! -L "$hmac_file" || { echo "session HMAC must not be a symlink" >&2; exit 1; }
[ "$(stat -c '%a' "$hmac_file")" = "600" ] || { echo "session HMAC must have mode 0600" >&2; exit 1; }

docker image inspect "${image}" >/dev/null 2>&1 || { echo "missing image: ${image}" >&2; exit 1; }
if ! docker run --rm --platform linux/amd64 --entrypoint /bin/sh \
    --user "${runtime_uid}:${runtime_gid}" \
    -v "${secret_dir}:/run/secrets:ro" "${image}" \
    -c 'test -r /run/secrets/channel-auth.json && test -r /run/secrets/session-hmac.secret' >/dev/null 2>&1; then
  echo "legacy authorization files are unreadable by the runtime UID/GID" >&2
  exit 1
fi

proxy=${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}
if [ -n "${proxy}" ]; then
  proxy=$(printf '%s' "${proxy}" | sed -E 's#^(https?://)?(127\.0\.0\.1|localhost)([/:]|$)#\1host.docker.internal\3#')
fi
if docker ps -a --format '{{.Names}}' | grep -qxF "${name}"; then
  docker rm -f "${name}" >/dev/null
fi

set -- docker run -d --name "${name}" \
  --platform linux/amd64 \
  --user "${runtime_uid}:${runtime_gid}" \
  --restart unless-stopped \
  --memory "${mem_limit}" \
  --add-host host.docker.internal:host-gateway \
  -e QWENPAW_MODEL_API_KEY="${model_key}" \
  -e QWENPAW_MODEL_ID="${QWENPAW_MODEL_ID:-qwen3.8-flash}" \
  -e QWENPAW_MODEL_BASE_URL="${QWENPAW_MODEL_BASE_URL:-https://aig.qdama.cn/api/v1}" \
  -e TZ="${container_tz}"
if [ -n "${proxy}" ]; then
  set -- "$@" -e "http_proxy=${proxy}" -e "https_proxy=${proxy}"
fi
set -- "$@" \
  -v qwenpaw-working:/app/working \
  -v qwenpaw-secret:/app/working.secret \
  -v qwenpaw-backups:/app/working.backups \
  -v qdm-data:/app/qdm-data \
  -v "${secret_dir}:/run/secrets:ro" \
  -p "${bind_addr}:${port}:8088" \
  "${image}"
"$@"
