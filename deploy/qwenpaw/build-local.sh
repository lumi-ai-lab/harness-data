#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "${script_dir}/../.." && pwd)
metric_repo=${QDM_METRIC_CLI_REPO:-"${repo_root}/../qdm-metric-cli"}
wikis_repo=${HARNESS_WIKIS_REPO:-"${repo_root}/../harness-data-wikis"}
image=${QWENPAW_IMAGE:-harness-data-qwenpaw:0.0.56-amd64}
version=${HARNESS_VERSION:-0.0.56}
runtime_uid=${QWENPAW_UID:-10001}
runtime_gid=${QWENPAW_GID:-10001}
build_proxy=${QWENPAW_BUILD_PROXY:-http://host.docker.internal:1082}

test -f "${metric_repo}/go.mod"
test -f "${wikis_repo}/index.md"

artifact_dir=$(mktemp -d "${TMPDIR:-/tmp}/qwenpaw-metric-artifact.XXXXXX")
cleanup() {
  rm -rf "${artifact_dir}"
}
trap cleanup EXIT INT TERM

(
  cd "${metric_repo}"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" \
    -o "${artifact_dir}/qdm-metric-cli" ./cmd/qdm-metric-cli
)
chmod 0755 "${artifact_dir}/qdm-metric-cli"
file "${artifact_dir}/qdm-metric-cli" | grep -q 'x86-64'

set -- docker buildx build \
  --load \
  --platform linux/amd64 \
  --build-context "metric_cli_artifact=${artifact_dir}" \
  --build-context "harness_wikis=${wikis_repo}" \
  --file "${script_dir}/Dockerfile" \
  --tag "${image}" \
  --build-arg "HARNESS_VERSION=${version}" \
  --build-arg "QWENPAW_UID=${runtime_uid}" \
  --build-arg "QWENPAW_GID=${runtime_gid}"

if [ -n "${build_proxy}" ]; then
  set -- "$@" \
    --build-arg "http_proxy=${build_proxy}" \
    --build-arg "https_proxy=${build_proxy}"
fi

set -- "$@" "${repo_root}"
"$@"

docker image inspect "${image}" \
  --format 'built {{.RepoTags}} id={{.Id}} size={{.Size}} architecture={{.Architecture}}'
