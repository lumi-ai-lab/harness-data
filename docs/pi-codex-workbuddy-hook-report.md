# Pi、Codex 与 WorkBuddy Hook 对比报告

> 历史基线：本文用于落地前的 Hook 选型比较。当前分支已经按建议接入 WorkBuddy PreToolUse，实际完成情况见 [Windows WorkBuddy 鉴权实施状态](workbuddy-authz-implementation-status.md)。

对比范围：当前分支中的 Pi extension、Codex command hooks/Windows shim，以及 WorkBuddy native plugin hooks。

## 1. 结论摘要

Pi、Codex 和 WorkBuddy 都能在用户 turn 中注入 Harness context，也都具备模板命令后的上下文更新能力；三者的关键差异在于 **执行前工具控制面与 hook transport**：

- Pi 扩展直接接收 `tool_call`，可以在工具执行前修改 `event.input.command` 或返回 `block`。
- Codex 注册 `PreToolUse matcher=Bash`，通过 stdin/stdout command hook 调用 Go `agentauthz`，返回 `permissionDecision` 和 `updatedInput`。
- WorkBuddy 当前插件只注册 `UserPromptSubmit` 和 `PostToolUse`，只能在命令执行后观察结果，无法完成安全的权限注入。

因此，WorkBuddy 鉴权不能复制现有 PostToolUse 流程。其宿主形态更接近 Codex command hook，推荐以 Codex 的 `PreToolUse → Go agentauthz` 为主参考，以 Pi 的身份绑定和 fail-closed 规则为补充参考。

## 2. Hook 生命周期对比

| 能力 | Pi | Codex | WorkBuddy 当前实现 |
| --- | --- | --- | --- |
| session 初始化/清理 | `session_start` / `session_shutdown` | 依赖 hook payload session 和 Go Harness state，无 auth 内存槽 | 未注册 session hook；依赖稳定 `session_id` 和 Go 状态文件 |
| 静态系统指导 | `before_agent_start` | `.agents/codex/AGENTS.md` | plugin skill + UserPromptSubmit context |
| 用户问题上下文 | `context` 事件，直接改 messages | `UserPromptSubmit` command hook，返回 codex-hook JSON | `UserPromptSubmit` command hook，返回 `additionalContext` |
| 执行前工具控制 | `tool_call`，可改 input / block | `PreToolUse`，可 allow/deny/updatedInput | **未实现** |
| 执行后模板处理 | 在 `tool_call` 中把 posttool 管道附加到原命令 | `PostToolUse matcher=Bash` | `PostToolUse matcher=Bash|PowerShell|execute_command` |
| metric 鉴权 | 已实现 | 已实现，但命令语义为 Bash | 未实现，authz-on 时安全拒绝 |
| Host 身份绑定 | 支持 `_auth` 和 Lumi envelope | 未接入，只读 Local Blob | 未接入 |

## 3. 传输与适配层

### Pi

Pi 扩展在同一 Node 进程内运行：

```text
Pi event
  → extension index.ts
  → authz store / command rewriter
  → 直接修改 event.input.command 或返回 block
```

优势：

- 执行前对象是可变结构，不需要把命令经过额外 JSON/CLI 往返。
- 可保存进程内 `sessionId::userId` 授权槽。
- `context` 与 `tool_call` 共享内存状态。

限制：

- 当前只处理 `Bash`。
- command parser 和 quoting 是 POSIX 语义。
- 插件进程重启后内存授权槽消失，需要重新绑定。

### Codex

Codex 使用宿主 command hook，而不是进程内扩展：

```text
Codex PreToolUse stdin JSON
  → data-harness-cli authz-hook --agent codex
  → Go agentauthz
  → stdout permissionDecision / updatedInput
```

特点：

- 每次 PreToolUse 独立读取配置和 Local Blob，不依赖长生命周期内存槽。
- Go hook 会完整保留 `tool_input` 的 timeout 等未知字段，只替换 `command`。
- 无 blob 时返回 deny；有 blob 时剥离模型 flags 并返回 updatedInput。
- 普通 Bash 也会在检测到 auth source env 时增加 `unset` 前缀，降低环境继承风险。

