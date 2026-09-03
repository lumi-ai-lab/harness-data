#!/usr/bin/env bash
# 热修复: 把已修复的 authz-hook (storeId 透传给 CLI 强制门店链) 替换到生产容器 qwenpaw。
#
# 用法 (密码走环境变量, 不落盘):
#   QDM_SSH_PASSWORD=xxx ./hotfix-authz-hook.sh            # deploy(默认): 备份+替换+自检
#   QDM_SSH_PASSWORD=xxx ./hotfix-authz-hook.sh verify     # 仅授权验证, 不改动任何文件
#   QDM_SSH_PASSWORD=xxx ./hotfix-authz-hook.sh rollback   # 从 .orig 回滚到热补丁前状态
#   QDM_SSH_PASSWORD=xxx ./hotfix-authz-hook.sh inspect    # 只读查看容器当前状态
#
# 连接参数可用环境变量覆盖:
#   QDM_SSH_HOST / QDM_SSH_PORT / QDM_SSH_JUMP / QDM_CONTAINER / QDM_CONTEXT_FILE
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_HOST="${QDM_SSH_HOST:-ztadmin@10.111.105.15}"
SSH_PORT="${QDM_SSH_PORT:-8166}"
SSH_JUMP="${QDM_SSH_JUMP:-yanjianhao@hnbh.qdama.cn:60022}"
JUMP_PORT="${SSH_JUMP##*:}"
JUMP_HOST="${SSH_JUMP%:*}"
CONTAINER="${QDM_CONTAINER:-qwenpaw}"
# 生产实例的 Root Context: Python 适配器 qdm_cli.py 用它加载启用鉴权的
# harness-config.yaml (authz.mode: on), 不带此文件会读到插件根目录 → authz disabled
CTX_FILE="${QDM_CONTEXT_FILE:-/opt/qdm/harness-data/instance/0.0.56/context.json}"
TARGET="/app/working/plugins/qdm-harness-qwenpaw/dist/data-harness-cli/src/lib/authz/hook.js"
LOCAL_HOOK="$REPO_ROOT/dist/qdm-harness-qwenpaw/dist/data-harness-cli/src/lib/authz/hook.js"
SRC_HOOK="$REPO_ROOT/packages/data-harness-cli/src/lib/authz/hook.js"
# 透传标记: 用注释里的短语避免引号干扰远端 grep 引用
MARKER='rejects store-chain queries'
MODE="${1:-deploy}"

if [[ -z "${QDM_SSH_PASSWORD:-}" ]]; then
  echo "error: 需要 QDM_SSH_PASSWORD 环境变量(服务器密码, 同跳板机)" >&2
  exit 2
fi

# 跳板机与目标机用同一密码; 内层 sshpass 应答跳板机, 外层应答目标机。
# 文件上传不用 scp: macOS 自带 scp 会撞上本地 HTTP_PROXY, 这里直接用 ssh stdin 管道。
ssh_cmd() {
  sshpass -p "$QDM_SSH_PASSWORD" ssh -o StrictHostKeyChecking=accept-new \
    -o ProxyCommand="sshpass -p '$QDM_SSH_PASSWORD' ssh -o StrictHostKeyChecking=accept-new -W %h:%p -p $JUMP_PORT $JUMP_HOST" \
    -p "$SSH_PORT" "$SSH_HOST" "$@"
}

upload_cmd() { # 用法: upload_cmd <本地文件> <远端路径>
  ssh_cmd "cat > '$2'" < "$1"
}

preflight() {
  if [[ ! -f "$LOCAL_HOOK" ]]; then
    echo "error: 本地未找到 dist hook.js: $LOCAL_HOOK (先构建)" >&2
    exit 2
  fi
  if ! grep -qF "$MARKER" "$LOCAL_HOOK"; then
    echo "error: dist hook.js 不含透传标记($MARKER), 拒绝部署过期文件" >&2
    exit 2
  fi
  if ! diff -q "$SRC_HOOK" "$LOCAL_HOOK" >/dev/null; then
    echo "error: dist hook.js 与源码不一致, 先重新构建" >&2
    exit 2
  fi
  node --check "$LOCAL_HOOK"
  echo "preflight ok: 本地文件为最新修复版 (含 $MARKER)"
}

