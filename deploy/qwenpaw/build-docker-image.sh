#!/bin/sh
set -eu

cd "$(dirname "$0")/../.."

docker buildx build \
  --load \
  --platform linux/amd64 \
  --file deploy/qwenpaw/Dockerfile \
  --tag harness-data-qwenpaw:0.0.56-amd64 \
  --build-arg HARNESS_VERSION=0.0.56 \
  --build-arg QDM_METRIC_CLI_VERSION=v0.1.19 \
  .
