# Harness Data 鉴权功能现状实现方案

> 历史基线：本文记录 Windows WorkBuddy 鉴权落地前的代码现状。当前分支的实现进度与剩余宿主验证项见 [Windows WorkBuddy 鉴权实施状态](workbuddy-authz-implementation-status.md)。

## 1. 文档范围

本文基于 `feat/windows-workbuddy-auth` 分支提交 `89526f6` 的代码，描述当前已经落地的 QDM 数据鉴权能力。这里的“鉴权”特指 `qdm-metric-cli` 的 data-auth/auth-blob 注入，不包括历史 CAS 登录逻辑。

结论：项目已经为 **Pi** 和 **Codex** 实现执行前鉴权；**WorkBuddy 当前明确不支持 `authz.mode=on`**。默认安装仍为 `authz.mode=off`，`--data-auth` 只用于启用内置本地测试 blob。

## 2. 配置与安装入口

配置文件为 `config/harness-config.yaml`，受支持的鉴权字段如下：

```yaml
authz:
  mode: off
  # blob_file: /path/outside/workspace/qdm-auth.blob
  # dev_user_id: explicit-user-id
  allow_local_blob: true
```

字段语义：

| 字段 | 当前语义 |
| --- | --- |
| `mode` | `off` 时 hook 不进行鉴权注入；`on` 时受控命令必须绑定有效 blob，否则拒绝执行。 |
| `blob_file` | 本地加密 blob 文件。正式环境建议使用 workspace 外的绝对路径。 |
| `dev_user_id` | 本地 blob 对应的显式主体；代码没有默认主体。 |
| `allow_local_blob` | 是否允许环境变量或文件形式的本地 blob；未配置时默认为 `true`。 |

安装器当前行为：

- 默认安装写入 `authz.mode=off`。
- `install --data-auth` 写入 `mode=on`、内置测试 blob 和 `local-test-user`，仅用于本地/测试。
- 更新时保留既有鉴权配置；当前实现会把 `mode=on + allow_local_blob=false` 迁移为 `true`，因为安装器认为无可用本地来源会形成死配置。
- 选择 WorkBuddy 且鉴权开启时，安装和更新都会被 `assertWorkBuddyAuthCompatibility` 拒绝。
- `doctor` 校验 authz 配置、CLI 路径和 WorkBuddy 的 `authz.mode=off` 限制。

历史说明：提交 `6d59a8d` 曾引入“默认开启鉴权 + `--no-auth`”，随后提交 `964444e` 明确撤销。当前 master 和本分支的最终语义均为“默认关闭，`--data-auth` 显式开启测试权限模式”。

## 3. 受控命令策略

只有真实 shell 调用中的以下命令受鉴权控制：

1. `qdm-metric-cli analysis execute ...`
   - 强制注入 `--data-auth --auth-blob '<qdm1enc...>'`。
2. `qdm-metric-cli auth describe ...`
   - 强制注入 `--auth-blob '<qdm1enc...>'`，不添加 `--data-auth`。

命令重写前会移除模型提供的 `--data-auth`、`--auth-blob`、`--auth-json`，再注入运行时解析出的 blob，避免模型自行选择身份。识别器会屏蔽引号和 heredoc，避免误改提交信息、示例文本或日志内容。

当 `mode=on` 但没有有效 blob/userId 时，受控命令必须 fail closed；普通命令不应因为鉴权缺失而被误判为数据命令。

## 4. Pi 实现链路

Pi 鉴权位于 `.agents/pi/extensions/qdm-harness`，主要组件如下：

| 组件 | 职责 |
| --- | --- |
| `index.ts` | 注册 `context`、`tool_call`、session 生命周期事件；在 turn 绑定身份，在 tool call 阶段执行鉴权。 |
| `authz-config.mjs` | 解析配置、解析 blob 来源、定位 `qdm-metric-cli`。 |
| `authz-store.mjs` | 以内存槽 `sessionId::userId` 保存 blob，并记录当前 turn 的绑定。 |
| `authz-inject.mjs` | 识别真实 Bash 调用、剥离模型 flags、重写命令、阻断未绑定命令。 |
| `lumi-envelope.mjs` | 按 session SHA-256 文件名读取 Lumi requester-context envelope。 |

执行流程：

1. `context` 事件尝试为当前 turn 绑定授权。
2. 绑定优先级为 Host `event._auth` → Lumi envelope → 本地环境变量/文件。
3. `tool_call` 再次尝试绑定，处理 sessionId 或 envelope 到达较晚的情况。
4. 仅对 `Bash` 中的受控 metric 命令改写；无 blob 时返回 `{ block: true, reason }`。
5. 有 blob 时直接修改 `event.input.command`。
6. session 启动/关闭时清理 context cache 与 authz store。

Pi 的 blob 来源能力：

| 优先级 | 来源 | `allow_local_blob=false` 时可用 |
| --- | --- | --- |
| 1 | Host `_auth` + `_auth_user_id` | 是 |
| 2 | Lumi requester-context envelope | 是 |
| 3 | `HARNESS_AUTH_BLOB` + `HARNESS_AUTH_USER_ID` | 否 |
| 4 | `HARNESS_AUTH_BLOB_FILE` + userId | 否 |
| 5 | `authz.blob_file` + `authz.dev_user_id` | 否 |

Pi 当前限制：命令解析、引号和注入语法面向 POSIX Bash，不能直接视为 Windows PowerShell/CMD 实现。

## 5. Codex 实现链路

Codex 使用 `.agents/codex/hooks.json` 中的 `PreToolUse matcher=Bash`，调用：

```text
data-harness-cli authz-hook --agent codex
```

Go 实现在 `cli/internal/agentauthz`：

