# WorkBuddy Auth Hook 方案

## 目标与范围

以现有 Codex `PreToolUse` auth hook 为基线，为 macOS WorkBuddy 接入同等的数据权限能力：

- 只门禁 `qdm-metric-cli analysis execute` 和 `qdm-metric-cli auth describe`。
- 删除模型提供的认证参数，注入当前运行时绑定的加密 Blob。
- 缺少有效授权或安全决策时，在工具执行前阻断。
- `authz.mode=on` 时，普通 Shell 命令不继承授权来源环境变量。
- 复用 Go `agentauthz` 核心；WorkBuddy adapter 只处理宿主传输差异。

M1 仅支持 macOS POSIX Shell：`Bash`、`execute_command`。PowerShell 不在本阶段范围内。

## 已验证契约

验证环境：

- WorkBuddy Desktop `5.3.11`。
- 内置 CodeBuddy CLI `2.115.0`。
- 官方 Hook 文档：<https://www.codebuddy.cn/docs/cli/hooks>。

WorkBuddy 与 Codex 都支持 `PreToolUse`、stdin JSON、`permissionDecision=allow|deny|ask` 和工具执行前输入改写。

官方文档将修改字段写作 `modifiedInput`，但 WorkBuddy `2.115.0` 实际读取 `hookSpecificOutput.updatedInput`。实现必须使用 `updatedInput`，并通过真实客户端 E2E 固化该契约。

```text
                 Codex                         WorkBuddy
配置入口         .codex/hooks.json             Marketplace Plugin hooks.json
Shell 工具       Bash                           macOS: Bash / execute_command
Hook 进程链       shell -> Go CLI                shell -> run-node -> Node -> JS adapter -> Go CLI
项目定位         从 PWD 向上查找                 CODEBUDDY_PROJECT_DIR / cwd 向上查找
输入改写         updatedInput.command           updatedInput.command
Hook 组合         当前项目配置                   多作用域合并，匹配 Hook 并行执行
异常默认行为     缺 CLI 主动 exit 2             部分异常可能继续执行，必须显式 fail-closed
```

WorkBuddy 不强制使用 Node。M1 复用现有 `context`/`posttool` adapter，是为了统一 workspace 判断、工具名归一化、输入输出校验和错误转换。

## 当前状态

WorkBuddy auth 尚未接通，`authz.mode=on` 目前通过多层主动阻断避免使用未授权结果：

```text
npm install/update
   \-- WorkBuddy + authz.mode=on
          \-- assertWorkBuddyAuthCompatibility --> 拒绝

UserPromptSubmit
   -> harness-hook.mjs context
   -> data-harness-cli context --format workbuddy-hook
          \-- authz.mode=on --> QDM_HARNESS_AUTHZ_UNSUPPORTED

Shell 工具调用
   -> 没有 Auth PreToolUse
   -> 原始命令直接执行
   -> PostToolUse
          \-- authz.mode=on --> 丢弃 metric 结果
```

当前主动阻断位置：

| 节点 | 代码位置 | 当前效果 |
|---|---|---|
| 安装 | `npm/src/commands/install.js` | 拒绝 `--agent workbuddy --data-auth` |
| 更新 | `npm/src/commands/update.js` | WorkBuddy + `authz.mode=on` 时拒绝更新 |
| 会话入口 | `cli/internal/context/workbuddy_hook.go` | 返回 `AUTHZ_UNSUPPORTED` |
| 结果入口 | `cli/internal/posttool/workbuddy_hook.go` | 丢弃已执行的 metric 结果 |
| Doctor | `npm/src/commands/doctor.js` | 要求 WorkBuddy `authz.mode=off` |
| Skill | `.agents/workbuddy/skills/qdm-harness/SKILL.md` | 指示模型停止数据流程 |

### 既有 Context 安全状态

Harness context 是 `UserPromptSubmit` 根据用户问题生成的模型运行说明，包含时间口径、分析模式、playbook/template、context files 和执行约束。它不包含授权 Blob，也不替代 authz。

| 状态 | 触发条件 | 影响 | 与 auth 的关系 |
|---|---|---|---|
| `QDM_HARNESS_BLOCKED` | 缺少稳定 `session_id` | 不生成 context，不保存 template/report 会话状态 | authz 不依赖 `session_id`，不是 auth 缺口 |
| `QDM_HARNESS_UNAVAILABLE` | adapter/CLI 异常、配置非法、索引或 context 构建失败 | WorkBuddy 会话继续，但 Harness 数据能力不可用 | 目标 PreToolUse 遇到同类配置/CLI错误时独立 `deny` |

