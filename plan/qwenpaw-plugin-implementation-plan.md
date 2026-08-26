# QwenPaw 插件兼容：Windows 与 Linux/Docker 详细开发方案

## 1. 文档目的与已确认范围

本文定义 `harness-data` 接入 QwenPaw 的正式开发方案。首期目标是 Windows 本地运行；
Linux/Docker 是后续生产部署阶段，必须复用相同的身份、授权与工具边界，不能绕过首期设计。

本方案以 `plan/qwenpaw-plugin-poc-lessons.md` 和
`D:\Repos\qwenpaw-channel-identity-plugin\QwenPaw插件开发经验.md` 为历史实现基线。两者与本文
发生冲突时，以本文更严格的安全边界和本节确认的宿主公开 API 约束为准；任何偏离历史经验的实现，
必须增加专项自动化测试及真实渠道回归，不能仅以 mock 通过作为依据。

已确认的约束如下：

- 渠道：企微、飞书；均支持单聊和群聊。企微群聊依赖 QwenPaw 企微渠道层“仅将已 @机器人的群消息
  路由到 Agent”的宿主契约，插件只消费其 `wecom_sender_id`；飞书群聊仍仅响应携带 QwenPaw 可信
  `bot_mentioned=true` 标记的正常入站消息。插件不得根据用户文本自行解析 `@`；
- 飞书授权索引使用渠道提供的 `open_id`；
- 飞书群共享会话与话题（thread）暂不支持，检测到即拒绝 QDM 工具访问；
- 本方案仅适用于内部单租户：授权主体固定为 `channel + user_id`，不维护或推断 Corp ID、
  飞书 App ID、机器人 ID 或 Agent ID；同一授权文件不得用于多租户隔离场景；
- 授权文件由文件提供方维护。本项目只读取、校验和查询，**不**生成、更新、轮换或回写索引；
- Windows 的 QwenPaw 工作目录为当前登录用户的 `~/.qwenpaw`；语义编排 CLI 为
  `<runtime>\bin\data-harness-cli.exe`，QDM 取数 CLI 为
  `<runtime>\bin\qdm-metric-cli.exe`；渠道授权文件固定为
  `<runtime>\config\qwenpaw\channel-auth.json`；
- 现有安装器生成的 `auth.blob` 不得读取、修改、迁移或作为回退来源；
- 未来 Linux 部署形态为 Docker 容器；首期不交付 Linux 运行包。
- 可提供仅供受控测试的原始 user ID 调试回显：`user_id_display_mode` 默认 `off`，仅可配置为
  `off | command`。该能力不参与 Blob 查询、权限决策或 CLI 参数构造；生产环境保持 `off`。
- Harness 会话状态使用受控的 `session_hmac_secret` 派生会话键。Windows 首期将 Secret 固定存放于
  `<runtime>\config\qwenpaw\session-hmac.secret`，只能由当前 QwenPaw 运行账号、`Administrators` 与
  `SYSTEM` 读取；安装/doctor 只校验存在性、长度和 ACL，不显示内容。该 Secret 不属于授权文件，
  不进入 Git、Prompt、日志、工具参数或子进程环境。
- `C:\ProgramData\QDM\qwenpaw\plugin-config.json` 是唯一的 ProgramData 插件文件；它严格只保存
  `schema_version`、绝对 `runtime_dir`、`qdm_agent_id`、`user_id_display_mode` 和可选的非敏感
  `context_limits`，不得保存或覆盖敏感文件路径。`context_limits` 缺失或各项为 `null` 表示不限制；仅正整数
  启用对应的字节上限，零、负数、浮点、字符串、布尔值或未知字段均 fail-closed。

## 2. 目标、非目标与判定原则

### 2.1 目标

1. 在仓库 `.agents/qwenpaw/` 中提供可随 runtime bundle 发布的 QwenPaw 后端插件。
2. 每一次 `qdm_query` 或 `qdm_scope_summary` 调用，均从可信渠道请求中提取用户身份，以
   `channel + user_id` 查询独立授权文件并取得对应 Blob。
3. 仅向 `qdm-metric-cli` 的两条固定路径注入 Blob：`analysis execute` 与 `auth describe`。
4. QDM 专用 Agent 只能启用 `qdm_query`、`qdm_scope_summary`、`get_current_time`；其他 Agent
   及其现有 Hook 不改变。
5. 通过 `data-harness-cli` 为每次请求注入 Wikis、指标口径、playbook 与模板选择状态，保持
   完整 Harness 语义体验，且该 CLI 永远不接触 Blob。
6. 在 Windows 上实现可重复安装、预检、升级、卸载和 doctor 诊断。

### 2.2 非目标

- 不管理渠道授权文件的生成、更新、轮换、同步或用户生命周期；
- 不支持飞书 `share_session_in_group`、话题消息或无法获得原始发送者的入站请求；
- 不开放 Shell、文件、网络、浏览器或通用 QDM CLI 工具；
- 不把 Blob、原始 user ID、授权原文或渠道密钥写入 Prompt、模型工具参数、聊天消息或日志；唯一例外是
  本文 4.7 定义的、默认关闭的本地调试短路回复，且该例外不适用于日志、错误、会话状态或记忆索引；
