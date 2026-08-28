# QwenPaw 生产环境插件安装手册

本文适用于 QwenPaw 兼容代码已合并 `master`、并通过 Release 发布后的生产安装。

## 一、Windows

### 1. 前置条件

- Windows 当前登录账号运行 QwenPaw。
- QwenPaw 版本为 2.1.x，并支持公开 API `register_runtime_hook_now()`。
- 使用与 QwenPaw 相同的 Python 环境。
- 已准备实际的 `channel-auth.json` 和 `session-hmac.secret`。
- QwenPaw Agent 已存在，例如 `qdmDataAgent`。

### 2. 安装 Harness Data runtime

```powershell
$runtime = "C:\ProgramData\QDM\harness-data-runtime"

npx @lumi-ai-lab/harness-data install `
  --dir $runtime
```

安装完成后，runtime 应包含：

```text
<runtime>\
├─ agents\qwenpaw\
├─ bin\
├─ bootstrap\
├─ config\qwenpaw\
└─ .harness\
```

### 3. 放置授权文件

将真实文件放入：

```text
<runtime>\config\qwenpaw\channel-auth.json
<runtime>\config\qwenpaw\session-hmac.secret
```

`channel-auth.json` 使用两层索引格式：

```json
{
  "credentials": {
    "cred_001": {
      "ciphertext": "qdm1enc.…"
    }
  },
  "channelUserIndex": {
    "feishu": {
      "ou_xxx": "cred_001"
    },
    "wecom": {
      "zhangsan": "cred_001"
    }
  }
}
```

不要放置、读取或修改原安装器生成的 `auth.blob`。

### 4. 收紧 Windows ACL

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$runtime\agents\qwenpaw\prepare-qwenpaw-materials.ps1" `
  -Runtime $runtime
```

授权文件应满足：当前账号只读，`SYSTEM` 和 `Administrators` 完全控制，不允许 `Everyone`、`Users` 或 `Authenticated Users` 广泛读取。

### 5. 安装 QwenPaw 插件

默认 `tool_policy` 为 `preserve`，会保留 Agent 原有的非 QDM 工具：

```powershell
npx @lumi-ai-lab/harness-data qwenpaw install `
  --runtime $runtime `
  --qwenpaw-python "D:\Program Files\Python313\python.exe" `
  --agent-id qdmDataAgent
```

如需专用 QDM Agent，仅启用 QDM 工具：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$runtime\agents\qwenpaw\INSTALL-QWENPAW-COMMAND-DEBUG.ps1" `
  -Runtime $runtime `
  -QwenPawPython "D:\Program Files\Python313\python.exe" `
  -AgentId qdmDataAgent `
  -ToolPolicy strict
```

### 6. qdm-userid 调试回显（可选）

仅在验证阶段开启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$runtime\agents\qwenpaw\INSTALL-QWENPAW-COMMAND-DEBUG.ps1" `
  -Runtime $runtime `
  -QwenPawPython "D:\Program Files\Python313\python.exe" `
  -AgentId qdmDataAgent `
  -UserIdDisplayMode command
```

生产验证完成后关闭：

```powershell
npx @lumi-ai-lab/harness-data qwenpaw install `
  --runtime $runtime `
  --qwenpaw-python "D:\Program Files\Python313\python.exe" `
  --agent-id qdmDataAgent `
  --user-id-display-mode off
```

### 7. 安装检查

```powershell
npx @lumi-ai-lab/harness-data qwenpaw doctor `
  --runtime $runtime `
  --qwenpaw-python "D:\Program Files\Python313\python.exe" `
  --agent-id qdmDataAgent
