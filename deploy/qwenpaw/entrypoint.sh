#!/bin/sh
set -eu

seed=/opt/qdm/qwenpaw-seed
working=${QWENPAW_WORKING_DIR:-/app/working}
plugin_seed=${seed}/plugins/qdm-harness-qwenpaw
plugin_target=${working}/plugins/qdm-harness-qwenpaw
plugin_stage=${working}/plugins/.qdm-harness-qwenpaw.image-stage

if [ ! -f "${working}/config.json" ]; then
  cp -a "${seed}/." "${working}/"
fi

# config.json is seeded once: the copy baked into the image records whatever
# TZ `qwenpaw init` saw at build time, and a reused working volume keeps its
# existing file forever. So `ENV TZ` alone cannot fix an install whose
# user_timezone was detected as Etc/UTC. Align it with the runtime TZ, but only
# while it still holds an untouched default: a timezone the operator picked in
# the UI/API must survive restarts.
tz=${TZ:-}
if [ -n "${tz}" ] && [ -f "${working}/config.json" ]; then
  python /opt/qdm/bin/align_timezone.py "${working}/config.json" "${tz}" ||
    echo "warning: user_timezone alignment skipped for ${working}/config.json" >&2
fi

# The plugin is image-managed while channel/model/session configuration lives
# elsewhere in the persistent working volume. Refresh it on every container
# start so rebuilding this Dockerfile cannot leave an older plugin behind in a
# reused volume.
test -d "${plugin_seed}"
mkdir -p "${working}/plugins"
if [ -d "${plugin_stage}" ]; then
  chmod -R u+w "${plugin_stage}"
  rm -rf "${plugin_stage}"
fi
cp -a "${plugin_seed}" "${plugin_stage}"
if [ -d "${plugin_target}" ]; then
  chmod -R u+w "${plugin_target}"
  rm -rf "${plugin_target}"
fi
mv "${plugin_stage}" "${plugin_target}"
chmod -R a-w "${plugin_target}"

# The QDM agent has to exist before the model is pointed at it. This is also the
# upgrade path for a persistent volume created by an older image: the seed above
# is copied only when config.json is absent, so the agent and the WeCom/Feishu
# binding are adopted here instead.
python /opt/qdm/bin/ensure_qdm_agent.py

# 镜像托管技能(officecli-*、charts-cli)随镜像刷新到宿主 default 与每个
# harness-data-* agent(持久卷升级、运行时新建的 agent 都由这一步幂等覆盖,
# 与 plugin 刷新同策略: 镜像版本为唯一真相)。
python /opt/qdm/bin/seed_image_skills.py

model_required=${QWENPAW_MODEL_REQUIRED:-1}
model_key=${QWENPAW_MODEL_API_KEY:-}
if [ -n "${model_key}" ]; then
  python /opt/qdm/bin/configure_model.py
elif [ "${model_required}" = "1" ]; then
  echo "QwenPaw model configuration failed: QWENPAW_MODEL_API_KEY is unset" >&2
  exit 78
fi

exec "$@"