- 不使用 `data-harness-cli authz-hook`；它属于既有 Agent 的 `auth.blob` 鉴权链路；
- 不在 Windows 首期接入 ACP、Gateway、外部 Agent 委托或 Linux 容器运行。

### 2.3 Fail-closed 原则

以下任一情况都不得启动 QDM CLI：未知渠道、非 QDM Agent、身份缺失、身份格式无效、飞书群聊未
@机器人、飞书共享会话/话题、索引不存在、授权文件异常、Blob 无效、CLI 不可信或超时。企微群聊的
未 @机器人消息由 QwenPaw 渠道层在路由前丢弃。

## 3. 核心运行流程（ASCII）

```text
  企微 / 飞书单聊，或群聊 @机器人
                 |
                 v
  QwenPaw Channel Adapter（可信 channel_meta）
                 |
                 v
  [PRE_AGENT_BUILD] QdmRequesterIdentityHook
  - 企微: wecom_sender_id (userid)
  - 飞书: feishu_sender_id (open_id)
  - 标准化: channel, user_id, chat_id, chat_type
  - 拒绝: Feishu share-session / thread / 无真实发送者
                 |
                 v
  request.request_context["qdm_requester"]
  （仅请求内存；不进入 Prompt、日志、聊天记录）
                 |
                 v
  [仅 command 调试模式] QdmDebugIdentityHook
- 精确匹配规范化后的 /qdm-userid；企微群聊已由宿主路由门禁确认，飞书群聊须由宿主标记 @机器人
  - 本地 SHORT_CIRCUIT 回显 channel + 当前 user_id；不调用 LLM / Harness CLI / QDM CLI
  - off、身份不可用或不支持的飞书会话：短路且不回显
                 |
          （非调试命令）
                 v
  [PRE_AGENT_BUILD] QwenPawHarnessContextHook
  - data-harness-cli context --format agent-hook
  - session_key: qwenpaw:<HMAC-SHA256(session_hmac_secret, channel + original_session_id)>
  - stdin 仅含 session_key + 用户问题；原始 QwenPaw session ID 不离开宿主内存
  - 输出 additionalContext，经大小/JSON 校验后 ctx.inject_context()
  - 不传 Blob、user_id、渠道 metadata 或授权 argv
                 |
                 v
  [PRE_EXECUTE] QdmRequesterContextHook
  - 将已验证主体写入私有 ContextVar
  - POST_RESPONSE / ON_ERROR 清理
                 |
                 v
  LLM 只能调用 qdm_query / qdm_scope_summary
                 |
                 v
  QdmChannelAuthProvider
  - 读取 <runtime>\config\qwenpaw\channel-auth.json
  - channel + user_id -> credential_id -> ciphertext Blob
                 |
                 v
  QdmCliExecutor（argv 白名单、无 Shell、脱敏）
  - qdm-metric-cli analysis execute ... --data-auth --auth-blob <Blob>
  - qdm-metric-cli auth describe --auth-blob <Blob>
                 |
                 v
  返回受限查询结果 / 脱敏权限摘要
                 |
                 v
  [P2，须单独验证] QwenPaw 模板生命周期桥接
  - 仅传脱敏工具事件与 safe_command_args
  - 不传 Blob、user_id、完整授权 argv
```

## 4. 身份模型与渠道兼容性

### 4.1 统一请求主体

插件内部使用下列不可变数据结构；它只能存在于请求上下文和私有 ContextVar：

```json
{
  "schema_version": 1,
  "status": "resolved",
  "channel": "wecom | feishu",
  "user_id": "企微 userid 或飞书 open_id",
  "chat_id": "渠道会话标识",
  "chat_type": "single | group"
}
```

`user_id` 是实现字段，禁止把它放入系统提示、工具描述、输出、错误信息和普通日志；唯一输出例外为
4.7 中默认关闭的本地调试短路回复。
诊断日志只允许记录不可逆的短指纹和拒绝原因分类。

### 4.2 企微

- 单聊与群聊均取 `channel_meta.wecom_sender_id`；
- 群聊必须由 QwenPaw 渠道层确认已经满足 `@机器人` 的处理条件；插件不根据用户文本自行
  解析 @ 字符串；
- 授权查询固定为 `wecom + userid`；同一用户从不同企微机器人或不同 QwenPaw Agent 发起请求，
  必须命中同一授权索引；
- 插件不读取、保存或使用 Corp ID、机器人 ID 或 Agent ID；
- `chat_id` 用 `wecom_chatid`，但仅用于审计关联，不能代替用户 ID 授权。

### 4.3 飞书

- 单聊与普通群聊取 `channel_meta.feishu_sender_id`，其授权口径为 `open_id`；
- 授权查询固定为 `feishu + open_id`；
- 若 `feishu_sender_id` 为 `group`、`thread:*`、空值，或检测到共享会话/话题，标记为
  `unavailable` 并拒绝工具调用；
