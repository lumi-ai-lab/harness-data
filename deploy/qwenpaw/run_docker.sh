#!/bin/sh
set -eu

image=${QWENPAW_IMAGE:-harness-data-qwenpaw:0.0.56-amd64}
name=${QWENPAW_CONTAINER_NAME:-qwenpaw}
port=${QWENPAW_PORT:-8088}
runtime_uid=${QWENPAW_UID:-10001}
runtime_gid=${QWENPAW_GID:-10001}
proxy=${QWENPAW_HTTP_PROXY:-http://host.docker.internal:1082}
secret_dir=${QDM_CHANNEL_SECRET_DIR:?set QDM_CHANNEL_SECRET_DIR}
model_key=${QWENPAW_MODEL_API_KEY:?set QWENPAW_MODEL_API_KEY}

auth_file="$secret_dir/channel-auth.json"
hmac_file="$secret_dir/session-hmac.secret"

test -f "$auth_file" || { echo "missing regular file: $auth_file" >&2; exit 1; }

# 会话签名密钥只生成一次(48 字节 CSPRNG),绝不覆盖已有文件:它是长期
# 稳定的签名密钥,每次启动重新生成会导致派生会话 key 全部漂移。
if [ ! -f "$hmac_file" ]; then
  umask 077
  head -c 48 /dev/urandom > "$hmac_file"
  chmod 600 "$hmac_file"
  # 与 channel-auth.json 保持相同属主,否则 validate_runtime 的 owner 校验失败
  stat_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1"; }
  stat_gid() { stat -c %g "$1" 2>/dev/null || stat -f %g "$1"; }
  if ! chown "$(stat_uid "$auth_file"):$(stat_gid "$auth_file")" "$hmac_file" 2>/dev/null; then
    echo "warning: cannot chown $hmac_file; ensure its owner matches the QwenPaw process uid/gid (${runtime_uid}:${runtime_gid})" >&2
  fi
fi

docker run -d --name "${name}" \
  --platform linux/amd64 \
  --user "${runtime_uid}:${runtime_gid}" \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -e QWENPAW_MODEL_API_KEY="${model_key}" \
  -e QWENPAW_MODEL_ID="${QWENPAW_MODEL_ID:-qwen3.8-flash}" \
  -e QWENPAW_MODEL_BASE_URL="${QWENPAW_MODEL_BASE_URL:-https://aig.qdama.cn/api/v1}" \
  -e http_proxy="${proxy}" \
  -e https_proxy="${proxy}" \
  -v qwenpaw-working:/app/working \
  -v qwenpaw-secret:/app/working.secret \
  -v qwenpaw-backups:/app/working.backups \
  -v qdm-data:/app/qdm-data \
  -v "${secret_dir}:/run/secrets:ro" \
  -p "127.0.0.1:${port}:8088" \
  "${image}"
