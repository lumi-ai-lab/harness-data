# QwenPaw 定时任务 QDM 请求身份插件侧修复方案

> 状态：已确认并实施（2026-09-07）。
>
> 适用范围：`feat/qwenpaw-runtime-mcp` 的 QwenPaw QDM 插件。
> 不修改 QwenPaw 宿主、qdm-auth-center、runtime MCP 协议、SQLite 或 Blob 格式。

## 1. 问题概述

企微会话 `6fafa35b-dd62-48ef-8607-dd587afe3034` 中，用户创建“查询昨天蔬菜类总销售额”的 QwenPaw 定时任务后，定时执行返回：

```text
本会话不具备您的 QDM 授权身份，无法取数。
请在企业微信或飞书里向已配置的 QDM 机器人提问。
```

同一用户通过企业微信直接发送“昨天蔬菜类的总销售额是多少”时，可以正常返回数据。

本问题不是用户没有权限，也不是 runtime MCP、授权 Blob、SQLite、qdm-metric-cli 或 Harness Context 不可用；根因是定时任务执行时缺少插件当前要求的可信渠道身份元数据。

## 2. 已确认事实与证据

### 2.1 任务本身已保存渠道和用户编号

QwenPaw 定时任务界面及对应任务文件均保存以下调度信息：

```text
DispatchChannel        = wecom
DispatchTargetUserID   = 13719423749
DispatchTargetSessionID = wecom:13719423749
```

实际任务 `db65dc57-8bd0-4057-8991-48e5b368f651` 的持久化内容为：

```json
{
  "dispatch": {
    "channel": "wecom",
    "target": {
      "user_id": "13719423749",
      "session_id": "wecom:13719423749"
    },
    "meta": {}
  }
}
```

### 2.2 CronExecutor 会恢复 channel 和 user_id，但不恢复 channel_meta

2026-09-07 11:27:31 的运行日志显示：

```text
cron execute: job_id=db65dc57-8bd0-4057-8991-48e5b368f651
channel=wecom task_type=agent
target_user_id=13719423749 target_session_id=wecom:13719423749
```

QwenPaw `CronExecutor` 在执行 agent 任务时会将 `channel`、`user_id`、`session_id` 写回请求，并写入：

```text
request_context.source = "cron"
request_context.cron_job_id = <job id>
```

但不会写入渠道适配器在原始企微消息中提供的：

```text
channel_meta.wecom_sender_id
```

### 2.3 当前插件故意只信任 channel_meta

QDM 插件的 `resolve_requester()` 目前按以下规则解析企微身份：

```text
channel == wecom
  -> channel_meta.wecom_sender_id
```

普通请求的 `request.user_id` 不被当作 QDM 授权身份。这是现有 fail-closed 设计，避免任意内部请求通过构造 `user_id` 冒充渠道用户。

定时任务没有 `channel_meta.wecom_sender_id`，因此身份被解析为：

```text
status = unavailable
reason = missing_or_non_person_sender
```

随后插件注入未授权约束，Agent 不调用 `qdm_query`、`qdm_scope_summary` 或 `qdm_auth_lookup_blob`，而是返回无授权提示。

### 2.4 与 runtime MCP 分支的关系

该问题不是 runtime MCP 分支引入的：

- `origin/master` 已包含同样的 `qdm_identity.py`、`qdm_runtime_hooks.py` 及 `channel_meta` 解析规则；
- runtime MCP 提交只新增 Blob Provider、MCP 客户端及配置选择，不改 CronExecutor 或请求身份解析；
- 在 legacy `channel-auth.json` 模式下，定时任务也会在进入 `ChannelAuthProvider` 前被拦截，表现为同类无身份提示。

runtime MCP 分支只是使问题在当前权限验证链路中暴露。

## 3. 调整目标

在不修改 QwenPaw 源码的前提下，使已由 QwenPaw 定时任务调度并带有有效 `channel + target_user_id` 的企微任务，能够以创建任务时指定的个人身份查询 QDM 数据。

