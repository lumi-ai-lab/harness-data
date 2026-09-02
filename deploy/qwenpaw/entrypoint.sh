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

python /opt/qdm/bin/validate_runtime.py

model_required=${QWENPAW_MODEL_REQUIRED:-1}
model_key_file=${QWENPAW_MODEL_API_KEY_FILE:-/run/qwenpaw-model-secret/api-key}
if [ -f "${model_key_file}" ]; then
  python /opt/qdm/bin/configure_model.py
elif [ "${model_required}" = "1" ]; then
  echo "QwenPaw model configuration failed: required key file is unavailable: ${model_key_file}" >&2
  exit 78
fi

exec "$@"
