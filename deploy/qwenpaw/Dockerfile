# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG PYTHON_IMAGE=python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS plugin-builder

ARG HARNESS_VERSION=0.0.56
WORKDIR /src

COPY .agents/qwenpaw .agents/qwenpaw
COPY bootstrap bootstrap
COPY npm npm
COPY packages packages
COPY scripts/build-plugin-manifest.mjs scripts/build-qwenpaw-plugin.mjs scripts/

RUN node scripts/build-qwenpaw-plugin.mjs \
  --output-dir /out \
  --version "${HARNESS_VERSION}" \
  --verify

FROM --platform=$TARGETPLATFORM ${PYTHON_IMAGE} AS artifact-fetch

ARG HARNESS_VERSION=0.0.56
ARG QDM_METRIC_CLI_VERSION=v0.1.19

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  file \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Release zips are password-protected; qdm-dev is the dev-stage password.
# Rotate the password here before production deployment.
RUN set -eu; \
  curl -fsSL -o /tmp/qdm-metric-cli.zip \
  "https://gitee.com/git_pengmd/harness-metric-release/releases/download/${QDM_METRIC_CLI_VERSION}/qdm-metric-cli-${QDM_METRIC_CLI_VERSION}-linux-amd64.zip"; \
  unzip -q -P qdm-dev /tmp/qdm-metric-cli.zip -d /tmp/metric; \
  chmod 0755 /tmp/metric/qdm-metric-cli; \
  file /tmp/metric/qdm-metric-cli | grep -q 'x86-64'; \
  curl -fsSL -o /tmp/harness-data-wikis.zip \
  "https://gitee.com/git_pengmd/harness-release/releases/download/v${HARNESS_VERSION}/harness-data-wikis-v${HARNESS_VERSION}.zip"; \
  unzip -q -P qdm-dev /tmp/harness-data-wikis.zip -d /tmp/wikis; \
  test -f /tmp/wikis/index.md

FROM --platform=$TARGETPLATFORM ${PYTHON_IMAGE} AS runtime

ARG HARNESS_VERSION=0.0.56
ARG QWENPAW_VERSION=2.1.0
ARG QWENPAW_UID=10001
ARG QWENPAW_GID=10001

# 默认时区东八区(上海)。必须在 `qwenpaw init` 之前设置:config.json 的
# user_timezone 用 detect_system_timezone() 派生,init 生成时读到 TZ 才会
# 落库为 Asia/Shanghai;否则回退读 /etc/timezone 的 Etc/UTC。
ENV TZ=Asia/Shanghai \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PYTHONUNBUFFERED=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  QWENPAW_WORKING_DIR=/app/working \
  QWENPAW_SECRET_DIR=/app/working.secret \
  QWENPAW_BACKUP_DIR=/app/working.backups \
  QWENPAW_PORT=8088 \
  QWENPAW_MODEL_PROVIDER_ID=qdm-market \
  QWENPAW_MODEL_ID=qwen3.8-flash \
  QWENPAW_MODEL_BASE_URL=https://aig.qdama.cn/api/v1 \
  QWENPAW_MODEL_REQUIRED=1 \
  HARNESS_INSTANCE_ROOT=/opt/qdm/harness-data/instance/${HARNESS_VERSION} \
  HARNESS_DATA_ROOT=/app/qdm-data \
  HARNESS_PLUGIN_CONFIG=/etc/qdm/qwenpaw/plugin-config.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  libmagic1 \
  nodejs \
  tini \
  && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.cache/pip \
  python -m pip install --retries 10 --timeout 120 \
  "setuptools<82" \
  "qwenpaw==${QWENPAW_VERSION}"

RUN groupadd --gid "${QWENPAW_GID}" qwenpaw \
  && useradd --uid "${QWENPAW_UID}" --gid "${QWENPAW_GID}" --create-home --home-dir /home/qwenpaw --shell /bin/sh qwenpaw \
  && install -d -o qwenpaw -g qwenpaw -m 0700 \
  /app/working \
  /app/working.secret \
  /app/working.backups \
  /app/qdm-data \
  /opt/qdm/harness-data/instance \
  /etc/qdm/qwenpaw \
  && install -d -o qwenpaw -g qwenpaw -m 0555 /run/secrets \
  && install -d -o root -g root -m 0755 /opt/qdm/bin /opt/qdm/plugin-source /opt/qdm/qwenpaw-seed

COPY --from=plugin-builder /out/qdm-harness-qwenpaw /opt/qdm/plugin-source
COPY --from=artifact-fetch --chmod=0755 /tmp/metric/qdm-metric-cli /tmp/qdm-metric-cli
COPY --from=artifact-fetch /tmp/wikis /tmp/harness-wikis/
COPY --chmod=0755 deploy/qwenpaw/entrypoint.sh /opt/qdm/bin/entrypoint.sh
COPY --chmod=0755 deploy/qwenpaw/configure_model.py /opt/qdm/bin/configure_model.py

RUN chown -R qwenpaw:qwenpaw /opt/qdm/harness-data /opt/qdm/qwenpaw-seed \
  && chmod -R a-w /opt/qdm/plugin-source \
  && chmod 0755 /tmp/qdm-metric-cli

USER qwenpaw
WORKDIR /app/working

RUN python -m qwenpaw init --defaults --accept-security \
  && /opt/qdm/plugin-source/scripts/harness-data qwenpaw setup \
  --source /opt/qdm/plugin-source \
  --qwenpaw-python /usr/local/bin/python \
  --qwenpaw-working-dir /app/working \
  --instance-root "${HARNESS_INSTANCE_ROOT}" \
  --data-root "${HARNESS_DATA_ROOT}" \
  --workspace-root /app/working/workspaces/default \
  --workspace-allowlist /app/working/workspaces/default \
  --secret-dir /run/secrets \
  --plugin-config-file "${HARNESS_PLUGIN_CONFIG}" \
  --metric-cli /tmp/qdm-metric-cli \
  --wikis-source /tmp/harness-wikis \
  --channel-auth-only \
  --agent-id default \
  --yes \
  --json \
  && python -m qwenpaw plugin validate /app/working/plugins/qdm-harness-qwenpaw \
  && /app/working/plugins/qdm-harness-qwenpaw/scripts/harness-data qwenpaw doctor \
  --plugin-root /app/working/plugins/qdm-harness-qwenpaw \
  --plugin-config-file "${HARNESS_PLUGIN_CONFIG}" \
  --json

USER root

RUN cp -a /app/working/. /opt/qdm/qwenpaw-seed/ \
  && chown -R qwenpaw:qwenpaw /opt/qdm/qwenpaw-seed \
  && rm -rf /tmp/harness-wikis /tmp/qdm-metric-cli /opt/qdm/plugin-source

USER qwenpaw
WORKDIR /app/working

VOLUME ["/app/working", "/app/working.secret", "/app/working.backups", "/app/qdm-data"]

EXPOSE 8088
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=12 \
  CMD curl --fail --silent --show-error --noproxy '*' http://127.0.0.1:8088/healthz >/dev/null

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/qdm/bin/entrypoint.sh"]
CMD ["python", "-m", "qwenpaw", "app", "--host", "0.0.0.0", "--port", "8088"]
