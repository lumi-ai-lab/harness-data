# QwenPaw Runtime MCP authorization materials

Runtime MCP 主启动（`deploy/qwenpaw/run_docker.sh`）使用由运维方管理、只读挂载的独立密钥目录：

```text
qdm-auth-runtime.token
session-hmac.secret
```

通过 `QDM_RUNTIME_SECRET_DIR` 指定该目录。`qdm-auth-runtime.token` 与 `session-hmac.secret` 均不得提交至 Git；后者必须至少包含 32 个随机字节。主启动脚本会首次生成缺失的 HMAC 文件，但绝不覆盖已有文件。

`channel-auth.json` 仅用于 `deploy/qwenpaw/run_docker_rollback.sh` 的 explicit legacy 回滚模式。回滚目录由 `QDM_CHANNEL_SECRET_DIR` 指定，文件继续使用既有的双层 `credentials` 和 `channelUserIndex` 格式，并必须由导出任务持续更新。

On Windows, restrict both files to the QwenPaw runtime account, `Administrators`,
and `SYSTEM`. After placing the files in an extracted runtime, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\agents\qwenpaw\prepare-qwenpaw-materials.ps1 -Runtime <runtime>
```

The installer verifies this ACL and fails closed when it is broader. Do not place `auth.blob`, plaintext authorization data, or a real Secret in this repository.

On Linux/Docker, the plugin does not read these runtime-relative files. The Runtime MCP main script mounts `qdm-auth-runtime.token` and `session-hmac.secret` read-only at `/run/secrets`; both must be regular files that the QwenPaw runtime UID/GID can read. `deploy/qwenpaw/run_docker.sh` verifies their readability from inside the image as the runtime UID before starting the container. The legacy rollback script instead verifies read-only `/run/secrets/channel-auth.json` and `/run/secrets/session-hmac.secret`; `channel-auth.json` may remain owned by the account whose scheduled export job rewrites it daily, provided the legacy container UID/GID can read it (`0644`, or `0640` with that GID).
Linux runtime binaries are named `bin/data-harness-cli` and
`bin/qdm-metric-cli` and must have the owner execute bit set.