- 未来若支持该场景，必须先由 QwenPaw 宿主在覆写前保存
  `channel_meta.feishu_raw_sender_id`，再增加独立的版本化验收，不采用 monkey patch。

### 4.4 Agent 与机器人的授权边界

`agent_id`、QwenPaw workspace ID、企微机器人 ID、Corp ID 和飞书 App ID 均不参与 Blob 查找，
插件不读取、保存或记录它们。它们不能改变 `channel + user_id` 的授权结果。若未来需要限制某个
Agent 可访问的数据范围，应在 Blob 精确查找成功后的独立策略层实施，并有单独的策略版本、
默认拒绝和验收用例。

### 4.5 Hook 时序

当前参考身份插件只在 `PRE_AGENT_BUILD` 写入 `request_context`，而现有 PoC 的工具授权器只读
旧 ContextVar；两者未连通。并且 QwenPaw 的 `PRE_DISPATCH` 发生在 `PRE_AGENT_BUILD` 之前，
因此不能在 `PRE_DISPATCH` 传递本 Hook 刚解析出的身份。正式实现必须注册以下无状态 Hook：

1. `QdmRequesterIdentityHook`（`PRE_AGENT_BUILD`）：从渠道元数据重新计算并覆盖
   `qdm_requester`，任何调用方伪造的同名字段均无效；
2. `QwenPawHarnessContextHook`（同为 `PRE_AGENT_BUILD`，排在身份 Hook 之后）：用
   `session_hmac_secret` 计算
   `qwenpaw:<HMAC-SHA256(session_hmac_secret, channel + original_session_id)>`，并以该不可逆会话键和
   当前用户问题调用
   `data-harness-cli context --format agent-hook`；严格解析其 `additionalContext`，限长后使用
   QwenPaw 的 `ctx.inject_context()` 注入当前请求。该调用不传 user ID、Blob、渠道 metadata 或
   授权 argv；若失败、超时或输出无效，则短路请求并返回统一的业务上下文不可用错误，不允许
   降级为无 Harness 语义的取数；
3. `QdmRequesterContextHook`（`PRE_EXECUTE`）：仅将已验证的 `qdm_requester` 绑定到插件私有
   ContextVar；`PRE_EXECUTE` 位于 Agent 构建之后、模型执行之前，确保工具闭包可使用同一请求的
   主体；
4. `QdmRequesterContextCleanupHook`（`POST_RESPONSE` 与 `ON_ERROR`）：清理 ContextVar，确保
   并发或后续请求不会复用前一用户身份。

`qdm_query` 与 `qdm_scope_summary` 只能从该私有 ContextVar 读取主体，绝不接受模型参数、
会话 ID、显示名或通用 `get_current_user_id()` 作为授权主体。

### 4.6 Runtime Hook 注册、热安装与所有权

最低兼容版本为 QwenPaw `2.1.x`，且宿主必须提供公开 API
`PluginApi.register_runtime_hook_now()`；安装和启动均须显式探测该 API，缺失或版本不满足时明确失败，
不得降级为私有注册、monkey patch 或静态全局 Registry 写入。

插件只通过该公开 API 注册或替换 Runtime Hook，不访问 `HookRegistry` 的私有字段（包括排序缓存）。
Hook 的所有权以 `plugin_id + hook_name` 识别：每个 Workspace 必须获得独立、无状态的新 Hook 实例；
强制重装只替换本插件的旧实例，不得按名称泛化移除其他插件 Hook。注册、替换和卸载后的排序缓存失效
由 QwenPaw 宿主的公开注册/替换/卸载生命周期负责，插件不得直接清理私有缓存。

注册工具时使用普通 `async` closure 委托实例实现，不直接注册 Python bound method，以兼容 QwenPaw
对 callable 附加元数据的行为。卸载通过宿主的插件生命周期仅移除本插件拥有的 Hook、工具和回调；
如果宿主不能满足该所有权与缓存失效契约，Windows 首期不支持热安装或强制重装，应明确失败。

### 4.7 原始 user ID 受控调试回显

此能力仅用于渠道接入、身份解析和授权索引的调试核验，不参与 Blob 查找、权限决策或 QDM CLI 参数构造。
插件配置仅允许：

```yaml
user_id_display_mode: off # off | command
```

`off` 为安装默认值且是生产环境唯一允许值；`command` 只可由安装器或受控宿主配置启用，不能由模型、
用户自然语言、工具参数或渠道消息动态开启。不提供 `always` 模式。

在 `PRE_AGENT_BUILD` 中，`QdmDebugIdentityHook` 必须排在身份 Hook 之后、Harness 上下文 Hook 之前：
它只在 `command` 模式且渠道适配器提供的**规范化消息正文**精确等于 `/qdm-userid` 时，从已验证的
`qdm_requester` 读取 `channel + user_id`，并以 `HookAction.SHORT_CIRCUIT` 返回本地确定性回复。实现必须
使用 `Msg(..., content=[TextBlock(...)])`，不得经由 LLM、Prompt、工具、`data-harness-cli`、
`channel-auth.json`、`session_hmac_secret` 或 `qdm-metric-cli`。回显仅包含渠道名和当前请求者的原始
`user_id`；不得包含 Blob、credential ID、chat ID、会话 ID、Corp/App/bot/agent ID、授权状态或权限摘要。

