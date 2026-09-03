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
image=${QWENPAW_IMAGE:-harness-data-qwenpaw:0.0.56-amd64}
# 容器名:同名容器已存在时 docker run 会失败,需改名或先 docker rm -f
name=${QWENPAW_CONTAINER_NAME:-qwenpaw}
# 宿主机发布端口:容器内固定监听 8088
port=${QWENPAW_PORT:-8088}
# 宿主机绑定地址:默认仅 127.0.0.1(不对局域网/公网暴露)。需要外部直连时
# export QWENPAW_BIND=0.0.0.0 再跑本脚本;暴露后请自行用防火墙/反代限制来源。
bind_addr=${QWENPAW_BIND:-127.0.0.1}
# 容器运行用户 uid:决定容器内进程能读到哪些密钥文件,镜像内置默认 10001
runtime_uid=${QWENPAW_UID:-10001}
# 容器运行用户 gid:同上;密钥文件属主可以是别的账号(如 cron 的导出账号),
# 只要权限让该 UID/GID 可读即可,下方会实测一次
runtime_gid=${QWENPAW_GID:-10001}
# 渠道密钥目录:只读挂载到容器 /run/secrets,必须存放 channel-auth.json
secret_dir=${QDM_CHANNEL_SECRET_DIR:?set QDM_CHANNEL_SECRET_DIR}
# 模型网关 API Key:启动时由 QwenPaw 加密写入可写 secret 卷,不进镜像层
model_key=${QWENPAW_MODEL_API_KEY:?set QWENPAW_MODEL_API_KEY}
# 容器内存上限:默认 8GB,仅限制内存,不做其他资源限制
mem_limit=${QWENPAW_MEM_LIMIT:-8g}
# 容器时区:IANA 名称,同时用于修正持久卷里 config.json 的 user_timezone
container_tz=${QWENPAW_TZ:-Asia/Shanghai}

# 渠道授权文件:由导出任务(可能是另一个账号)每日重写,属主不限,
# 但必须对上面的容器运行 UID/GID 可读(推荐 0644),缺失即报错退出
auth_file="$secret_dir/channel-auth.json"
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
  # 无 chown 权限时放宽到 0644:保证容器读得到优先于收紧权限位。
  if ! chown "${runtime_uid}:${runtime_gid}" "$hmac_file" 2>/dev/null; then
    chmod 644 "$hmac_file"
    echo "warning: cannot chown $hmac_file to ${runtime_uid}:${runtime_gid}; relaxed to 0644" >&2
  fi
fi

# 部署期以容器视角实测一次可读性。channel-auth.json 的属主现在可以是导出账号,
# 单看权限位猜不到目录遍历位、UID 不匹配这类问题,直接以运行 UID 读一次最可靠。
docker image inspect "${image}" >/dev/null 2>&1 \
  || { echo "本地没有镜像 ${image},请先 docker load -i <镜像包>" >&2; exit 1; }
if ! docker run --rm --platform linux/amd64 \
    --entrypoint /bin/sh \
    --user "${runtime_uid}:${runtime_gid}" \
    -v "${secret_dir}:/run/secrets:ro" "${image}" \
    -c 'test -r /run/secrets/channel-auth.json && test -r /run/secrets/session-hmac.secret' >/dev/null 2>&1; then
  echo "密钥对容器运行 UID/GID ${runtime_uid}:${runtime_gid} 不可读: ${secret_dir}" >&2
  echo "  channel-auth.json 属主不限,但需 chmod 644(或 0640 且容器 GID 能组读)" >&2
  echo "  并确认 ${secret_dir} 每一级目录都有其他用户的遍历位 o+x" >&2
  exit 1
fi

proxy=${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}
if [ -n "${proxy}" ]; then
  proxy=$(printf '%s' "${proxy}" |
    sed -E 's#^(https?://)?(127\.0\.0\.1|localhost)([/:]|$)#\1host.docker.internal\3#')
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