```

应检查 QwenPaw 版本/API、runtime CLI、授权文件格式与 ACL、Agent 工具策略、插件配置和插件状态。

### 8. Windows 验收

- 企微单聊、企微群聊 `@机器人`；
- 飞书单聊、飞书群聊 `@机器人`；
- 未知用户、无效 Blob、无权限区域拒绝；
- 飞书共享会话/话题拒绝；
- 普通 `qdm_query` 不进入报告流程；
- 区域/分类显示名称能解析为授权 ID；
- 权限预检失败时不启动 QDM CLI；
- `preserve` 不关闭已有非 QDM Agent 工具。

## 二、Linux / Docker

### 1. 前置条件

- Linux 当前运行账号运行 QwenPaw。
- QwenPaw 2.1.x，支持 `register_runtime_hook_now()`。
- QwenPaw 工作目录默认是 `~/.qwenpaw`。
- CLI 使用无 `.exe` 后缀：`bin/data-harness-cli`、`bin/qdm-metric-cli`。

### 2. 安装 runtime

```bash
export RUNTIME=/opt/qdm/harness-data-runtime
npx @lumi-ai-lab/harness-data install --dir "$RUNTIME"
```

### 3. 准备只读 Secret

Linux/Docker 插件固定读取：

```text
/run/secrets/channel-auth.json
/run/secrets/session-hmac.secret
```

准备宿主机 Secret：

```bash
sudo install -d -m 700 /srv/qdm-secrets
# 将实际 channel-auth.json 和 session-hmac.secret 放入 /srv/qdm-secrets
sudo "$RUNTIME/agents/qwenpaw/prepare-qwenpaw-materials.sh" /srv/qdm-secrets
```

脚本会校验普通文件、拒绝符号链接，设置 `0600`、当前 QwenPaw UID/GID 所有权，并禁止 Secret 目录被其他用户写入。

### 4. Docker 挂载示例

```bash
docker run --rm \\
  --user "$(id -u):$(id -g)" \\
  -v "$RUNTIME:/opt/qdm/runtime:ro" \\
  -v /srv/qdm-secrets/channel-auth.json:/run/secrets/channel-auth.json:ro \\
  -v /srv/qdm-secrets/session-hmac.secret:/run/secrets/session-hmac.secret:ro \\
  -e QWENPAW_WORKING_DIR=/home/qdm/.qwenpaw \\
  qwenpaw-image:latest
```

容器内必须保证 `/run/secrets` 可读、只读挂载，QwenPaw UID/GID 能执行 runtime 下的 CLI。

### 5. 容器内安装插件

```bash
mkdir -p /etc/qdm/qwenpaw

python "$RUNTIME/agents/qwenpaw/install-qwenpaw-plugin.py" install \\
  --runtime "$RUNTIME" \\
  --source "$RUNTIME/agents/qwenpaw" \\
  --qwenpaw-python "$(command -v python)" \\
  --qwenpaw-working-dir "$HOME/.qwenpaw" \\
  --agent-id qdmDataAgent \\
  --user-id-display-mode off \\
  --tool-policy preserve
```

Linux 插件配置写入：

```text
/etc/qdm/qwenpaw/plugin-config.json
```

Linux 不读取 runtime 下的 `config/qwenpaw/channel-auth.json` 或 `session-hmac.secret`。

### 6. Linux doctor 检查

```bash
python "$RUNTIME/agents/qwenpaw/install-qwenpaw-plugin.py" doctor \\
  --runtime "$RUNTIME" \\
  --source "$RUNTIME/agents/qwenpaw" \\
  --qwenpaw-python "$(command -v python)" \\
  --qwenpaw-working-dir "$HOME/.qwenpaw" \\
  --agent-id qdmDataAgent
```

应通过：QwenPaw API、Harness/QDM CLI、渠道授权文件、HMAC Secret、Agent 工具白名单和插件配置检查。

### 7. Linux/Docker 验收

- Secret 为只读挂载，权限不宽于 `0600`；
- Secret 目录不可写；
- QwenPaw UID/GID 可读取 Secret；
- Linux CLI 无 `.exe` 后缀且可执行；
- 企微/飞书单聊和群聊 `@机器人`；
- 未 @、未知用户、无效 Blob、无权限区域拒绝；
- 飞书共享会话/话题拒绝；
- 权限预检失败时不启动 `analysis execute`；
- 普通查询不进入报告流程。

### 8. 卸载插件

```bash
python "$RUNTIME/agents/qwenpaw/install-qwenpaw-plugin.py" uninstall \\
  --runtime "$RUNTIME" \\
  --qwenpaw-python "$(command -v python)" \\
  --qwenpaw-working-dir "$HOME/.qwenpaw" \\
  --agent-id qdmDataAgent
```

卸载不会删除 `/run/secrets` 下的授权文件，也不会操作既有 `auth.blob`。

## 三、安全注意事项

- 模型不能传入 `user_id`、Blob、Secret 或 CLI 路径；身份只来自 QwenPaw `channel_meta`。
- 每次工具调用重新读取授权文件和 Blob，不缓存授权结果。
- 未知用户、损坏授权文件、无效 Blob、权限预检失败均 fail-closed。
- `qdm_query` 只接受结构化业务参数，不接受报告字段、Shell 或任意 CLI 参数。