群聊只在 QwenPaw 已确认 `@机器人` 的入站消息中处理；企微由渠道层路由门禁保证，飞书由可信
`bot_mentioned=true` 标记保证。使用者须发送 `@机器人 /qdm-userid`，但插件不得自行解析原始 `@`
文本。身份缺失、飞书共享会话/话题、`group`、`thread:*`、空 ID、飞书群聊未 @机器人或 `off` 模式下，
调试命令一律短路且不回显、不进入 QDM 取数链路。普通业务消息不得受该 Hook 影响。

该回复对群成员可见，且渠道本身可能保存在聊天记录中，因此只建议用于受控测试群。插件不主动写入
会话状态或记忆；但在允许启用 `command` 前，必须在真实企微和飞书环境证明 QwenPaw 宿主的入站、出站、
会话、记忆和异常日志均不会保存该原始值。无法证明或无法修复时，`command` 模式不得启用。

## 5. 授权文件契约

### 5.1 路径与隔离

Windows 首期唯一允许的渠道授权文件是：

```text
<runtime>\config\qwenpaw\channel-auth.json
```

`<runtime>` 来自 `C:\ProgramData\QDM\qwenpaw\plugin-config.json` 中的绝对 `runtime_dir`，插件只能按
固定相对路径推导授权文件与 Secret；不接受环境变量、模型参数、Agent ID 或备用路径覆盖。安装器不创建
真实授权文件，只验证其存在性、格式、常规文件属性与 ACL。文件提供方负责写入。
不得使用 `<runtime>\config\auth.blob`、安装器生成的 `auth.blob`、环境变量 Blob 或用户目录
下的同名文件作为后备来源。

建议 ACL：当前运行账号、`Administrators`、`SYSTEM` 可读；其他用户无读取权限。预检应明确
报告 ACL 过宽，但不得显示文件内容或 Blob。

### 5.2 会话 HMAC Secret

`session_hmac_secret` 是与授权文件独立的受控随机 Secret，用于将 QwenPaw 原始会话 ID 映射为
Harness 会话键，计算口径固定为：

```text
qwenpaw:<HMAC-SHA256(session_hmac_secret, channel + original_session_id)>
```

Secret 固定路径为 `<runtime>\config\qwenpaw\session-hmac.secret`。插件只在受控内存中读取原始会话 ID 与 Secret；传给 `data-harness-cli context` 的 `session_id` 只能是
该 HMAC 会话键。Secret 文件必须是绝对路径、普通文件、非空且权限不宽于本节 ACL；不得写入
`channel-auth.json`、YAML 示例、环境变量、Prompt、日志、工具参数或任何子进程 argv。Secret 缺失、
无效、不可读或 ACL 过宽时 fail-closed，不启动 QDM CLI。

### 5.3 授权文件格式

授权文件严格保持文件提供方给出的原始两层索引：

```json
{
  "credentials": {
    "cred_001": { "ciphertext": "qdm1enc.…" }
  },
  "channelUserIndex": {
    "wecom": {
      "zhangsan": "cred_001"
    },
    "feishu": {
      "ou_xxx": "cred_002"
    }
  }
}
```

读取规则必须严格执行：

1. 精确匹配 `channel`、`user_id`：
   `channelUserIndex[channel][user_id] -> credential_id -> credentials[credential_id].ciphertext`；
   不做大小写转换、前后缀匹配或默认用户；
2. credential ID 必须存在，且 `ciphertext` 为非空 `qdm1enc.` Blob；
3. 文件必须是绝对路径上的普通文件，拒绝符号链接、目录、超出大小上限或无效 JSON；
4. 每次工具调用重新读取和解析文件，不跨请求缓存 Blob；
5. 任意错误只返回统一的“QDM 渠道授权不可用或被拒绝”，日志也不得出现 Blob 或 user ID。

这是内部单租户格式；若将来一个授权文件需要服务多个企微 Corp 或飞书 App，必须重新引入
明确的租户隔离键和独立迁移方案，不能在此格式上做隐式兼容。

## 6. 插件与仓库结构

建议新增如下可维护源码，而不提交 `~/.qwenpaw` 内的安装副本：

```text
.agents/qwenpaw/
  plugin.json
  plugin.py
  qdm_identity.py              # 纯身份标准化与安全校验
  qdm_debug_identity.py        # 默认关闭的 /qdm-userid 本地短路调试回复
  qdm_runtime_hooks.py         # 身份、Harness 上下文、PRE_EXECUTE 绑定与清理
  qdm_harness_context.py        # data-harness-cli 受控调用与 Hook 协议解析
  qdm_report_lifecycle.py       # qdm_query 完成后的 qwenpaw-hook 窄协议桥接
  qdm_channel_auth.py          # 授权文件读取与精确查询
  qdm_cli.py                   # argv 白名单、子进程执行、结果脱敏
  install-qwenpaw-plugin.py    # 安装、预检、工具隔离、卸载辅助
  config/
    qwenpaw-qdm.windows.json.example # user_id_display_mode: off
    qwenpaw-qdm.linux.json.example
  skills/qdm-harness/SKILL.md
  tests/
    test_identity.py
    test_channel_auth.py
    test_runtime_hooks.py
    test_cli.py
    test_install.py
```

