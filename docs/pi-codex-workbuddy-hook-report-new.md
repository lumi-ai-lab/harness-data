# Pi、Codex 与 WorkBuddy Hook 对比报告

> 当前状态：本文已按 `feat/windows-workbuddy-auth` 的 fix2 broker 修复更新。Windows WorkBuddy 5.3.8 的真实客户端回归已验证 Bash stdout/stderr、updatedInput 替换、deny 零副作用和会话历史无 runtime blob，第一阶段 Local Blob 生产门槛已解除。验证证据见 [WorkBuddy Windows 鉴权 fix2 回归结果](workbuddy-fix2-regression-result.md)。

对比范围：当前分支中的 Pi extension、Codex command hooks/Windows shim，以及 WorkBuddy native plugin hooks。

## 1. 结论摘要

Pi、Codex 和 WorkBuddy 都能在用户 turn 中注入 Harness context，也都具备模板命令后的上下文更新能力；三者的关键差异有两类：**执行前工具控制面与 hook transport**，以及 **可信身份/权限材料来自哪里**。

- Pi 扩展直接接收 `tool_call`，可以在工具执行前修改 `event.input.command` 或返回 `block`。
- Codex 注册 `PreToolUse matcher=Bash`，通过 stdin/stdout command hook 调用 Go `agentauthz`，返回 `permissionDecision` 和 `updatedInput`。
- WorkBuddy 已注册 `PreToolUse matcher=Bash|PowerShell|execute_command`，通过 Node adapter 调用同一个 Go `agentauthz`，返回 deny 或带完整字段保真的 updatedInput；受控命令的 updatedInput 只包含可信 `authz-exec` broker 调用，不再携带 blob。`execute_command` 只有提供可识别 executor hint 时才选择方言，否则潜在受控调用 fail closed。
- Pi 可以接收 Host 事件直传的 `_auth/_auth_user_id`，也可以读取 Lumi 按 session 管理的 requester-context envelope；Codex 与 WorkBuddy 当前没有经过验证的 ACP/Host 身份字段，只解析显式环境变量或 Local Blob 文件。

因此，WorkBuddy 的执行前安全边界采用 `PreToolUse → Go agentauthz → authz-exec broker`，没有使用 PostToolUse 降级，也没有复用 Codex 将 blob 直接放入改写命令的方式。当前实现解决的是“管理员分发凭证的本地授权注入”，不天然等同于“继承 WorkBuddy 当前登录用户权限”；后者必须等待 WorkBuddy 提供可信 ACP/Host 字段或可验证的 session envelope。

## 2. Hook 生命周期对比

| 能力 | Pi | Codex | WorkBuddy 当前实现 |
| --- | --- | --- | --- |
| session 初始化/清理 | `session_start` / `session_shutdown` | 依赖 hook payload session 和 Go Harness state，无 auth 内存槽 | 未注册 session hook；依赖稳定 `session_id` 和 Go 状态文件 |
| 静态系统指导 | `before_agent_start` | `.agents/codex/AGENTS.md` | plugin skill + UserPromptSubmit context |
| 用户问题上下文 | `context` 事件，直接改 messages | `UserPromptSubmit` command hook，返回 codex-hook JSON | `UserPromptSubmit` command hook，返回 `additionalContext` |
| 执行前工具控制 | `tool_call`，可改 input / block | `PreToolUse`，可 allow/deny/updatedInput | `PreToolUse`，可 deny/updatedInput；fix2 真实 QDM 回归已通过 |
| 执行后模板处理 | 在 `tool_call` 中把 posttool 管道附加到原命令 | `PostToolUse matcher=Bash` | `PostToolUse matcher=Bash|PowerShell|execute_command` |
| metric 鉴权 | 已实现 | 已实现，共享 Go 核心 | 已实现，共享分类核心、Windows Bash broker 与 PowerShell fail-closed；5.3.8+ 生产门槛已解除 |
| Host 身份绑定 | 支持事件 `_auth` 和 Lumi envelope | 未接入，只读本地来源 | 未接入，只读本地来源 |

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