`session_id` 只用于关联 context 与 template PostToolUse 状态。同一 WorkBuddy Desktop 的多个对话共享 Hook 配置和 workspace 状态目录，因此 template 流程必须按 session 隔离；authz 不读取或写入 `.harness/state`。

安全分支本身不是 M1 上线卡点；合法配置在正常 workspace 中仍错误进入 `QDM_HARNESS_UNAVAILABLE`，才属于实现故障和上线阻断。

## 目标链路

色系标记：`🔵` 既有节点，`🔴` 阻断结果，`🟢` 目标节点。

```text
1. 工具执行前拦截

🟢 WorkBuddy Bash / execute_command
      |
      v
🟢 Plugin PreToolUse
   matcher=Bash|execute_command
      |
      v

2. 启动 adapter

🟢 run-node -> Node -> harness-hook.mjs authz
      |
      +-- adapter 未启动/异常退出
      |      \-- exit 2 --> 🔴 宿主阻止工具调用
      |
      v

3. WorkBuddy 传输适配

🟢 校验 event / tool / tool_input.command
   定位 Harness workspace
   Bash / execute_command -> Bash
   保留完整 tool_input
      |
      +-- workspace 外 --> {} --> 执行原命令
      |
      +-- 载荷非法/运行时版本不支持
      |      \-- deny --> 🔴 阻止工具调用
      |
      v

4. 调用 Go authz 核心

🟢 data-harness-cli authz-hook --agent workbuddy
      |
      +-- CLI 缺失/超时/异常/非法输出
      |      \-- deny --> 🔴 阻止工具调用
      |
      v
🟢 agentauthz.Run
      |
      +-- 配置异常 --> deny --> 🔴 阻止工具调用
      |
      +-- authz.mode=off --> {} --> 执行原命令
      |
      v
   authz.mode=on：识别 command
      |
      +-- 普通命令
      |      +-- 无 auth env --> {} --> 执行原命令
      |      \-- 有 auth env --> allow + updatedInput.command
      |                            只增加 unset 后执行
      |
      \-- 受控命令
             +-- qdm-metric-cli analysis execute [业务参数]
             \-- qdm-metric-cli auth describe [业务参数]
                    |
                    v

5. 授权与改写

🟢 解析 Blob / userId / 固定 qdm-metric-cli 路径
      |
      +-- 任一缺失或非法
      |      \-- deny --> 🔴 阻止工具调用
      |
      v
   删除模型 auth flags
   注入运行时 Blob
   清理 auth 来源环境变量
      |
      v
   allow + updatedInput.command
      |
      v

6. 执行与结果处理

🟢 WorkBuddy 只执行 updatedInput.command
      |
      v
🔵 PostToolUse
      \-- metric 分支 no-op，不再检查 session 或丢弃结果
```

`run-node` 只负责定位 Node 并启动 JS adapter，不做鉴权，也不读取 Blob。`harness-hook.mjs authz` 处理 WorkBuddy 传输差异；命令识别、Blob 解析和命令改写由 Go `agentauthz.Run` 完成。

## 受控命令与改写规则

受控命令只有两类：

| 类型 | 模型命令形态 | 最终认证参数 |
|---|---|---|
| 数据分析 | `qdm-metric-cli analysis execute [业务参数]` | `--data-auth --auth-blob '<运行时 Blob>'` |
| 权限描述 | `qdm-metric-cli auth describe [业务参数]` | `--auth-blob '<运行时 Blob>'`，不得注入 `--data-auth` |

命令识别沿用现有 Go 核心，支持裸命令、相对/绝对路径、`$QDM_METRIC_CLI`、`${QDM_METRIC_CLI:-qdm-metric-cli}`、前置环境变量和 `source ... &&`。仅出现在引号、普通字符串或 heredoc 正文中的文本不算真实调用；其他子命令按普通命令处理。

受控命令改写顺序：

1. 要求 `authz.allow_local_blob=true`。
2. 按 `HARNESS_AUTH_BLOB` > `HARNESS_AUTH_BLOB_FILE` > `authz.blob_file` 解析非空且以 `qdm1enc.` 开头的加密 Blob。
3. 解析 userId：环境来源优先 `HARNESS_AUTH_USER_ID`，可回退 `authz.dev_user_id`；`authz.blob_file` 必须配置 `authz.dev_user_id`。
4. 解析并验证受信任的 `qdm-metric-cli` 路径。
5. 删除模型提供的 `--data-auth`、`--auth-blob`、`--auth-json`。
6. 按命令类型注入运行时认证参数。
7. 在管道、重定向、`;`、`&&` 等 Shell 尾部操作符之前插入认证参数。
8. 清理授权来源环境变量并返回 `allow + updatedInput.command`。

授权来源环境变量清理命令：

```bash
unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; <命令>
```

改写示例：