- `hook.go`：解析 hook payload，保留 `tool_input` 其他字段，返回 `permissionDecision` 和 `updatedInput`。
- `auth_blob.go`：解析本地 blob 与显式 userId。
- `metric_command.go`：识别、清理并重写受控命令。
- `env.go`：普通 Bash 与受控 Bash 都清理授权来源环境变量。

Codex 当前只支持本地来源，优先级为：

```text
HARNESS_AUTH_BLOB
  → HARNESS_AUTH_BLOB_FILE
  → authz.blob_file
```

它不读取 Host `_auth`，也不读取 Lumi envelope。鉴权开启后，如果 hook 进程检测到授权来源环境变量，会给普通 Bash 和受控 Bash 加上来源清理前缀，防止普通 shell 子进程继承 blob 文件位置和 userId。

当前清理命令是 POSIX `unset ...;`，命令识别和单引号 quoting 也以 Bash 为主。PR #28 引入的 `cli-shim.mjs` 解决了 Windows 下 context/posttool hook 的启动和 `.exe` 可执行性，但 `patchCodexHooksForWindows` 只匹配含 `"$cli"` 的命令；Codex PreToolUse 使用 `"$root/bin/data-harness-cli" authz-hook`，不会被当前 patch 改写。现有 Windows patch 测试也只覆盖 UserPromptSubmit。因此，Codex 的 Go 鉴权核心已经实现，但 Windows PreToolUse 启动和 PowerShell/CMD 命令重写仍不是完整 E2E。

## 6. WorkBuddy 当前行为

WorkBuddy 插件当前只有：

- `UserPromptSubmit`：构建 Harness context。
- `PostToolUse`：在模板命令执行后注入模板上下文，并观察 metric 命令的结果安全性。

当 `authz.mode=on` 时：

- context hook 返回 `QDM_HARNESS_AUTHZ_UNSUPPORTED`。
- posttool hook 要求丢弃已经产生的 metric 结果。
- 安装器和 updater 拒绝 WorkBuddy + data-auth。
- skill 明确要求停止数据链路。

这些逻辑属于安全阻断，不是鉴权实现。由于 `PostToolUse` 发生在命令执行之后，它无法在执行前注入 blob，也不能作为 WorkBuddy 鉴权的主通道。

## 7. 已实现的安全约束

- blob 必须以 `qdm1enc.` 开头；Harness 不解密权限内容。
- userId 必须来自 Host/Envelope 或显式本地配置，不存在默认主体。
- 模型自带鉴权 flags 会被剥离并替换。
- `mode=on` 且未绑定时，受控命令 fail closed。
- Pi 使用 `sessionId::userId` 隔离身份槽；WorkBuddy context/template 状态使用 `workbuddy:` namespace 和 SHA-256 文件名。
- 完整 blob 不写入普通日志、诊断消息或 context；现有无 wrapper 模式下，它仍会出现在必要的改写命令中。
- 管理员分发的 blob 文件应位于 workspace 外，避免模型通过普通项目文件读取。
- 权限模式下，用户回答需要披露账号数据范围；范围只能来自 `qdm-metric-cli auth describe`，不能从命令行或结果元数据猜测。

## 8. 代码现状风险与一致性问题

1. **实现重复**：Pi 使用 JavaScript 鉴权栈，Codex 使用 Go 鉴权栈，两者的识别器、来源和失败语义并不完全一致。
2. **来源不一致**：Pi 支持 Host/Lumi，本分支的 Go `agentauthz` 只支持 Local Blob；README 中部分“MVP 只读本地”描述与 Pi 代码能力不完全同步。
3. **Windows 方言缺口**：Go 和 Pi 的鉴权重写仍以 Bash 为核心；PR #28 主要解决 hook 启动，并不等价于 Windows 权限注入已经完成。
4. **Codex Windows PreToolUse 未被 shim 覆盖**：当前 installer patch 不会重写鉴权 hook，且缺少相应用例。
5. **环境隔离依赖 hook**：Codex 依靠对每次 Bash 调用加 `unset` 来隔离授权来源；如果 PreToolUse 未启用或宿主不执行 updated input，隔离失效。
6. **开发 fixture 边界**：`--data-auth` 会把测试 blob 放入 runtime config；正式 WorkBuddy 方案不应把该路径当生产分发方式。

## 9. 测试覆盖概览

现有测试覆盖：

- Pi：配置解析、来源优先级、session/user 隔离、quoted/heredoc 误匹配、flags 替换、Host/Lumi 绑定、tool_call 重绑定和 fail closed。
- Codex：Local Blob 来源、工具输入字段保留、普通命令环境清理、受控命令注入、无凭证拒绝和模型 flags 拒绝。
- WorkBuddy：payload 归一化、Windows 模板命令、稳定 session、authz-on 安全拒绝、插件/版本/启用状态检查。

当前 Windows 全量 Go 测试只剩一个 POSIX 绝对路径 fixture 与 Windows 路径解析不一致的问题；它提示后续需要补充原生 Windows 鉴权测试矩阵。

## 10. 关键代码索引

- `.agents/pi/extensions/qdm-harness/index.ts`
- `.agents/pi/extensions/qdm-harness/authz-config.mjs`
- `.agents/pi/extensions/qdm-harness/authz-store.mjs`
- `.agents/pi/extensions/qdm-harness/authz-inject.mjs`
- `cli/internal/agentauthz/`
- `.agents/codex/hooks.json`
- `.agents/workbuddy/hooks/hooks.json`
- `.agents/workbuddy/scripts/harness-hook.mjs`
- `cli/internal/context/workbuddy_hook.go`
- `cli/internal/posttool/workbuddy_hook.go`
- `npm/src/lib/config.js`
- `npm/src/lib/workbuddy.js`