Windows transport 当前状态：

- `cli-shim.mjs` 用 `spawnSync(..., shell:false)` 跨平台调用 Go CLI。
- `patchCodexHooksForWindows` 已按事件结构化映射 UserPromptSubmit、PreToolUse 和 PostToolUse，不再依赖只匹配 `"$cli"` 的字符串规则。
- PreToolUse 通过 `cli-shim.mjs authz-hook --agent codex` 启动，并有 Windows patch 幂等和定向测试。
- Go `agentauthz` 已共享 Bash/PowerShell 方言分类、Windows `.exe`/路径识别和方言化环境清理；Codex 仍只接受其宿主声明的 `Bash` tool name，再根据 payload/平台选择实际命令方言。

因此 Codex Windows 的仓库内启动链和鉴权核心已经补齐；真实 Codex/WorkBuddy 宿主执行器行为仍应纳入桌面端 E2E，而不能仅凭单元测试推断。

### WorkBuddy

WorkBuddy 使用原生插件 command hook：

```text
WorkBuddy hook stdin JSON
  → run-node(.cmd)
  → harness-hook.mjs
  → data-harness-cli authz-hook --agent workbuddy
  → stdout deny / updatedInput(authz-exec, no blob)
  → data-harness-cli authz-exec --agent workbuddy -- <allowed qdm args>
  → qdm-metric-cli stdout/stderr/exit code
```

适配器负责：

- 定位 workspace 和 `data-harness-cli(.exe)`。
- 在 authz 模式保留原始 `Bash|PowerShell|execute_command` tool name、完整 `tool_input`、session 和 cwd；PostToolUse 仍可为模板识别做归一化。
- 使用 lossless JSON 中转，避免 JavaScript 把大整数在送入 Go `UseNumber()` 前舍入。
- 限时执行 Go CLI。
- 校验 stdout JSON 和 updatedInput 字段保真；CLI 缺失、超时、非法 JSON 或有损改写均 fail closed。
- 拒绝任何在 allow updatedInput 中出现的 `qdm1enc.`、`--auth-blob` 或 `--auth-json`。
- deny 同时输出模型可见的脱敏 reason 和 host-visible `systemMessage`。

`authz-exec` 是 WorkBuddy 专用可信 broker：只允许 `auth describe` 和 `analysis execute`，内部解析 Local Blob、剥离模型 auth flags、清理授权来源环境变量并启动真实 metric CLI。模型不得直接调用 broker。

PreToolUse 与 PostToolUse 的适配契约必须继续分离：前者承担授权边界并保留完整输入，后者只观察执行结果和处理模板，不能承担授权补救。

## 4. 状态模型差异

| 维度 | Pi | Codex | WorkBuddy |
| --- | --- | --- | --- |
| context cache | Node 进程内缓存 | Go session state 文件 | Go session state 文件 |
| auth blob | `sessionId::userId` 内存槽 | 每次 hook 解析本地来源并写入改写 argv | broker 执行时解析；不进入 updatedInput 或 Harness session state |
| session 缺失 | 部分路径可回退 `unknown` | authz 不使用 session 槽 | 明确拒绝，不写共享 `unknown` 状态 |
| namespace | Pi session 原值 | Codex/通用 state | `workbuddy:<session_id>` |
| 多用户同 session | Host/Envelope 可按当前 turn user 重新绑定 | 依靠每次显式 Local Blob + userId | 依靠每次显式 Local Blob + userId；不自动代表 WorkBuddy 登录用户 |

WorkBuddy 已有的“稳定 session + namespace + SHA-256 文件名”策略应继续用于 Harness 状态，但不建议把完整 auth blob写入现有 session state 文件。

## 5. 可信身份来源与鉴权能力差异

### 5.1 来源与信任模型