Windows transport 存在缺口：

- `cli-shim.mjs` 本身可以用 `spawnSync(..., shell:false)` 跨平台调用 Go CLI。
- `patchCodexHooksForWindows` 只识别最终包含 `"$cli"` 的 context/posttool 命令。
- PreToolUse 鉴权命令使用 `"$root/bin/data-harness-cli" authz-hook ...`，不会被当前 patch 命中。
- 当前 Windows patch 测试只覆盖 UserPromptSubmit，没有覆盖 PreToolUse。
- 即使修复启动，Go `agentauthz` 仍使用 Bash 命令识别、POSIX 单引号和 `unset`，尚未完成 PowerShell/CMD 方言适配。

因此当前应把 Codex 视为“鉴权核心与 hook 输出协议已实现”，而不是“Windows 鉴权端到端已完成”。

### WorkBuddy

WorkBuddy 使用原生插件 command hook：

```text
WorkBuddy hook stdin JSON
  → run-node(.cmd)
  → harness-hook.mjs
  → data-harness-cli
  → stdout JSON
```

适配器负责：

- 定位 workspace 和 `data-harness-cli(.exe)`。
- 把 `Bash|PowerShell|execute_command` 归一化。
- 限时执行 Go CLI。
- 校验 stdout JSON，错误时同时输出 model-visible `additionalContext` 和 host-visible `systemMessage`。

当前 PostToolUse 归一化会只保留 `tool_input.command`，这适合模板观察，但不适合 PreToolUse 的 `updatedInput`，因为 timeout 等其他字段必须原样保留。

## 4. 状态模型差异

| 维度 | Pi | Codex | WorkBuddy |
| --- | --- | --- | --- |
| context cache | Node 进程内缓存 | Go session state 文件 | Go session state 文件 |
| auth blob | `sessionId::userId` 内存槽 | 每次 hook 读取 Local Blob | 无 |
| session 缺失 | 部分路径可回退 `unknown` | authz 不使用 session 槽 | 明确拒绝，不写共享 `unknown` 状态 |
| namespace | Pi session 原值 | Codex/通用 state | `workbuddy:<session_id>` |
| 多用户同 session | auth store 绑定当前 turn user | 依靠每次 Local Blob + userId | 尚无授权槽 |

WorkBuddy 已有的“稳定 session + namespace + SHA-256 文件名”策略应继续用于 Harness 状态，但不建议把完整 auth blob写入现有 session state 文件。

## 5. 鉴权能力差异

| 项目 | Pi | Codex | WorkBuddy 当前实现 |
| --- | --- | --- | --- |
| 执行前识别 gated command | 是 | 是 | 否 |
| 剥离模型 auth flags | 是 | 是 | 否 |
| 注入 runtime blob | 是 | 是 | 否 |
| 缺少 blob 时阻断 | 是 | 是 | 只能在 context 提示；PostToolUse 已经太晚 |
| Host `_auth` | 是 | 否 | 未验证 payload 是否携带 |
| Lumi envelope | 是 | 否 | 未接入 |
| Local Blob | 是 | 是 | 安装器禁止与 WorkBuddy 组合 |
| 权限结果披露指导 | context 中注入 | AGENTS.md | skill 当前要求 authz-on 时停止 |

## 6. Windows 相关差异与 Codex 基线问题

Pi 和 Codex 的当前鉴权识别器都只接受 `Bash`，并使用：

- `/.../qdm-metric-cli` 路径模式；
- POSIX 单引号；
- POSIX shell operator；
- Bash command mutation。

Codex 的 Windows shim 解决了 context/posttool 的 hook 启动问题，但尚未覆盖鉴权 PreToolUse；此外，它不会自动改变被鉴权工具命令本身的 shell 方言。

WorkBuddy Windows 实际可能产生：

- `PowerShell`：`& '.\bin\qdm-metric-cli.exe' analysis execute ...`
- `execute_command`：具体 command/dialect 需通过宿主 smoke test 确认；
- 可能的 `Bash`：取决于 WorkBuddy 工具和运行环境。