同时保持以下安全与兼容边界：

- 企业微信、飞书正常消息继续只信任渠道提供的 `channel_meta`；
- 非 Cron 请求不得因为存在 `request.user_id` 而获得 QDM 身份；
- `target_user_id=group`、空值、`thread:*`、`unknown_*` 等非个人标识继续拒绝；
- 不隐式回退到 `channel-auth.json`；
- 不改变 runtime MCP 的 `channel + user_id -> Blob` 协议。

## 4. 推荐方案：仅调整 QDM 插件

### 4.1 新增受限的 Cron 身份回退

在插件中集中实现请求身份解析方法，例如：

```python
resolve_requester_for_request(request)
```

解析顺序：

```text
1. 优先使用现有 resolve_requester(channel, channel_meta)
   |
   +-- 身份已解析成功
   |     -> 直接返回
   |
   +-- 身份不可用
         |
         +-- request_context.source == "cron"
         +-- request_context.cron_job_id 为非空合法任务 ID
         +-- request.channel == "wecom"
         +-- request.user_id 为有效个人 ID
               -> 构造 Cron 专用的 resolved Requester
         |
         +-- 其他情况
               -> 保持原有 unavailable 结果
```

Cron 专用 Requester 使用：

```text
channel   = request.channel
user_id   = request.user_id
chat_type = 根据 session_id 仅作展示性推断；无法确认时使用 single
```

其中 QDM 授权查询只依赖 `channel + user_id`，不依赖 `chat_type`。

### 4.2 必须同时覆盖两个 Hook 阶段

以下两个位置必须使用同一个新解析方法，避免 PRE_AGENT_BUILD 与 PRE_EXECUTE 得到不同身份：

```text
QdmRequesterIdentityHook  (PRE_AGENT_BUILD)
QdmRequesterContextHook   (PRE_EXECUTE)
```

否则可能出现上下文注入通过、实际调用 `qdm_query` 时仍因未绑定身份而失败的情况。

### 4.3 插件侧任务记录校验

为降低将普通内部请求伪装成 Cron 请求的风险，建议插件在 Cron 回退前读取当前 Agent 的 `jobs.json`，并验证：

```text
cron_job_id 对应任务存在
任务 task_type == agent
任务 enabled 不是 false
任务 dispatch.channel == request.channel
任务 dispatch.target.user_id == request.user_id
```

任一条件不满足时，保持 fail-closed，不构造 QDM 身份。

此校验只读取 QwenPaw 已管理的任务文件，不修改任务内容，也不读取或记录 Blob、Token。

### 4.4 第一阶段只启用 WeCom Cron

本次实际问题和已验证的定时任务均为 WeCom。建议第一阶段仅允许：

```text
source=cron + channel=wecom + 有效个人 target_user_id
```

Feishu 的群提及、线程和共享会话约束不同，应在取得真实 Cron 请求元数据并增加专门测试后单独放开，不应因为复用此分支而绕过既有 Feishu 限制。

## 5. 群会话处理规则

定时任务列表中可能出现：

| DispatchChannel | DispatchTargetUserID | DispatchTargetSessionID | 处理 |
| --- | --- | --- | --- |
| `wecom` | 个人 ID | `wecom:<个人/群会话>` | 允许，以目标个人身份查询 |
| `wecom` | `group` | `wecom:group:<群 ID>` | 拒绝，群标识不能作为用户授权身份 |
| 非 WeCom | 任意 | 任意 | 第一阶段拒绝 |

即使任务投递到群会话，只要 `DispatchTargetUserID` 是已确认的个人 ID，QDM 授权仍以该个人为准；不能使用群 ID 获取或共享授权 Blob。

## 6. 不采用的方案

### 6.1 无条件信任 request.user_id

不采用：

```text
channel=wecom 且 request.user_id 非空
  -> 直接认为已授权
```

原因：普通 API、控制台或其他内部路径也可能传入 `user_id`，会破坏正常消息仍依赖 `channel_meta` 的边界。