“是否读文件”不足以描述三者的安全差异。Pi 的 Lumi envelope 虽然也是文件，但它由 Host 按 session 产生和管理，并校验 `sessionId`、有效期、`_auth` 和 `_auth_user_id`；Codex/WorkBuddy 的 Local Blob 则由部署或管理员显式配置。两者的信任主体和用户绑定语义不同。

| 来源 | Pi | Codex | WorkBuddy | 信任与绑定语义 |
| --- | --- | --- | --- | --- |
| Host 事件 `_auth/_auth_user_id` | 第一优先级 | Hook payload 未提供 | 未验证 payload 是否提供 | Host 按当前 turn 直接绑定，不读文件 |
| Lumi requester-context envelope | 第二优先级 | 未实现 | 未实现 | Host 按 session 管理的动态 envelope；会读文件，但不是 Local Blob fallback |
| `HARNESS_AUTH_BLOB` + userId | 允许本地 fallback 时支持 | 支持 | 支持 | 进程环境显式绑定，不证明 Agent 当前登录身份 |
| `HARNESS_AUTH_BLOB_FILE` + userId | 允许本地 fallback 时支持 | 支持 | 支持 | 管理员分发文件，不证明 Agent 当前登录身份 |
| `authz.blob_file` + `dev_user_id` | 允许本地 fallback 时支持 | 支持 | 支持 | 显式本地/开发配置，不得使用默认主体 |

Pi 的实际来源优先级是 `Host event > Lumi envelope > local env/file`。这里将“Pi 支持 ACP”理解为宿主能够把可信请求身份或权限材料送达扩展；仓库代码能直接证明的是 `_auth` 事件字段和 Lumi envelope 两条契约，不能仅凭 Agent 名称推断其他 ACP 字段同样可信。

Codex 与 WorkBuddy 当前共享的 Go resolver 只实现本地三种来源。`LUMI_REQUESTER_CONTEXT_DIR` 当前只属于需要从后续 shell 环境清理的敏感来源标记，不代表 Go resolver 已支持 Lumi envelope。

### 5.2 鉴权能力

| 项目 | Pi | Codex | WorkBuddy 当前实现 |
| --- | --- | --- | --- |
| 执行前识别 gated command | 是 | 是 | 是 |
| 剥离模型 auth flags | 是 | 是 | 是 |
| 注入 runtime blob | 是 | 是，直接进入受控命令 argv | 是，仅在 broker 内部进入真实 metric CLI argv |
| 缺少 blob 时阻断 | 是 | 是 | 是，PreToolUse deny |
| Host `_auth` | 是 | 否 | 未验证 payload 是否携带 |
| Lumi envelope | 是 | 否 | 未接入 |
| Local Blob | 是 | 是 | 仓库实现支持；生产 installer 暂时拒绝，staging 手工开启后验证 |
| 权限结果披露指导 | context 中注入 | AGENTS.md | plugin skill + context |
| 自动绑定 Agent 当前登录用户 | Host/Envelope 路径可实现 | 否 | 否 |

## 6. Windows 相关差异与 Codex 基线问题

Pi 的 JavaScript 鉴权识别器仍只接受 `Bash`，并使用：

- `/.../qdm-metric-cli` 路径模式；
- POSIX 单引号；
- POSIX shell operator；
- Bash command mutation。

Codex/WorkBuddy 共用的 Go 鉴权核心已覆盖 Windows 路径、`.exe`、Bash/PowerShell quoting 和方言化环境清理。Codex Windows shim 也已覆盖鉴权 PreToolUse；但 shim 只解决 Hook 启动，实际被鉴权命令的方言仍由 tool payload、executor 提示和平台分类决定。

WorkBuddy Windows 实际可能产生：

- `PowerShell`：`& '.\bin\qdm-metric-cli.exe' analysis execute ...`
- `execute_command`：具体 command/dialect 需通过宿主 smoke test 确认；
- 可能的 `Bash`：取决于 WorkBuddy 工具和运行环境。

