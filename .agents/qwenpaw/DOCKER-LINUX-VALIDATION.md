# Linux/Docker validation

The Linux bundle uses `/etc/qdm/qwenpaw/plugin-config.json` and
`/run/secrets/session-hmac.secret`. In runtime MCP mode it additionally mounts
`/run/secrets/qdm-auth-runtime.token`; `channel-auth.json` is only required by
the explicit legacy/rollback mode. Mount the runtime read-only at
`/opt/qdm/harness-data-runtime` and mount the secret directory read-only.
Runtime MCP token and session secret files must be regular, non-symlink files
that the QwenPaw runtime UID/GID can read, with mode `0600` (or an equivalent
container ACL). Runtime binaries still need the owner execute bit.

`session-hmac.secret` and `qdm-auth-runtime.token` have no second writer, so
the Runtime MCP main script `deploy/qwenpaw/run_docker.sh` creates or stages
them with mode `0600` and chowns them to the runtime UID/GID. It must probe both
files from inside the image as the runtime UID before starting the container and
exit non-zero when either is unreadable; that check also covers a missing `o+x`
traverse bit on any parent directory of `QDM_RUNTIME_SECRET_DIR`.

`deploy/qwenpaw/run_docker_rollback.sh` is the legacy-only rollback entrypoint.
It must instead probe `channel-auth.json` and `session-hmac.secret` from
`QDM_CHANNEL_SECRET_DIR`, use the fixed legacy image, and must not require the
runtime MCP Token or run the runtime MCP connectivity check.
