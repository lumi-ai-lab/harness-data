#!/bin/sh
set -eu

# 代理设置(可选,默认不走代理):模型网关 aig.qdama.cn 与企业微信 API
# 国内均可直连,直连即可。端点在海外的话,启动前在宿主机 shell 里配好
# 代理就够了,本脚本会把它透传进容器:
#
#   # Shadowrocket 代理设置
#   export http_proxy=http://127.0.0.1:1082
#   export https_proxy=http://127.0.0.1:1082
#
# 容器内的 127.0.0.1 是容器自身,连不到宿主机上的代理端口,所以脚本会把
# 回环地址改写成 host.docker.internal(配合下面的 --add-host 使用)。

# 镜像引用:标签要和 build-docker-image.sh 产出的 tag 保持一致
image=${QWENPAW_IMAGE:-harness-data-qwenpaw:0.0.56-mcp-amd64}
# 容器名:同名容器(含已停止的)在启动前由下方统一停掉并删除,本脚本可重复执行
name=${QWENPAW_CONTAINER_NAME:-qwenpaw}
# 宿主机发布端口:容器内固定监听 8088
port=${QWENPAW_PORT:-8088}
# 宿主机绑定地址:默认 0.0.0.0,局域网内可直接访问控制台(http://<服务器IP>:8088)。
# 控制台默认不做鉴权,对外暴露时请自行用防火墙/反向代理限制来源;需要收回只给
# 本机访问时 export QWENPAW_BIND=127.0.0.1 再跑本脚本,访问改用端口转发。
bind_addr=${QWENPAW_BIND:-0.0.0.0}
# 容器运行用户 uid:决定容器内进程能读到哪些密钥文件,镜像内置默认 10001
runtime_uid=${QWENPAW_UID:-10001}
# 容器运行用户 gid:同上;密钥文件属主可以是别的账号(如 cron 的导出账号),
# 只要权限让该 UID/GID 可读即可,下方会实测一次
runtime_gid=${QWENPAW_GID:-10001}
# Runtime MCP 密钥目录：只读挂载到容器 /run/secrets，必须存放 Runtime Token。
secret_dir=${QDM_RUNTIME_SECRET_DIR:?set QDM_RUNTIME_SECRET_DIR}
# 模型网关 API Key:启动时由 QwenPaw 加密写入可写 secret 卷,不进镜像层
model_key=${QWENPAW_MODEL_API_KEY:?set QWENPAW_MODEL_API_KEY}
# 容器内存上限:默认 8GB,仅限制内存,不做其他资源限制
mem_limit=${QWENPAW_MEM_LIMIT:-8g}
# 容器时区:IANA 名称,同时用于修正持久卷里 config.json 的 user_timezone
container_tz=${QWENPAW_TZ:-Asia/Shanghai}

# Runtime MCP Token：由 qdm-auth-center 侧管理，必须是容器运行 UID 所有的 0600 普通文件。
auth_file="$secret_dir/qdm-auth-runtime.token"
# 会话 HMAC 密钥文件:派生企微会话 key 的长期签名密钥,不存在时由下方生成
hmac_file="$secret_dir/session-hmac.secret"

test -f "$auth_file" || { echo "missing regular file: $auth_file" >&2; exit 1; }

# 会话签名密钥只生成一次(48 字节 CSPRNG),绝不覆盖已有文件:它是长期
# 稳定的签名密钥,每次启动重新生成会导致派生会话 key 全部漂移。
if [ ! -f "$hmac_file" ]; then
  umask 077
  head -c 48 /dev/urandom > "$hmac_file"
  chmod 600 "$hmac_file"
  # 该文件没有第二个写者,保持 0600 独占即可,只需让容器运行 UID/GID 成为属主。
  # 无法安全设置属主时终止，避免放宽敏感文件权限。
  if ! chown "${runtime_uid}:${runtime_gid}" "$hmac_file" 2>/dev/null; then
    echo "cannot securely assign $hmac_file to ${runtime_uid}:${runtime_gid}" >&2
    exit 1
  fi
fi

test ! -L "$auth_file" && test ! -L "$hmac_file" || { echo "secret files must not be symlinks" >&2; exit 1; }
[ "$(stat -c '%a' "$auth_file")" = "600" ] || { echo "runtime token must have mode 0600" >&2; exit 1; }
[ "$(stat -c '%a' "$hmac_file")" = "600" ] || { echo "session HMAC must have mode 0600" >&2; exit 1; }
[ "$(stat -c '%u' "$auth_file")" = "${runtime_uid}" ] || { echo "runtime token must be owned by UID ${runtime_uid}" >&2; exit 1; }
[ "$(stat -c '%u' "$hmac_file")" = "${runtime_uid}" ] || { echo "session HMAC must be owned by UID ${runtime_uid}" >&2; exit 1; }

# 部署期以容器视角实测 Runtime Token 和 HMAC 是否可读，目录遍历位或 UID/GID 不匹配都会失败。
docker image inspect "${image}" >/dev/null 2>&1 \
  || { echo "本地没有镜像 ${image},请先 docker load -i <镜像包>" >&2; exit 1; }
if ! docker run --rm --platform linux/amd64 \
    --entrypoint /bin/sh \
    --user "${runtime_uid}:${runtime_gid}" \
    -v "${secret_dir}:/run/secrets:ro" "${image}" \
    -c 'test -r /run/secrets/qdm-auth-runtime.token && test -r /run/secrets/session-hmac.secret' >/dev/null 2>&1; then
  echo "密钥对容器运行 UID/GID ${runtime_uid}:${runtime_gid} 不可读: ${secret_dir}" >&2
  echo "  两个密钥文件均须为 UID ${runtime_uid} 所有、模式 0600 的普通文件" >&2
  echo "  并确认 ${secret_dir} 每一级目录允许容器运行 UID 遍历" >&2
  exit 1
fi

network=${QDM_AUTH_NETWORK:-qdm-auth-network}
docker network inspect "${network}" >/dev/null 2>&1 \
  || { echo "missing Docker network: ${network}" >&2; exit 1; }
if ! docker run --rm --platform linux/amd64 \
    --network "${network}" \
    --entrypoint /usr/local/bin/python \
    --user "${runtime_uid}:${runtime_gid}" \
    -v "${secret_dir}:/run/secrets:ro" "${image}" \
    /opt/qdm/bin/check_runtime_mcp.py >/dev/null; then
  echo "Runtime MCP preflight failed; QwenPaw was not started" >&2
  exit 1
fi

proxy=${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}
if [ -n "${proxy}" ]; then
  proxy=$(printf '%s' "${proxy}" |
    sed -E 's#^(https?://)?(127\.0\.0\.1|localhost)([/:]|$)#\1host.docker.internal\3#')
fi

# 同名容器(含运行中的)先停掉再删除,让"改参数 → 重跑本脚本"一步到位。
# 配置与数据都在命名卷里,删容器不影响持久化。
if docker ps -a --format '{{.Names}}' | grep -qxF "${name}"; then
  echo "removing existing container: ${name}" >&2
  docker rm -f "${name}" >/dev/null
fi

set -- docker run -d --name "${name}" \
  --platform linux/amd64 \
  --user "${runtime_uid}:${runtime_gid}" \
  --network "${network}" \
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
