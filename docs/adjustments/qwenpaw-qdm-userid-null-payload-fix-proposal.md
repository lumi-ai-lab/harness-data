# QwenPaw `/qdm-userid` 空 payload 异常修复方案

> 状态：已确认并实施（2026-09-04）。

## 1. 问题概述

会话 `2c78763e-b3f8-4434-8c27-46436ea42162` 中，企微用户发送：

```text
@data测试 /qdm-userid
```

QwenPaw 返回运行错误：

```text
AttributeError: 'NoneType' object has no attribute 'get_text_content'
```

错误发生在 QwenPaw Runtime 的 slash-command 短路消息封装阶段。
本提案仅处理该异常，不改变正常数据查询、权限注入或 runtime MCP 流程。

## 2. 已确认的事实

### 2.1 企微消息被正常规范化

企微适配器会对“@机器人后紧跟 slash command”的群消息去除 mention 前缀：

```text
@data测试 /qdm-userid  ->  /qdm-userid
```

临时错误 dump `C:\Users\QDM\AppData\Local\Temp\qwenpaw_query_error_5nlfcng2.json`
中的 `request.input[0].content[0].text` 已记录为 `/qdm-userid`。这属于既有的群消息命令识别行为，不是本次故障。

### 2.2 请求身份解析成功

同一 dump 中的 `request_context.qdm_requester.status` 为 `resolved`，渠道为 `wecom`，说明身份 Hook 已运行；故障不是身份解析、权限查找或 Blob 获取失败。

### 2.3 生产配置关闭了调试命令显示

当前配置 `C:\ProgramData\QDM\qwenpaw\plugin-config.json` 为：

```json
"user_id_display_mode": "off"
```

### 2.4 触发异常的代码路径

插件的调试命令处理逻辑在检测到精确命令 `/qdm-userid` 后，若显示模式不是 `command`，返回只有 action、没有 payload 的结果：

```python
HookResult(action=HookAction.SHORT_CIRCUIT)
```

位置：

- [qdm_debug_identity.py](D:/Repos/harness-data-qwenpaw-runtime-mcp/.agents/qwenpaw/qdm_debug_identity.py:33-37)

Runtime 对短路结果无条件执行：

```python
async for ev in envelope.from_msg(r.payload):
```

而 `Envelope.from_msg()` 无条件调用：

```python
cmd_msg.get_text_content()
```

位置：

- [runtime.py](D:/Program%20Files/Python313/Lib/site-packages/qwenpaw/runtime/runtime.py:114)
- [envelope.py](D:/Program%20Files/Python313/Lib/site-packages/qwenpaw/runtime/envelope.py:779)

因此实际错误是“短路结果违反 payload 契约”，而不是 `/qdm-userid` 业务执行失败。

## 3. 根因归属

该逻辑在主干提交 `d428e78 feat: QwenPaw 支持` 中已经存在；当前 runtime MCP 分支的新增提交没有修改该段代码。因此：

- 根因属于 QwenPaw 主干已有缺陷；
- 本次 runtime MCP 接入只是让该缺陷在当前环境中被触发；
- 与此前 HookCycleError 修复、Windows Node shim 兼容、MCP endpoint、SQLite、Blob 或 Harness Context 无直接关系。

## 4. 建议调整方案

### 4.1 插件侧修复（必须）

保持“`user_id_display_mode=off` 时不展示身份信息”的原有意图，但不要返回非法的短路结果。推荐二选一：

**方案 A（推荐，行为明确）**

在关闭模式下返回一个不包含身份信息的有效 `Msg`，例如“`/qdm-userid` 调试命令未启用”，仍使用 `SHORT_CIRCUIT` 结束本轮。

优点：不把调试命令交给模型解释，不触发数据查询，且满足 Runtime 的 payload 契约。

**方案 B（最小代码改动）**

在关闭模式下返回普通 `HookResult()`，让请求继续正常 Agent 流程。

该方案虽然避免异常，但 `/qdm-userid` 可能被模型当作普通文本处理，不建议作为最终行为。

### 4.2 Runtime 侧防御（建议）

在 Runtime 处理 `HookAction.SHORT_CIRCUIT` 时增加 payload 校验：

- payload 是有效 `Msg`：按现有逻辑封装并返回；
- payload 为 `None`：记录明确错误并转为安全的空响应或标准错误响应，不再调用 `get_text_content()`。

该调整属于宿主健壮性增强，不能替代插件侧修复；其他插件也可能错误构造短路结果。

### 4.3 测试补充（必须）

至少增加以下回归用例：

1. `display_mode=off` + `/qdm-userid`：不得抛异常，且不泄露 UserID；
2. `display_mode=command` + `/qdm-userid`：仍返回渠道和 UserID；
3. 企微群消息 `@机器人 /qdm-userid`：mention 去除后行为与直接 `/qdm-userid` 一致；
4. 普通文本及 `@机器人 查询我的数据权限`：继续进入原有 Harness/runtime MCP 查询链路；
5. Runtime 收到 `SHORT_CIRCUIT(payload=None)`：不得出现 `NoneType.get_text_content`。

## 5. 不在本次调整范围内

- 不修改企微 mention 解析规则；
- 不调整 qdmDataAgent 的正常工具、权限查询和 Blob 返回逻辑；
- 不修改 qdm-auth-center、SQLite 或 MCP 服务；
- 不重新启用生产环境的身份调试输出；
- 不恢复或新增 legacy reload bridge。

## 6. 验收标准

- 发送 `@data测试 /qdm-userid` 不再出现 `AttributeError`；
- `user_id_display_mode=off` 时不返回真实渠道 UserID；
- 正常权限查询仍能执行并返回原有结果；
- 日志不再出现 `envelope.py:779` 的 `NoneType` 异常；
- 既有 QwenPaw Hook 顺序和 runtime MCP 调用日志保持不变。

## 7. 建议提交说明

实现后建议使用清晰、可审查的提交信息：

```text
fix(qwenpaw): avoid null payload for disabled qdm-userid command
```

提交说明应注明：修复关闭调试命令时构造无 payload 的 `SHORT_CIRCUIT`，并补充 slash command 与 Runtime 防御性回归测试。

## 8. 实施记录

本次按方案 A 实施插件侧修复：`user_id_display_mode` 非 `command` 时，仍短路调试命令，但返回不包含渠道或 UserID 的有效 `Msg`，满足 QwenPaw Runtime 的 payload 契约。

同时更新回归测试，验证关闭模式不会泄露身份信息，开启模式仍返回渠道和 UserID。QwenPaw Runtime 位于宿主环境的 `site-packages` 中，不在本项目范围内直接修改；其 payload 防御建议保留为后续宿主升级项。