插件 ID 使用正式名称 `qdm-harness-qwenpaw`，不复用 PoC 的
`qdm-harness-qwenpaw-poc`。`plugin.json` 将 QwenPaw 版本约束固定在经验证的 2.1.x 范围；
不满足最低版本或缺少 `register_runtime_hook_now()` 时安装和运行均明确失败。

## 7. Harness 上下文与工具/CLI 安全契约

### 7.1 两条分离链路

QwenPaw 的完整 Harness 体验由两条彼此隔离的链路组成：

| 组件 | 职责 | 是否可接触 Blob |
| --- | --- | --- |
| `data-harness-cli.exe` | Wikis 召回、指标口径、playbook、模板选择与会话状态 | 否 |
| QwenPaw 插件 | 可信身份提取、上下文桥接、工具白名单与 Blob 读取协调 | 仅在受控内存中短暂持有 |
| `channel-auth.json` | `channel + user_id -> credential_id -> Blob` | 是，受 ACL 保护 |
| `qdm-metric-cli.exe` | `analysis execute` 与 `auth describe`，执行最终数据权限过滤 | 是，仅通过受控 argv |

查询前必须调用现有 CLI 协议：

```text
<runtime>\bin\data-harness-cli.exe context --format agent-hook
```

标准输入仅允许：

```json
{
  "session_id": "qwenpaw:<HMAC-SHA256(session_hmac_secret, channel + original_session_id)>",
  "prompt": "用户原始业务问题"
}
```

插件只读取成功 JSON 中的 `hookSpecificOutput.additionalContext`，限制其 UTF-8 字节数，并以
`ctx.inject_context()` 注入当前请求。模型不拥有 `data-harness-cli` 工具，也不能读取 Wikis
文件或构造该 CLI 命令。此调用不得传递 Blob、user ID、渠道原始 metadata、机器人 ID、Agent ID
或完整授权 argv；也不得传递原始 QwenPaw session ID 或 `session_hmac_secret`。子进程工作目录固定为
`<runtime>`，且 CLI 路径必须是安装预检通过的绝对常规文件。

`data-harness-cli authz-hook` 不得用于本插件；它对应安装器的 `auth.blob` 模式，与渠道用户
授权文件没有关系。

### 7.2 报告与模板生命周期（P2 门槛）

当前 QwenPaw 2.1.x 没有插件可用的公开 after-tool/context 注入 API；内部
`ToolHookRegistry` 不属于兼容契约，插件不得访问。因此采用窄接口方案：`data-harness-cli posttool
--format qwenpaw-hook` 接收插件在 `qdm_query` 完成后提交的 HMAC 派生 `session_id`、固定
`tool_name=qdm_query`、`status` 和仅含白名单报告字段的 `safe_command_args`，输出受限的
`additional_context`、`mode`、`selected_template` 与脱敏 `diagnostic_code`。

QwenPaw 插件通过 `qdm_report_lifecycle.py` 调用该接口，并把成功注入的模板上下文作为受控工具结果
附加内容交还模型；不把 Blob、user ID、授权文件、完整执行 argv 或通用 Shell 带入协议。CLI 接口和
插件单元测试已实现，但 P2 仍未完成：必须增加 Windows 真实 QwenPaw 报告会话回归，验证模板只在
选定状态下注入、生命周期失败时不猜模板，以及日志/持久化不含敏感数据。回归通过前，产品不得宣布
“完整 Harness 报告/模板兼容”。

### 7.3 允许能力

- `qdm_query(command_args)` 固定执行
  `qdm-metric-cli analysis execute <args> --data-auth --auth-blob <trusted-blob>`；
- `qdm_scope_summary()` 固定执行
  `qdm-metric-cli auth describe --auth-blob <trusted-blob>`，只返回
  `enabled`、`capabilities`、`dataScope`、`labelsResolved`；
- `get_current_time` 仅用于相对日期。

三项工具均由插件注册阶段创建的普通 `async` closure 对外暴露，closure 只委托受控实现；不直接把
实例 bound method 注册给 QwenPaw，也不允许工具声明或模型参数传入身份、Blob、授权文件或 CLI 路径。

### 7.4 强制限制

- 拒绝模型传入 `--data-auth`、`--auth-blob`、`--auth-json`，及 `help`、`version`、`health`、
  `auth` 等命令探测 token；