deploy() {
  preflight
  echo "== 上传到服务器 /tmp/qdm-authz-hook.js (ssh stdin) =="
  upload_cmd "$LOCAL_HOOK" /tmp/qdm-authz-hook.js
  echo "== docker cp 进容器 /tmp =="
  ssh_cmd "docker cp /tmp/qdm-authz-hook.js $CONTAINER:/tmp/qdm-authz-hook.js"
  echo "== 备份原始文件 + node --check + 原子替换 =="
  ssh_cmd "docker exec -u 0 $CONTAINER sh -c '
set -eu
target=$TARGET
if [ ! -f /tmp/qdm-authz-hook.js.orig ]; then cp -p \"\$target\" /tmp/qdm-authz-hook.js.orig; fi
install -m 0444 /tmp/qdm-authz-hook.js \"\$target.new\"
node --input-type=module --check < /tmp/qdm-authz-hook.js
chown --reference=\"\$target\" \"\$target.new\" || true
mv -f \"\$target.new\" \"\$target\"
'"
  echo "== 容器内自检: 语法 + 标记 + 属主/权限 =="
  ssh_cmd "docker exec -u 0 $CONTAINER sh -c '
set -eu
node --check $TARGET
grep -qF \"$MARKER\" $TARGET && echo marker-ok
ls -l $TARGET
'"
  echo "deploy ok"
}

verify() {
  echo "== 授权预检: 企微用户 yanjianhao 查询 storeId=101001 =="
  remote=$(cat <<'PY'
import json
d = json.load(open("/run/secrets/channel-auth.json"))
cid = d["channelUserIndex"]["wecom"]["yanjianhao"]
blob = d["credentials"][cid]["ciphertext"]
print(json.dumps({
  "tool_name": "qdm_query",
  "blob": blob,
  "tool_input": {"metric": "saleAmt", "filters": {"storeId": ["101001"]}},
}))
PY
)
  out=$(ssh_cmd "docker exec $CONTAINER python -c '$(echo "$remote")' | docker exec -i $CONTAINER /app/working/plugins/qdm-harness-qwenpaw/scripts/data-harness-cli --context-file $CTX_FILE authz-hook --agent qwenpaw --format adapter-envelope")
  echo "$out"
  if echo "$out" | grep -q '"status": *"allow"'; then
    echo "verify ok: authz-hook 已放行 storeId=101001"
  else
    echo "verify failed: 未出现 \"status\":\"allow\"" >&2
    exit 1
  fi
  echo "== 近 5 分钟容器日志是否新增 QDM_STORE_OUTSIDE_DATA_SCOPE =="
  ssh_cmd "docker logs --since 5m $CONTAINER 2>&1 | grep qdm_query_failed || true" || true
}

rollback() {
  echo "== 从 /tmp/qdm-authz-hook.js.orig 回滚 =="
  ssh_cmd "docker exec -u 0 $CONTAINER sh -c '
set -eu
target=$TARGET
[ -f /tmp/qdm-authz-hook.js.orig ] || { echo \"no backup, abort\"; exit 1; }
install -m 0444 /tmp/qdm-authz-hook.js.orig \"\$target.new\"
node --input-type=module --check < /tmp/qdm-authz-hook.js.orig
chown --reference=\"\$target\" \"\$target.new\" || true
mv -f \"\$target.new\" \"\$target\"
'"
  echo "== 自检: 不应再含透传标记 =="
  ssh_cmd "docker exec -u 0 $CONTAINER sh -c 'set -eu; node --check $TARGET; if grep -qF \"$MARKER\" $TARGET; then echo still-marked; else echo marker-gone; fi'"
  echo "rollback ok"
}

inspect() {
  echo "== 容器内当前状态 (只读) =="
  ssh_cmd "docker exec qwenpaw sh -c 'set -eu; ls -l $TARGET; if grep -qF \"$MARKER\" $TARGET; then echo marker-present; else echo marker-absent; fi; ls -l /tmp/qdm-authz-hook.js.orig 2>/dev/null || echo no-backup; ls -l /app/working/plugins/qdm-harness-qwenpaw/scripts/data-harness-cli'"
}

case "$MODE" in
  deploy) deploy ;;
  verify) verify ;;
  rollback) rollback ;;
  inspect) inspect ;;
  *) echo "usage: $0 [deploy|verify|rollback|inspect]" >&2; exit 2 ;;
esac
