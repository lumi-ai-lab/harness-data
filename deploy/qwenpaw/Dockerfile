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
# OfficeCLI: 与技能 SKILL.md 共用同一个 release tag, 保证二进制和技能版本一致。
ARG OFFICECLI_VERSION=1.0.146

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

# OfficeCLI: 单文件静态二进制(无 Office 依赖), 随 release 固定版本 + SHA256 校验。
# bookworm 是 glibc 环境, 用非 alpine 资产; arm64 构建同样覆盖。
RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) asset="officecli-linux-x64" ;; \
    arm64) asset="officecli-linux-arm64" ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}"; \
  curl -fsSL -o /tmp/officecli "${url}/${asset}"; \
  curl -fsSL -o /tmp/officecli.SHA256SUMS "${url}/SHA256SUMS"; \
  grep -F " ${asset}" /tmp/officecli.SHA256SUMS | (cd /tmp && sha256sum -c -); \
  chmod 0755 /tmp/officecli; \
  file /tmp/officecli | grep -q 'x86-64' || file /tmp/officecli | grep -q 'aarch64'; \
  echo "OfficeCLI ${OFFICECLI_VERSION} (${asset}) verified"

# OfficeCLI 技能目录(每个技能一个含 SKILL.md 的目录, 与二进制同 tag 固定)。
RUN set -eu; \
  mkdir -p /tmp/officecli-skills; \
  url="https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v${OFFICECLI_VERSION}/skills"; \
  for name in officecli-xlsx officecli-docx officecli-pptx; do \
    mkdir -p "/tmp/officecli-skills/${name}"; \
    curl -fsSL -o "/tmp/officecli-skills/${name}/SKILL.md" "${url}/${name}/SKILL.md"; \
    head -n 1 "/tmp/officecli-skills/${name}/SKILL.md" | grep -q '^---$'; \
  done

FROM --platform=$TARGETPLATFORM ${PYTHON_IMAGE} AS runtime

ARG HARNESS_VERSION=0.0.56
ARG QWENPAW_VERSION=2.1.0
ARG QWENPAW_UID=10001
ARG QWENPAW_GID=10001
# QDM 专用 Agent 的 id。必须落在插件默认作用域 `harness-data-*` 里，且要与下面
# --workspace-root/--workspace-allowlist 使用的目录同名（宿主按 id 建 workspace 目录）。
ARG QWENPAW_QDM_AGENT_ID=harness-data-default

# 默认时区东八区(上海)。必须在 `qwenpaw init` 之前设置:config.json 的
# user_timezone 用 detect_system_timezone() 派生(探测顺序 $TZ → /etc/timezone
# → /etc/localtime),init 生成时读到 TZ 才会落库为 Asia/Shanghai;否则回退读
# /etc/timezone 的 Etc/UTC。/etc/localtime 与 /etc/timezone 在下方一并写成同一
# 个时区,让不读 $TZ 的进程也保持一致。
# 注意:持久卷里已有的 config.json 不会被镜像里的 seed 覆盖,那部分由
# entrypoint.sh 启动时按运行时 TZ 对齐。
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
  HARNESS_PLUGIN_CONFIG=/etc/qdm/qwenpaw/plugin-config.json \
  QWENPAW_QDM_AGENT_ID=${QWENPAW_QDM_AGENT_ID}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  libmagic1 \
  nodejs \
  tini \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime \
  && echo "${TZ}" > /etc/timezone

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
# OfficeCLI: 二进制进 /usr/local/bin(PATH 内置), 对所有 agent/渠道共享;
# 技能目录作为构建期安装源, 随后按 agent 分发到各自 workspace。
COPY --from=artifact-fetch --chmod=0755 /tmp/officecli /usr/local/bin/officecli
COPY --from=artifact-fetch /tmp/officecli-skills /opt/qdm/officecli-skills
COPY --chmod=0755 deploy/qwenpaw/entrypoint.sh /opt/qdm/bin/entrypoint.sh
COPY --chmod=0755 deploy/qwenpaw/configure_model.py /opt/qdm/bin/configure_model.py
COPY --chmod=0755 deploy/qwenpaw/align_timezone.py /opt/qdm/bin/align_timezone.py
COPY --chmod=0755 deploy/qwenpaw/ensure_qdm_agent.py /opt/qdm/bin/ensure_qdm_agent.py
COPY --chmod=0755 deploy/qwenpaw/seed_officecli_skills.py /opt/qdm/bin/seed_officecli_skills.py