```bash
# analysis execute
unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; \
  '/trusted/path/qdm-metric-cli' analysis execute --metric saleAmt \
  --data-auth --auth-blob 'qdm1enc.runtime'

# auth describe
unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; \
  '/trusted/path/qdm-metric-cli' auth describe --auth-blob 'qdm1enc.runtime'
```

同一 Shell 输入包含多个受控调用时，必须完整改写每个调用；无法证明全部改写成功时整体 `deny`。

## 决策与失败策略

| 状态 | Hook 输出 | 工具行为 |
|---|---|---|
| Harness workspace 外 | `{}` | 执行原命令 |
| `authz.mode=off` | `{}` | 执行原命令 |
| 普通命令且无 auth env | `{}` | 执行原命令 |
| 普通命令且有 auth env | `allow + updatedInput.command` | 只执行增加 `unset` 后的命令 |
| 受控命令改写成功 | `allow + updatedInput.command` | 只执行完整改写后的命令 |
| Blob、userId、CLI、配置或运行时版本无效 | `deny + reason` | 阻止调用 |
| adapter 已启动但协议或 CLI 输出非法 | `deny + reason` | 阻止调用 |
| adapter 未启动或异常退出 | 进程退出码 `2` | 宿主阻止调用 |

约束：

- 受控命令不能以 `{}`、空 stdout、`ask` 或缺少 `updatedInput.command` 的 `allow` 放行。
- 普通命令和 `authz.mode=off` 的 `{}` 是合法 no-op。
- Harness workspace 内必须 fail-closed；workspace 外保持插件无感。
- 未知或低于 auth 最低版本的 WorkBuddy/CodeBuddy 运行时必须 `deny`。

## 组件改动

### WorkBuddy Hook

在 `.agents/workbuddy/hooks/hooks.json` 增加：

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash|execute_command",
      "hooks": [
        {
          "type": "command",
          "command": "\"${CODEBUDDY_PLUGIN_ROOT}/bin/run-node\" \"${CODEBUDDY_PLUGIN_ROOT}/scripts/harness-hook.mjs\" authz || exit 2",
          "timeout": 10
        }
      ]
    }
  ]
}
```

### JS Adapter

`harness-hook.mjs` 增加 `authz` 模式：

- 校验 `PreToolUse` 载荷并保留完整 `tool_input`。
- 将 macOS `Bash`、`execute_command` 统一为 `Bash`。
- workspace 外返回 `{}`。
- 执行运行时版本门禁。
- 调用 `data-harness-cli authz-hook --agent workbuddy`。
- 校验 `{}`、`allow`、`deny` 和 `updatedInput.command` 的合法性。
- 在 Harness workspace 内将 CLI 缺失、超时、非法 JSON 和错误事件转换为 `deny`。

### Go Authz Core

`agentauthz.Run` 接受 `codex` 和 `workbuddy`，共享：

- 配置开关和命令识别。
- Blob/userId 解析。
- 模型认证参数清理。
- CLI 路径固定。
- auth env 清理。
- allow/deny 输出。

WorkBuddy 工具别名在 JS adapter 中归一化，不加入 Go 核心。

### Context 与 PostToolUse

接通 auth hook 后：

- 移除 `context.RunWorkBuddyHook` 的 `AUTHZ_UNSUPPORTED`。
- metric PostToolUse 直接 no-op，不再检查 `session_id`、重新加载 authz 配置或丢弃结果。
- template PostToolUse 继续要求稳定 `session_id`，保留配置和模板注入安全检查。
- authz 不因缺少 `session_id` 而 `deny`；如果未来需要按 requester/session 绑定权限，应由 M3 Broker 使用可信请求上下文完成。

### Installer、Update 与 Doctor

“验收通过”是发布前门禁，不是在用户机器上执行 E2E。

- 移除 installer/update 的无条件 `assertWorkBuddyAuthCompatibility` 拒绝。
- 扩展 `inspectWorkBuddyPlugin` 校验 `PreToolUse`、adapter、launcher 和版本一致性。
- 更新时先将目标 Plugin 和 `data-harness-cli` 放入临时位置，校验后统一替换；失败时保留旧版本。
- 移除 doctor 的 `WorkBuddy authz.mode=off` 强制检查，改为检查版本、插件启用状态、auth 配置和 Blob 来源。
- 只有 fail-closed 测试和真实 Desktop E2E 通过后，才能在同一发布中移除现有阻断。

## macOS 凭证来源

```text
本地测试
  authz.blob_file: config/dev-auth.blob

管理员分发
  ~/.qdm/auth/qdm-auth.blob  mode=0600
        |
        v
  HARNESS_AUTH_BLOB_FILE + HARNESS_AUTH_USER_ID
        |
        v
  WorkBuddy Hook 读取并注入命令
