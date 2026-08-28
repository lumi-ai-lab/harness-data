# QwenPaw channel authorization materials

Place the operator-provided files below in this directory after extracting a runtime:

```text
config/qwenpaw/channel-auth.json
config/qwenpaw/session-hmac.secret
```

They are deliberately ignored by Git and are never generated, modified, migrated, or used as a fallback by the QwenPaw plugin installer. `channel-auth.json` must use the documented two-layer `credentials` and `channelUserIndex` format. `session-hmac.secret` must contain at least 32 random bytes.

Restrict both files to the QwenPaw runtime account, `Administrators`, and `SYSTEM`. On Windows, after placing the files in an extracted runtime, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\agents\qwenpaw\prepare-qwenpaw-materials.ps1 -Runtime <runtime>
```

The installer verifies this ACL and fails closed when it is broader. Do not place `auth.blob`, plaintext authorization data, or a real Secret in this repository.

On Linux/Docker, the plugin does not read these runtime-relative files. Mount the
operator-managed files read-only at `/run/secrets/channel-auth.json` and
`/run/secrets/session-hmac.secret`; both must be regular files owned by the
QwenPaw UID/GID, mode `0600` or stricter, with a non-writable parent directory.
The Linux installer also requires the `/run/secrets` mount to be read-only.
Linux runtime binaries are named `bin/data-harness-cli` and
`bin/qdm-metric-cli` and must have the owner execute bit set.