WorkBuddy PostToolUse 可为模板命令识别归一化工具；PreToolUse 已独立保留原始 tool name 和实际 shell 方言，避免鉴权改写丢失执行器信息。

三方对比后的关键判断：

- WorkBuddy 保留 `run-node.cmd → harness-hook.mjs → spawnSync(shell:false)` 启动层。
- Go `agentauthz` 已成为 Codex/WorkBuddy 共用鉴权核心。
- shell dialect 分类和改写已经进入 Go 核心，没有继续散落在宿主 hook 字符串中。
- Codex Windows PreToolUse 已与 WorkBuddy 一起纳入定向测试；WorkBuddy 5.3.8 fix2 真实宿主 E2E 已完成。

## 7. 三种执行前 Hook 的契约成熟度

Pi 的 `tool_call` 可变输入和 block 已被仓库测试覆盖。Codex/WorkBuddy 的 PreToolUse allow/deny/updatedInput 结构、Windows shim、adapter → Go CLI 均已有仓库内测试或 smoke 证据。WorkBuddy 第一阶段 Spy CLI 还在真实客户端证明了 updatedInput 替换和 deny 零副作用。

本机 WorkBuddy 内置插件 `tencent-pptx` 和 Marketplace 插件 `ppt-implement` 都注册了 `PreToolUse`，说明 WorkBuddy 插件系统支持该生命周期事件。

真实 QDM 命令回归发现 WorkBuddy 5.3.8 的 PowerShell sandbox + ConPTY 路径丢失 stdout/stderr，并确认旧版直接 blob 改写会被持久化到会话 JSONL。fix2 已改为 Bash broker + PowerShell fail-closed，并在真实 WorkBuddy 宿主中证明：

1. Bash tool 能返回真实 JSON stdout，而非只有 exit-code 摘要；PowerShell gated 命令在执行前明确 deny。
2. 修复后的 updatedInput 只执行 broker 命令，原命令不执行。
3. deny 仍保证零工具副作用。
4. 新会话/history/diagnostic 不含完整 blob 或 auth flags。
5. `Bash`、`PowerShell`、`execute_command` 的真实 payload 与 timeout/非零退出行为无回归。

官方本地 Hook 文档已确认支持 `permissionDecision`、`updatedInput` 和 `systemMessage`；fix2 的真实 QDM stdout 与会话历史回归已经关闭第一阶段宿主门槛。

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
- Codex `cli-shim.mjs` 的 `spawnSync(shell:false)` 和按事件结构化 Windows 映射。
- WorkBuddy 的 run-node、workspace/CLI 定位、超时、stdout JSON 校验和双通道错误提示。
- WorkBuddy 的稳定 session 和 namespace 规则。

不可直接复用：

- Pi 的 Bash-only regex/quoting。
- 把 Bash 的 `unset ...;` 原样用于 PowerShell；共享核心必须继续使用方言化环境清理。
- WorkBuddy PostToolUse 的“全部归一化为 Bash”逻辑。
- 把 PostToolUse 拒绝消息当成执行前权限边界。

## 10. 建议

维持已落地的第一阶段架构：WorkBuddy `PreToolUse` 在 JavaScript 适配层保留原始 tool name 和完整 tool_input，再调用 Codex/WorkBuddy 共用的 Go `agentauthz`；权限来源仅限管理员分发的环境变量或 Local Blob 文件。

第二阶段只有在 WorkBuddy 明确提供可信 ACP/Host 身份字段，或能生成与 WorkBuddy 原始 session 严格对齐的 Lumi envelope 后才启动。届时应复用 Pi 的 `Host event > envelope > local fallback` 优先级、显式 userId、有效期/session 校验和 hard/soft failure 规则，并把来源解析收敛到共享 Go 核心。不能把普通 hook payload、模型输入或未经验证的本地文件宣称为“当前登录用户权限”。具体方案见 `docs/workbuddy-authz-plan.md` 和详细实施方案。
