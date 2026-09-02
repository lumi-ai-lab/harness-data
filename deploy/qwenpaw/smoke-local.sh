#!/bin/sh
set -eu

image=${QWENPAW_IMAGE:-harness-data-qwenpaw:0.0.56-amd64}
channel_auth=${QDM_CHANNEL_AUTH_FILE:-/Users/pengmd/tmp/channel-auth.json}
pi_auth=${PI_AUTH_JSON:-${HOME}/.config/pi/auth.json}
runtime_uid=${QWENPAW_UID:-10001}
runtime_gid=${QWENPAW_GID:-10001}
runtime_proxy=${QWENPAW_RUNTIME_PROXY:-http://host.docker.internal:1082}
prefix="qwenpaw-harness-smoke-$$"
container="${prefix}-query"
channel_volume="${prefix}-channel"
model_volume="${prefix}-model"
working_volume="${prefix}-working"
secret_volume="${prefix}-secret"
backup_volume="${prefix}-backups"
data_volume="${prefix}-data"

test -f "${channel_auth}"
test -f "${pi_auth}"
docker image inspect "${image}" >/dev/null

cleanup() {
  docker rm -f "${container}" >/dev/null 2>&1 || true
  docker volume rm \
    "${channel_volume}" \
    "${model_volume}" \
    "${working_volume}" \
    "${secret_volume}" \
    "${backup_volume}" \
    "${data_volume}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for volume in \
  "${channel_volume}" \
  "${model_volume}" \
  "${working_volume}" \
  "${secret_volume}" \
  "${backup_volume}" \
  "${data_volume}"
do
  docker volume create "${volume}" >/dev/null
done

docker run --rm --platform linux/amd64 --user 0:0 --entrypoint /bin/sh \
  --mount "type=volume,src=${channel_volume},dst=/dest" \
  --mount "type=bind,src=${channel_auth},dst=/source/channel-auth.json,readonly" \
  "${image}" -c "set -eu; cp /source/channel-auth.json /dest/channel-auth.json; head -c 48 /dev/urandom > /dest/session-hmac.secret; chown ${runtime_uid}:${runtime_gid} /dest/channel-auth.json /dest/session-hmac.secret; chmod 0600 /dest/channel-auth.json /dest/session-hmac.secret; chmod 0555 /dest"

docker run --rm --platform linux/amd64 --user 0:0 --entrypoint /usr/local/bin/python \
  --mount "type=volume,src=${model_volume},dst=/dest" \
  --mount "type=bind,src=${pi_auth},dst=/source/auth.json,readonly" \
  "${image}" -c "import json, os; d=json.load(open('/source/auth.json', encoding='utf-8')); r=d.get('qdm-market') or {}; k=r.get('api_key') or r.get('apiKey') or r.get('key'); assert isinstance(k, str) and k.strip(), 'qdm-market api key missing'; p='/dest/api-key'; open(p, 'w', encoding='utf-8').write(k.strip()+'\\n'); os.chown(p, ${runtime_uid}, ${runtime_gid}); os.chmod(p, 0o600); os.chmod('/dest', 0o555)"

docker run --rm --platform linux/amd64 --user 0:0 --entrypoint /bin/sh \
  --mount "type=volume,src=${working_volume},dst=/app/working" \
  --mount "type=volume,src=${secret_volume},dst=/app/working.secret" \
  --mount "type=volume,src=${backup_volume},dst=/app/working.backups" \
  --mount "type=volume,src=${data_volume},dst=/app/qdm-data" \
  "${image}" -c "chown -R ${runtime_uid}:${runtime_gid} /app/working /app/working.secret /app/working.backups /app/qdm-data; chmod 0700 /app/working /app/working.secret /app/working.backups /app/qdm-data"

docker run --name "${container}" --platform linux/amd64 \
  --user "${runtime_uid}:${runtime_gid}" \
  --add-host host.docker.internal:host-gateway \
  --env "http_proxy=${runtime_proxy}" \
  --env "https_proxy=${runtime_proxy}" \
  --mount "type=volume,src=${channel_volume},dst=/run/secrets,readonly" \
  --mount "type=volume,src=${model_volume},dst=/run/qwenpaw-model-secret,readonly" \
  --mount "type=volume,src=${working_volume},dst=/app/working" \
  --mount "type=volume,src=${secret_volume},dst=/app/working.secret" \
  --mount "type=volume,src=${backup_volume},dst=/app/working.backups" \
  --mount "type=volume,src=${data_volume},dst=/app/qdm-data" \
  "${image}" python /opt/qdm/bin/smoke_query.py \
    --output /app/qdm-data/qwenpaw-smoke-result.json
