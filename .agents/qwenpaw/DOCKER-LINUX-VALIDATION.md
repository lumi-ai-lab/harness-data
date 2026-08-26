# Linux/Docker validation

The Linux bundle uses `/etc/qdm/qwenpaw/plugin-config.json`,
`/run/secrets/channel-auth.json`, and `/run/secrets/session-hmac.secret`.
Mount the runtime read-only at `/opt/qdm/harness-data-runtime` and mount the
secret directory read-only. Run QwenPaw as the same non-root UID/GID that owns
the two secret files. The files must be regular, non-symlink files with mode
`0600`; the plugin rejects writable secret mounts, broad permissions, and
non-executable runtime binaries.

For a host-managed secret directory, run
`prepare-qwenpaw-materials.sh /srv/qdm-secrets` before creating the container,
then bind-mount that directory to `/run/secrets:ro`. The Linux tarball preserves
the executable bits for `bin/data-harness-cli`, `bin/qdm-metric-cli`, and the
preparation script.