- 使用 `subprocess.run([...])`，禁止 `shell=True` 和字符串命令；
- 固定 UTF-8：`text=True, encoding="utf-8", errors="replace"`；
- 继承宿主环境以保留 Windows 的网络、证书和代理配置，但清除所有 Blob 来源环境变量；
- 成功输出默认不截断，先完成 Blob 脱敏；运维可在 `query_limits.success_bytes` 配置正整数上限，超限时返回稳定的 `QDM_RESULT_TOO_LARGE`，不得生成半截 JSON；CLI 超时由 `query_limits.timeout_seconds` 配置，默认 120 秒并始终保持正值。报告附加上下文默认不限制，可通过 `report_limits.additional_context_bytes` 配置，超限返回 `QDM_REPORT_CONTEXT_TOO_LARGE`；错误输出先脱敏再按 1000 字符上限返回；
- 安装器为 QDM 专用 Agent 写入 `light_context_config.tool_result_pruning_config.enabled=false`，避免 QwenPaw 宿主再次裁剪完整查询结果；`page_size` 仍严格限制为 1–500，运行时 CLI 仍使用绝对路径。
- QwenPaw 专用 Harness 上下文在通用手册之后追加权威工具策略：权限/范围问题只能调用 `qdm_scope_summary`，不得要求用户执行 `qdm-metric-cli auth describe` 或任何 Shell/CLI，也不得请求 Blob、Secret、授权文件或认证参数。
- 普通 `qdm_query` 与报告生命周期严格分离：公开查询工具不暴露 `report_name`/`report_module`，也不调用 `posttool --format qwenpaw-hook`；报告能力如需恢复，必须由可信 Harness 上下文显式进入独立报告入口，不能由模型参数触发。
- QDM 专用 Agent 的安装器每次都覆盖工具配置并禁用其余工具。禁止通过配置漂移重新开启
  Shell、文件、浏览器、HTTP、数据库、子代理或外部委托。

### 7.5 日志与运行时诊断

插件使用宿主稳定命名空间 `logging.getLogger("qwenpaw.plugins.qdm_harness")`，复用宿主 handler，
不自行创建文件 handler。日志、错误、诊断输出和审计关联中禁止包含 Blob、原始 user ID、chat ID、
完整原始或 HMAC 会话 ID、原始渠道 payload、完整授权 argv、授权文件内容及
`session_hmac_secret`。诊断只可记录不可逆短指纹、错误分类和非敏感关联码。

排障和回归不能只根据 Hook 名称判断：必须记录/断言实际运行 Hook 的实例 ID、类、模块和源码路径，
并确认它属于当前安装副本。若宿主日志本身会记录渠道 payload、会话 ID 或路径而泄露上述信息，
须在 Windows 上线前由宿主侧完成脱敏修复和真实渠道验证。

## 8. 安装、发布与诊断设计

### 8.1 独立 QwenPaw 安装入口

不修改其他 Agent 的安装链路。npm CLI 新增独立的 QwenPaw 子命令/入口，例如：

```text
harness-data qwenpaw install --runtime <runtime> --qwenpaw-python <python>
harness-data qwenpaw doctor  --runtime <runtime> --qwenpaw-python <python>
harness-data qwenpaw uninstall --qwenpaw-python <python>
```

`install` 的顺序为：定位 QwenPaw 2.1.x 并探测公开
`PluginApi.register_runtime_hook_now()` → 校验 `data-harness-cli.exe` 和
`qdm-metric-cli.exe` 为可信常规文件 → 以隔离诊断会话校验
`data-harness-cli context --format agent-hook` 可读取 runtime Wikis 索引 → 校验渠道授权文件与
`session_hmac_secret` 的 ACL/格式 → 校验飞书不使用不支持模式 → 安装/强制更新插件 → 写入 QDM Agent
的工具 allowlist（每次覆盖 QDM 工具的 `description`、`config`、`enabled`，并禁用全部非白名单工具）
→ 执行 doctor。任一步失败时恢复 Agent 的原工具配置；不写入或清理渠道授权文件或 Secret。

Windows 首期安装器只修改已存在的 QDM 专用 Agent 的 `agent.json`；若目标 Agent 不存在或配置不是常规文件，
安装明确失败，不自动创建一个缺少模型、渠道或工作区配置的 Agent。

安装器必须校验 `user_id_display_mode` 仅可为 `off` 或 `command`，默认显式写入 `off`。它只原子写入
ProgramData 下的非敏感 `plugin-config.json`，其中严格只允许 `schema_version`、`runtime_dir`、`qdm_agent_id`
和 `user_id_display_mode` 四个字段；渠道授权文件和 Secret 必须从 runtime 固定相对路径推导。若配置为
`command`，安装和 doctor 只报告其已启用及“仅限调试、群聊可见”的非敏感告警；不得输出任何用户 ID，
并且只有完成 4.7 要求的宿主持久化/日志真实回归后才允许将该配置用于实际渠道。

`doctor` 必须分别报告 Harness 语义 CLI、QDM 取数 CLI、QwenPaw Hook API、Hook 所有权/实例、Wikis
索引、授权文件与 `session_hmac_secret` 的 ACL/格式、QDM Agent 工具白名单和飞书不支持模式；所有诊断
均不得输出 Blob、Secret、原始 user ID 或会话 ID。

