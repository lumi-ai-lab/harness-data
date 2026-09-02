# QwenPaw channel authorization materials

Place the operator-provided files below in this directory after extracting a runtime:

```text
config/qwenpaw/channel-auth.json
config/qwenpaw/session-hmac.secret
```

They are deliberately ignored by Git and are never generated, modified, migrated, or used as a fallback by the QwenPaw plugin installer. `channel-auth.json` must use the documented two-layer `credentials` and `channelUserIndex` format. `session-hmac.secret` must contain at least 32 random bytes.

On Windows, restrict both files to the QwenPaw runtime account, `Administrators`,
and `SYSTEM`. After placing the files in an extracted runtime, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\agents\qwenpaw\prepare-qwenpaw-materials.ps1 -Runtime <runtime>
```

The installer verifies this ACL and fails closed when it is broader. Do not place `auth.blob`, plaintext authorization data, or a real Secret in this repository.

On Linux/Docker, the plugin does not read these runtime-relative files. Mount the
operator-managed files read-only at `/run/secrets/channel-auth.json` and
`/run/secrets/session-hmac.secret`; both must be regular files that the QwenPaw
runtime UID/GID can read (`0644`, or `0640` with that GID). The owner does not
have to be the runtime UID, so `channel-auth.json` can stay owned by the account
whose scheduled job rewrites it daily. `deploy/qwenpaw/run_docker.sh` verifies
readability from inside the image as the runtime UID before starting the container.
Linux runtime binaries are named `bin/data-harness-cli` and
`bin/qdm-metric-cli` and must have the owner execute bit set.
