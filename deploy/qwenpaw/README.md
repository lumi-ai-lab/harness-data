# Harness Data QwenPaw image

This image pins QwenPaw `2.1.0`, installs the native Harness Data plugin during
the build, and targets `linux/amd64`. The image never contains channel
authorization, the session HMAC secret, or the LLM API key.

## Local build

The Dockerfile downloads the metric CLI binary and the wikis tree from the
Gitee release mirrors and unzips them during the build:

```text
https://gitee.com/git_pengmd/harness-metric-release  -> qdm-metric-cli-v<ver>-linux-amd64.zip
https://gitee.com/git_pengmd/harness-release         -> harness-data-wikis-v<ver>.zip
```

The release zip password (`qdm-dev`) is hardcoded in the Dockerfile as a
dev-stage placeholder; rotate it and update the Dockerfile before production
deployment. `build-docker-image.sh` runs the build directly with pinned values
(image tag, versions) baked into the command:

```bash
deploy/qwenpaw/build-docker-image.sh
```

The build carries no proxy configuration: `apt-get`, `pip` and the Gitee
downloads all go over the container's normal egress. Bump `HARNESS_VERSION` and
`QDM_METRIC_CLI_VERSION` in the script when building a new release.

If a specific host really cannot reach `deb.debian.org` or `pypi.org` directly,
pass the build arguments by hand. A shell `export` is not enough — `docker
buildx` does not forward proxy variables from the client environment into `RUN`
steps — and inside a build the host loopback is unreachable, so use
`host.docker.internal` rather than `127.0.0.1`:

```bash
docker buildx build --load --platform linux/amd64 \
  --file deploy/qwenpaw/Dockerfile \
  --tag harness-data-qwenpaw:0.0.56-amd64 \
  --build-arg HARNESS_VERSION=0.0.56 \
  --build-arg QDM_METRIC_CLI_VERSION=v0.1.19 \
  --build-arg http_proxy=http://host.docker.internal:1082 \
  --build-arg https_proxy=http://host.docker.internal:1082 \
  .
```

## Runtime secrets

Run as the same non-root UID/GID that owns the mounted files (the image default
is `10001:10001`). The channel secret directory must be a read-only mount.

```text
/run/secrets/channel-auth.json
/run/secrets/session-hmac.secret
```

Both files must be regular, non-symlink files with mode `0600` or stricter.
`session-hmac.secret` must contain at least 32 bytes.

The model API key is supplied at startup through the `QWENPAW_MODEL_API_KEY`
environment variable. It is read at startup, encrypted by QwenPaw into its
writable secret volume, and is never stored in an image layer.

The runtime configures the OpenAI-compatible provider `qdm-market` at
`https://aig.qdama.cn/api/v1` and activates `qwen3.8-flash`.

The Harness plugin directory is image-managed and refreshed from the immutable
image seed on every container start. Reusing an existing `/app/working` volume
therefore preserves QwenPaw channel/session configuration without retaining an
older plugin implementation after an image rebuild.

For a long-running instance, set `QDM_CHANNEL_SECRET_DIR` and
`QWENPAW_MODEL_API_KEY`, then run `deploy/qwenpaw/run_docker.sh`. The image has
to be built first (`build-docker-image.sh`). The script generates
`session-hmac.secret` (48 random bytes, mode `0600`) in
`QDM_CHANNEL_SECRET_DIR` on first use and never overwrites an existing file,
mirrors the owner of `channel-auth.json`, then starts the container with
`--restart unless-stopped`.

The service binds the host port to `127.0.0.1` by default, and the image
healthcheck polls `/healthz`; read the result with
`docker inspect --format '{{json .State.Health}}' qwenpaw`.

Proxying is opt-in and read from the caller's environment. The model gateway and
the WeCom APIs are reachable directly in mainland China, so by default
`run_docker.sh` passes no proxy variables at all. When an endpoint does need
one, configure it in the host shell before starting the script — for example the
local Shadowrocket HTTP proxy:

```bash
# Shadowrocket 代理设置
export http_proxy=http://127.0.0.1:1082
export https_proxy=http://127.0.0.1:1082
```

`run_docker.sh` forwards those values into the container and rewrites a loopback
host to `host.docker.internal`, because `127.0.0.1` inside the container is the
container itself and cannot reach the proxy port on the host.

A plain `docker run` needs the same environment instead of any model secret
mount, for example:

```bash
docker run -d --name qwenpaw \
  --platform linux/amd64 --user 10001:10001 \
  --add-host host.docker.internal:host-gateway \
  -e QWENPAW_MODEL_API_KEY="${QWENPAW_MODEL_API_KEY}" \
  -e QWENPAW_MODEL_ID=qwen3.8-flash \
  -e QWENPAW_MODEL_BASE_URL=https://aig.qdama.cn/api/v1 \
  -v qwenpaw-working:/app/working \
  -v qwenpaw-secret:/app/working.secret \
  -v qwenpaw-backups:/app/working.backups \
  -v qdm-data:/app/qdm-data \
  -v "${QDM_CHANNEL_SECRET_DIR}:/run/secrets:ro" \
  -p 127.0.0.1:8088:8088 \
  harness-data-qwenpaw:0.0.56-amd64
```

Note that an environment variable is visible to `docker inspect`; mount the
secret file instead if the key must stay out of container metadata.