### 6.2 修改 qdm-auth-center 或 runtime MCP

不采用。当前故障发生在插件身份解析阶段，未调用 MCP。修改服务端、SQLite、Blob 或 Token 无法解决问题。

### 6.3 立即修改 QwenPaw CronExecutor

不作为本次首选。宿主侧持久化并恢复可信身份快照是更强的长期方案，但当前任务已经保存了满足 QDM 查询所需的渠道和目标用户字段，插件可在限定 Cron 条件下完成兼容，无需阻塞发布。

## 7. 测试与验收

### 7.1 单元测试

至少覆盖：

1. WeCom 正常消息含 `wecom_sender_id`：保持现有解析和查询行为；
2. WeCom Cron + 有效任务记录 + 个人 `target_user_id`：解析为 resolved；
3. WeCom Cron + `target_user_id=group`：解析为 unavailable；
4. WeCom Cron + 任务不存在：解析为 unavailable；
5. WeCom Cron + 任务 channel 或 target user 不一致：解析为 unavailable；
6. 普通请求伪造 `source=cron` / `cron_job_id`：因未匹配任务记录而拒绝；
7. Feishu Cron：第一阶段保持 unavailable；
8. PRE_AGENT_BUILD 和 PRE_EXECUTE 对同一 Cron 请求解析出相同 Requester。

### 7.2 实机验收

1. 在企微个人会话创建“查询昨天蔬菜类总销售额”的定时任务；
2. 到期或点击“立即执行”；
3. 确认 QwenPaw 日志出现 Cron 执行及 QDM 查询，而非未授权约束；
4. 确认 runtime MCP 查询使用 `channel=wecom` 和目标用户 ID，日志只保留用户 ID 哈希；
5. 确认最终返回实际查询结果；
6. 验证直接企微提问仍正常；
7. 对 `target_user_id=group` 的任务执行，确认仍拒绝且不调用 MCP。

## 8. 回滚

本次为插件内身份解析分支调整。若实机验证不符合预期，回滚该插件提交并重新安装上一版插件即可。

回滚不影响：

- qdm-auth-center 进程、端口和 SQLite 数据；
- runtime MCP Token 与授权 Blob；
- QwenPaw 已保存的定时任务、会话和渠道配置；
- 企业微信直接消息的现有身份解析。

## 9. 建议提交说明

```text
fix(qwenpaw): 支持 WeCom 定时任务继承 QDM 请求身份
```

提交正文应说明：

```text
- 仅对可信 Cron 请求按已保存的 channel + target_user_id 回退解析 WeCom 身份
- 校验 cron_job_id 与 jobs.json 中的调度渠道、目标用户一致
- 保持普通消息和非 Cron 请求必须使用渠道 channel_meta
- 拒绝 group 等非个人调度目标，并补充 Cron 身份回归测试
```

## 10. 实施记录与边界

本方案已按推荐的插件侧实现落地：

- 新增统一的请求身份解析入口，优先保留原有 `channel_meta` 解析；
- 仅在 WeCom Cron 请求缺少渠道元数据时，读取当前 Hook workspace 的 `jobs.json`；
- 要求 `source=cron`、UUID 格式的 `cron_job_id`、启用的 `task_type=agent` 任务、调度渠道和目标用户均与任务记录精确一致；
- `QdmRequesterIdentityHook` 与 `QdmRequesterContextHook` 共用该入口，保证上下文注入和工具调用绑定同一身份；
- 拒绝 Feishu Cron、`group`/空值/线程类用户标识、缺失或不匹配的任务记录。

该校验将普通请求限制为必须匹配当前 workspace 中真实存在的任务记录，但不能替代宿主为
Cron 来源提供的不可伪造签名或受保护上下文。本次按内部受控部署前提实施；若未来开放不受信任
的内部 API 调用，应优先由 QwenPaw CronExecutor 写入并签名可信身份快照，再取消插件侧回退。