当前 WorkBuddy PostToolUse 把三种工具都归一化成 `Bash`，是因为它只做模板命令识别。鉴权改写不能沿用这种信息丢失：PreToolUse 必须保留原始 tool name 和实际 shell 方言。

三方对比后的关键判断：

- WorkBuddy 的 `run-node.cmd → harness-hook.mjs → spawnSync(shell:false)` transport 比当前 Codex installer-time JSON patch 更稳定，可直接作为 WorkBuddy 启动层。
- Go `agentauthz` 应成为 Codex/WorkBuddy 共用鉴权核心。
- shell dialect 分类和改写应进入 Go 核心，而不是继续散落在宿主 hook 字符串中。
- Codex Windows PreToolUse 应与 WorkBuddy 改造一起补测，避免共享核心只在 WorkBuddy 上通过。

## 7. 三种执行前 Hook 的契约成熟度

Pi 的 `tool_call` 可变输入和 block 已被仓库测试覆盖。Codex 的 PreToolUse allow/deny/updatedInput 结构也有 Go 单测覆盖，但 Windows 启动链未形成 E2E。

本机 WorkBuddy 内置插件 `tencent-pptx` 和 Marketplace 插件 `ppt-implement` 都注册了 `PreToolUse`，说明 WorkBuddy 插件系统支持该生命周期事件。

但当前 harness-data 仓库和这些本机示例没有证明以下能力：

1. 是否接受 Claude/Codex 风格的 `hookSpecificOutput.permissionDecision`。
2. 是否接受并实际执行 `hookSpecificOutput.updatedInput`。
3. `Bash`、`PowerShell`、`execute_command` 的真实 stdin payload 分别是什么。
4. deny 后宿主是否保证命令完全不执行。
5. hook 的环境变量是否也会被后续 shell 工具继承。

这些是实现前必须完成的 transport contract spike。只验证 hook 被调用还不够，必须验证“改写后的命令被执行、原命令未执行”和“deny 时零副作用”。

## 8. 为什么 PostToolUse 不能承担鉴权

PostToolUse 适合：

- 根据已完成的 template stage/inject 更新模型上下文。
- 检测异常结果并要求模型丢弃。
- 记录诊断信息。

它不适合鉴权，因为：

- 无法阻止未授权命令先访问数据。
- 无法在执行前替换模型提供的 blob。
- 即使随后要求“丢弃结果”，数据已经进入工具输出和模型上下文。

安全边界必须放在 PreToolUse 或更底层的受控执行 wrapper，不能放在 PostToolUse。

## 9. 可复用与不可直接复用部分

可复用：

- Pi 的来源优先级、显式 userId、fail-closed、模型 flags 替换规则。
- Codex Go `agentauthz` 的 command-hook 架构、hook 输出结构、Local Blob 解析和 `tool_input` 字段保留逻辑。
- Codex `cli-shim.mjs` 的 `spawnSync(shell:false)` 思路，但不能沿用当前只匹配 `"$cli"` 的 patch 方式。
- WorkBuddy 的 run-node、workspace/CLI 定位、超时、stdout JSON 校验和双通道错误提示。
- WorkBuddy 的稳定 session 和 namespace 规则。

不可直接复用：

- Pi 的 Bash-only regex/quoting。
- Codex 的 `unset ...;` 环境清理。
- Codex 当前未覆盖 PreToolUse 的 Windows patch。
- WorkBuddy PostToolUse 的“全部归一化为 Bash”逻辑。
- 把 PostToolUse 拒绝消息当成执行前权限边界。

## 10. 建议

以 WorkBuddy `PreToolUse` 为主入口，在 JavaScript 适配层保留原始 tool name 和完整 tool_input，再调用 Codex 已采用的 Go `agentauthz` 核心。同步把 Codex Windows PreToolUse 纳入跨平台 transport/方言测试。第一阶段支持管理员分发的 Local Blob；Host `_auth`/Lumi envelope 作为宿主契约明确后的第二阶段能力。具体修改见 `docs/workbuddy-authz-plan.md`。
