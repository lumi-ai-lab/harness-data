# Linux/Docker validation

The Linux bundle uses `/etc/qdm/qwenpaw/plugin-config.json`,
`/run/secrets/channel-auth.json`, and `/run/secrets/session-hmac.secret`.
Mount the runtime read-only at `/opt/qdm/harness-data-runtime` and mount the
secret directory read-only. Both secret files must be regular, non-symlink
files that the QwenPaw runtime UID/GID can read: `0644`, or `0640` with the
runtime GID as group. Ownership does not have to match the runtime UID, so an
export job running as another account can own `channel-auth.json` and rewrite
it daily. Runtime binaries still need the owner execute bit.

`session-hmac.secret` has no second writer, so `run_docker.sh` creates it with
mode `0600` and chowns it to the runtime UID/GID. `deploy/qwenpaw/run_docker.sh`
probes both files from inside the image as the runtime UID before starting the
container and exits non-zero when either is unreadable; that check also covers
a missing `o+x` traverse bit on any parent directory of the secret dir.