### 8.2 Release runtime bundle

发布工作流需要把 `.agents/qwenpaw` 显式复制到 runtime bundle 的 `agents/qwenpaw`，并将
`config/qwenpaw/README.md` 复制到 runtime；真实 `channel-auth.json` 和 `session-hmac.secret` 永不进入 Git 或正式发布包，并增加：

- `plugin.json`、安装脚本、Windows 配置模板和测试资产完整性检查；
- bundle 内 QwenPaw 文件存在性与版本一致性检查；
- Windows 安装/doctor 测试；
- Linux 只验证模板与静态安全约束，暂不发布为生产可用声明。

现有 `agentChoices` 与 Codex/WorkBuddy 等 Agent 链接逻辑不纳入 QwenPaw，避免改动其他 Agent
行为；QwenPaw 是其自身插件安装流程，不是工作区软链接 Agent。

## 9. 分阶段实施清单

### P0：Harness 上下文协议与脚手架

1. 验证 `data-harness-cli context --format agent-hook` 的 stdin/stdout 契约，落实不可逆的
   `qwenpaw:<HMAC-SHA256(...)>` 会话键、Secret 读取/ACL 和上下文字节上限；
2. 创建 `.agents/qwenpaw` 目录与正式 manifest；
3. 实现 `QwenPawHarnessContextHook`，通过 `ctx.inject_context()` 注入受控 Harness 上下文；
4. 迁移 PoC 的受限 CLI 执行逻辑，删除 `local_blob` 生产路径；
5. 落地两层授权文件读取器、`session_hmac_secret` 读取器和 Windows ACL 预检；
6. 完成身份、`PRE_EXECUTE` 绑定和响应/错误清理 Hook，并添加身份不能进入日志/Prompt 的测试。
7. 通过 `register_runtime_hook_now()` 实现每 Workspace 独立无状态 Hook 的注册、替换和卸载，并补充
   宿主公开生命周期/API 不满足时的明确失败测试；
8. 实现默认关闭的 `QdmDebugIdentityHook`、配置值校验及 `SHORT_CIRCUIT + Msg + TextBlock` 单元测试；

### P1：Windows 查询链路与安装器

1. 实现企微、飞书单聊/普通群聊身份解析；
2. 实现独立 `harness-data qwenpaw install/doctor/uninstall`；
3. 以 QDM 专用 Agent 完成工具 allowlist 和配置备份/恢复；
4. 修改 runtime bundle 打包与 npm 测试；验证 `command` 模式仅能通过受控配置启用。

### P2：模板生命周期桥接与 Windows 发布门禁

1. 验证 QwenPaw 的公开工具完成后注入 API；若不存在，定义并实现
   `data-harness-cli posttool --format qwenpaw-hook` 窄协议；
2. 对报告模式完成模板/生命周期真实回归，确认该协议绝不携带 Blob、user ID 或完整授权 argv；
3. 运行 Python 单元测试、npm 单元测试、QwenPaw 插件 validate/install/doctor；
4. 企微、飞书分别使用两个测试用户进行单聊和 `@机器人` 群聊真实回归；
5. 验证不同用户命中不同 Blob，所有拒绝路径均不启动 CLI；
6. 验证同一 `userid` 从不同企微机器人/不同 QwenPaw Agent 发起请求时命中同一 credential；
7. 回归热安装即时生效、Agent reload 后仅一个新 Hook 实例、强制重装无旧实例残留、卸载仅移除本
   插件 Hook；逐 phase 断言 `hooks_for(phase)` 的顺序、实例 ID、模块和源码路径正确；
8. 审核日志、错误、模型上下文和权限摘要不含 Blob、Secret、原始身份或会话 ID；
9. 在真实企微、飞书单聊和群聊验证调试回显不会被 QwenPaw 宿主日志、会话持久化或记忆索引记录；
   不能通过则保持 `user_id_display_mode: off`；
10. Windows 门禁全部通过后再发布 runtime bundle。

### P3：Linux/Docker 生产适配（后续）

1. 将授权文件以 Docker Secret 或只读受控挂载提供给 QwenPaw 运行账号；
2. 将 `session_hmac_secret` 以独立 Docker Secret/只读受控挂载提供；将 Windows ACL 检查替换为容器内
   UID/GID、挂载只读和 `0600` 权限检查；
3. 复用两层授权文件、身份 Hook、工具 allowlist、CLI argv 限制和失败闭合语义；
4. 评估多副本部署后的文件同步与密钥管理。若需要远端 Resolver，必须保持同一请求主体和
   响应绑定契约，不能让模型选择 Resolver 地址或命令。

## 10. 验收矩阵

