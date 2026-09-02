# Harness Data QwenPaw image

This image pins QwenPaw `2.1.0`, installs the native Harness Data plugin during
the build, and targets `linux/amd64`. The image never contains channel
authorization, the session HMAC secret, or the LLM API key.

## Local build

The local builder uses the adjacent source repositories to avoid copying an
encrypted Release password into a Docker build:

```text
../qdm-metric-cli       -> cross-compiled linux/amd64 binary
../harness-data-wikis   -> setup --wikis-source
```

Build the final image:

```bash
QWENPAW_IMAGE=harness-data-qwenpaw:0.0.56-amd64 \
  deploy/qwenpaw/build-local.sh
```

`QWENPAW_BUILD_PROXY` defaults to
`http://host.docker.internal:1082` for Docker Desktop. Set it to an empty value
when the builder has direct network access.

Production automation may prepare the same two BuildKit contexts from verified
Release assets instead. `metric_cli_artifact` must contain an executable named
`qdm-metric-cli`; `harness_wikis` must be a valid Wiki root.

## Runtime secrets

Run as the same non-root UID/GID that owns the mounted files (the image default
is `10001:10001`). Both directories must be read-only mounts.

```text
/run/secrets/channel-auth.json
/run/secrets/session-hmac.secret
/run/qwenpaw-model-secret/api-key
```

The first two files must be regular, non-symlink files with mode `0600` or
stricter. `session-hmac.secret` must contain at least 32 bytes. The model key is
read at startup, encrypted by QwenPaw into its writable secret volume, and is
never stored in an image layer.

The runtime configures the OpenAI-compatible provider `qdm-market` at
`https://aig.qdama.cn/api/v1` and activates `qwen3.8-flash`.

The Harness plugin directory is image-managed and refreshed from the immutable
image seed on every container start. Reusing an existing `/app/working` volume
therefore preserves QwenPaw channel/session configuration without retaining an
older plugin implementation after an image rebuild.

## Acceptance smoke

The local smoke script creates temporary Docker volumes, copies the runtime
secrets with the correct Linux ownership, executes the real QwenPaw lifespan,
and removes every temporary container and volume on exit:

```bash
QWENPAW_IMAGE=harness-data-qwenpaw:0.0.56-amd64 \
  deploy/qwenpaw/smoke-local.sh
```

It asks the exact acceptance question and requires at least four recognizable
metric values in the final QwenPaw response. “8 月 31 日” is fixed to
`2026-08-31`. Authorization uses the canonical authz-v2 management-area
dimension `sapArea2Id`; the QwenPaw skill tells the model to reuse the exact
dimension codes returned by `qdm_scope_summary`.

For a long-running instance, set `QDM_CHANNEL_SECRET_DIR` and
`QWENPAW_MODEL_SECRET_DIR`, then use `docker-compose.yml`. The service binds the
host port to `127.0.0.1` by default and checks `/healthz`.