```

- Finder 启动的 WorkBuddy 不应依赖终端临时 `export`。
- 管理员分发应通过用户 LaunchAgent/`launchctl setenv` 注入文件路径和 userId，并重启 WorkBuddy。
- doctor 应读取 `launchctl getenv`，不能只依赖自身继承的 `process.env`。
- Blob 文件应位于 workspace 外，权限为 `0600`。
- macOS/Unix 运行时必须拒绝 group/other 可访问的 Blob 文件。

## 上线阶段与卡点

### M1：Codex 对齐版

必须完成：

- WorkBuddy/CodeBuddy auth 最低版本运行时门禁。
- Plugin `PreToolUse` + JS adapter authz + Go `agentauthz`。
- adapter 内部显式 `deny`，启动失败统一 `exit 2`。
- CLI 缺失、超时、非法输出 fail-closed。
- metric PostToolUse 改为 no-op，template 保留 session 隔离。
- fail-closed 测试通过后原子移除 `AUTHZ_UNSUPPORTED` 和安装限制。

### M2：macOS 加固

- workspace 外 Blob + `0600`。
- LaunchAgent/`launchctl` 注入文件路径和 userId。
- 运行时文件权限拒绝和 doctor 检查。

### M3：生产化

使用 Keychain、本地 Broker 或安全 Wrapper，使 Blob 不进入 `updatedInput`、transcript 和工具命令文本。

## 风险与约束

- **并行 Hook**：WorkBuddy 会并行执行多个作用域的匹配 Hook，再浅合并结果；其他 `PreToolUse updatedInput` 可能覆盖 auth 改写。doctor 只能提示可见配置，不能给出完整安全保证。
- **Fail-open**：WorkBuddy `5.3.11` 对退出码 `1/126/127` 等非 `2` 状态可能继续执行，因此必须使用 adapter 显式 `deny` 和 Hook command `|| exit 2`。
- **Blob 可见性**：M1/M2 的完整 Blob 会进入 `updatedInput.command`，WorkBuddy debug 日志可能记录 Hook stdout。实现不得主动将 Blob 写入 stderr、reason、systemMessage、additionalContext 或自身诊断日志。
- **PowerShell**：现有命令识别、`unset`、引号和路径调用均为 POSIX 语法，M1 不支持 Windows PowerShell。
- **试点范围**：M1/M2 仅用于本地验证或受控试点；生产使用必须完成 M3。

## 验收标准

- `authz.mode=off` 时 WorkBuddy 行为与当前版本一致。
- 合法配置在 `authz.mode=on` 时正常生成 Harness context；非法配置返回 `QDM_HARNESS_UNAVAILABLE`，受控命令由 PreToolUse `deny`。
- `authz.mode=on` 时，普通 Shell 命令不继承授权来源环境变量。
- `analysis execute` 删除模型 auth flags，并注入 `--data-auth --auth-blob`。
- `auth describe` 删除模型 auth flags，只注入 `--auth-blob`。
- 多个受控调用必须全部改写，否则整体阻断。
- 缺少 Blob、userId、CLI、合法 Hook 输出或受支持运行时版本时，受控命令不能执行。
- `run-node`、模块加载或 adapter 启动异常最终产生退出码 `2`。
- macOS `Bash`、`execute_command` 能归一化并生成 POSIX 命令；PowerShell 明确不支持。
- context 与 template PostToolUse 使用同一 session，不回退共享状态。
- metric PostToolUse 不要求 `session_id`，不重复 authz 检查，也不丢弃已授权结果。
- authz 保留完整 `tool_input`，但不读取或写入 `.harness/state`。
- group/other 可访问的 Blob 文件在运行时被拒绝。
- installer 允许 `--agent workbuddy --data-auth`，doctor 能验证插件、版本、配置和 Blob 来源。
- WorkBuddy Desktop 完成真实 `auth describe` 与 `analysis execute` E2E。

## 预计改动范围

- `.agents/workbuddy/hooks/hooks.json`
- `.agents/workbuddy/scripts/harness-hook.mjs`
- `.agents/workbuddy/skills/qdm-harness/SKILL.md`
- `.agents/workbuddy/README.md`
- `cli/internal/agentauthz/hook.go`
- `cli/internal/agentauthz/auth_blob.go`
- `cli/internal/agentauthz/metric_command.go`
- `cli/internal/context/workbuddy_hook.go`
- `cli/internal/posttool/workbuddy_hook.go`
- `npm/src/lib/workbuddy.js`
- `npm/src/commands/install.js`
- `npm/src/commands/update.js`
- `npm/src/commands/doctor.js`
- `npm/README.md`
- 对应 Go、Node 和 WorkBuddy Desktop E2E 测试
