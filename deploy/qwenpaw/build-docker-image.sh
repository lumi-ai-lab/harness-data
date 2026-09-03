#!/bin/sh
set -eu

cd "$(dirname "$0")/../.."

usage() {
  echo "用法: $0 [--latest-release]" >&2
  echo "  直接运行: 使用脚本内固定的版本号" >&2
  echo "  --latest-release: 自动从 Gitee 最新 Release 解析版本号" >&2
}

# 查询 Gitee 镜像仓库最新 Release 的 tag_name, 失败或未找到时输出为空
gitee_latest_tag() {
  curl -fsSL --connect-timeout 10 \
    "https://gitee.com/api/v5/repos/git_pengmd/$1/releases/latest" \
    2>/dev/null |
    grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' |
    head -n 1 |
    sed 's/.*"\([^"]*\)"$/\1/'
}

resolve_latest() {
  # harness-release 的 tag 形如 v0.0.56, 剥掉 v 即为 HARNESS_VERSION
  harness_version=$(gitee_latest_tag harness-release)
  harness_version=${harness_version#v}
  # harness-metric-release 的 tag 形如 v0.1.19, 原样保留(Dockerfile 直接拼接下载 URL)
  metric_version=$(gitee_latest_tag harness-metric-release)
  if [ -z "$harness_version" ] || [ -z "$metric_version" ]; then
    echo "错误: 无法从 Gitee 获取最新 Release 版本, 请检查网络, 或去掉 --latest-release 改用固定版本" >&2
    exit 1
  fi
  echo "从 Gitee 最新 Release 解析: harness-data=${harness_version}, qdm-metric-cli=${metric_version}"
}

case "${1:-}" in
  --latest-release)
    resolve_latest
    ;;
  "")
    harness_version=0.0.56
    metric_version=v0.1.19
    ;;
  *)
    usage
    exit 1
    ;;
esac

docker buildx build \
  --load \
  --platform linux/amd64 \
  --file deploy/qwenpaw/Dockerfile \
  --tag "harness-data-qwenpaw:${harness_version}-amd64" \
  --build-arg "HARNESS_VERSION=${harness_version}" \
  --build-arg "QDM_METRIC_CLI_VERSION=${metric_version}" \
  .

echo "构建完成: harness-data-qwenpaw:${harness_version}-amd64"