RUN chown -R qwenpaw:qwenpaw /opt/qdm/harness-data /opt/qdm/qwenpaw-seed \
  && chmod -R a-w /opt/qdm/plugin-source \
  && chmod 0755 /tmp/qdm-metric-cli

USER qwenpaw
WORKDIR /app/working

RUN python -m qwenpaw init --defaults --accept-security \
  && python /opt/qdm/bin/ensure_qdm_agent.py \
  && /opt/qdm/plugin-source/scripts/harness-data qwenpaw setup \
  --source /opt/qdm/plugin-source \
  --qwenpaw-python /usr/local/bin/python \
  --qwenpaw-working-dir /app/working \
  --instance-root "${HARNESS_INSTANCE_ROOT}" \
  --data-root "${HARNESS_DATA_ROOT}" \
  --workspace-root "/app/working/workspaces/${QWENPAW_QDM_AGENT_ID}" \
  --workspace-allowlist "/app/working/workspaces/${QWENPAW_QDM_AGENT_ID}" \
  --secret-dir /run/secrets \
  --plugin-config-file "${HARNESS_PLUGIN_CONFIG}" \
  --metric-cli /tmp/qdm-metric-cli \
  --wikis-source /tmp/harness-wikis \
  --channel-auth-only \
  --enabled-agents 'harness-data-*' \
  --tool-policy preserve \
  --yes \
  --json \
  && python -m qwenpaw plugin validate /app/working/plugins/qdm-harness-qwenpaw \
  && /app/working/plugins/qdm-harness-qwenpaw/scripts/harness-data qwenpaw doctor \
  --plugin-root /app/working/plugins/qdm-harness-qwenpaw \
  --plugin-config-file "${HARNESS_PLUGIN_CONFIG}" \
  --qwenpaw-working-dir /app/working \
  --json

# QwenPaw 技能是 per-agent 的(无全局注册): 每个 agent 都要在自己对应的默认
# 工作目录(workspaces/<agent-id>/skills)放一份 SKILL.md, 并在该 workspace 的
# skill.json 里 enabled=true 才会被运行时加载; 以后运行时新建的 agent 需要
# 再走一遍 enable。
# - officecli-* 装到镜像内已有的 default 与 QDM agent(default 之外的宿主内置
#   QA agent 不在 QDM 作用域且自带 QwenPaw 工具限制, 不装);
# - qdm-harness 只装到 QDM agent(没有 QDM 工具的 agent 上无意义), 源取插件
#   安装目录的 skills/。
# 注意: --tool-policy preserve 保留 QwenPaw 默认全量工具(strict 收窄见
# ensure_qdm_agent.py / install-qwenpaw-plugin.py), officecli 依赖 shell/文件工具。
RUN set -eu; \
  officecli --version; \
  for agent in default "${QWENPAW_QDM_AGENT_ID}"; do \
    skills_dir="${QWENPAW_WORKING_DIR}/workspaces/${agent}/skills"; \
    mkdir -p "${skills_dir}"; \
    cp -a /opt/qdm/officecli-skills/. "${skills_dir}/"; \
    python -m qwenpaw skills enable officecli-xlsx officecli-docx officecli-pptx \
      --agent-id "${agent}"; \
  done; \
  qdm_agent="${QWENPAW_QDM_AGENT_ID}"; \
  qdm_skills_dir="${QWENPAW_WORKING_DIR}/workspaces/${qdm_agent}/skills"; \
  mkdir -p "${qdm_skills_dir}"; \
  cp -a "${QWENPAW_WORKING_DIR}/plugins/qdm-harness-qwenpaw/skills/qdm-harness" \
    "${qdm_skills_dir}/"; \
  python -m qwenpaw skills enable qdm-harness --agent-id "${qdm_agent}"

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