| 场景 | 预期 |
| --- | --- |
| 企微单聊，已索引用户 | 精确命中该用户 Blob，受控 CLI 成功执行 |
| 企微群聊 @机器人，已索引用户 | 精确命中发言用户 Blob，不使用群 ID 或会话 ID |
| 企微群聊未 @机器人 | QwenPaw 渠道层不路由至 Agent；该宿主契约必须完成真实回归 |
| 不同企微机器人/Agent，同一 userid | 命中同一 `wecom + userid` credential |
| 飞书单聊，已索引 `open_id` | 精确命中该用户 Blob |
| 飞书普通群聊 @机器人，已索引 `open_id` | 精确命中发言用户 Blob |
| `user_id_display_mode: off`，发送 `/qdm-userid` | 本地短路、不回显原始 user ID，且不调用 LLM、Harness CLI 或 QDM CLI |
| `command`，企微/飞书单聊 `/qdm-userid` | 本地短路，仅回显当前可信 `wecom_sender_id` / `feishu_sender_id` 与渠道名 |
| `command`，企微/飞书群聊 `@机器人 /qdm-userid` | 本地短路，仅回显当前发言用户 ID；真实回归明确验证群内可见性 |
| 调试命令的共享会话、话题、`group`、空 ID 或未 @机器人群消息 | 不回显、不调用 LLM、Harness CLI 或 QDM CLI |
| 普通业务消息 | 不回显 user ID，保持既有 Harness 上下文与 QDM 查询流程 |
| 调试回显可信性 | 模型参数或伪造 `user_id` 不影响结果；只使用 `channel_meta` 解析出的身份 |
| 启用 `command` 的宿主泄露回归 | QwenPaw 入站/出站/会话/记忆/异常日志不含原始 user ID；不满足则禁止启用 |
| 用户发起指标问题 | `data-harness-cli context --format agent-hook` 在 `qdm-metric-cli` 前执行 |
| Harness context 指定指标口径 | QwenPaw 在当前请求收到受控上下文，并按该口径构造 `qdm_query` |
| Harness context 输入/输出 | 不含 Blob、user ID、渠道 metadata 或完整授权 argv |
| Harness context 会话键 | 仅收到 HMAC 派生键；原始 QwenPaw session ID 与 `session_hmac_secret` 不进入 CLI、Prompt、日志或工具参数 |
| `data-harness-cli` 不可用、超时或返回无效 JSON | 短路请求；不启动 QDM CLI，不开放 Shell 或直接读取 Wikis |
| 报告型问题（P2 完成后） | playbook/模板通过公开 API 或 `qwenpaw-hook` 协议正确注入 |
| P2 生命周期协议 | 不含 Blob、user ID、授权文件或完整执行 argv |
| 飞书共享会话/话题 | 拒绝，且不启动 CLI |
| 未 @机器人群消息 | 不进入 QDM 处理链路 |
| 未知用户、授权文件/Secret 损坏、ACL 过宽 | 拒绝，且不启动 CLI |
| 不同 agent_id 或机器人 ID，同一用户 | 不影响默认 Blob 查找结果 |
| 模型伪造 user_id，或传入 Blob/Auth/Help/任意子命令 | 工具本地拒绝 |
| QwenPaw 版本/API 不满足 | 安装或启动明确失败；不降级使用私有 Registry 或 monkey patch |
| 热安装 | 已存在 Workspace 立即生效；按 `plugin_id + hook_name` 只有当前插件的新 Hook 实例 |
| Agent reload | 替换后的 Workspace 只附着一个新 Hook 实例，且不复用旧 Workspace 实例 |
| 强制重装 | 旧实例无残留；不移除其他插件 Hook；`hooks_for(phase)` 的顺序与实例正确 |
| 卸载 | 仅移除本插件 Hook、工具和回调；宿主完成排序缓存失效，其他插件 Hook 不受影响 |
| 两个并发用户请求 | ContextVar 不串用户，分别读取各自 Blob |
| `qdm_scope_summary` | 仅返回脱敏范围，不返回 user ID、displayName、Blob |

## 本轮调整实施记录

- `qdm_query` 在 `analysis execute` 前强制执行 `auth describe`，校验账号启用状态、`qdm.metric.query` 能力、`labelsResolved` 与非空 `dataScope`；失败时 fail-closed，不启动分析 CLI。
- `manageAreaId`/`categoryLevel1Id` 及复数过滤器支持在授权范围内按唯一显示名称解析为 ID；未知、重复或越权值拒绝，不猜测 ID。
- 安装器增加 `tool_policy`：默认 `preserve` 保留既有非 QDM 工具及字段，`strict` 显式收紧为 QDM 三工具；旧配置缺失该字段按 `preserve` 兼容。
- 普通 QwenPaw 查询与报告生命周期保持隔离，README 与 Skill 已同步。
- 本轮离线包使用新的 r14 staging 目录构建，复用 r12 模拟授权材料并收紧 Windows ACL。

## 11. 开发完成定义

仅当 P0-P1 的代码、自动化测试、真实双用户渠道回归、Windows 安装/升级/卸载/doctor 和安全
审查全部通过后，才可宣布 Windows QwenPaw 的“Wikis/口径/playbook 上下文 + 受限查询”兼容
完成。只有在 P2 的模板生命周期桥接和真实回归也通过后，才可宣布“完整 Harness 体验”兼容。
Linux/Docker 在 P3 完成独立部署及回归前，始终标记为“设计兼容，未生产验证”。
