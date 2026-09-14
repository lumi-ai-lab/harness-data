# QwenPaw `qdm_query` 工具删除调整方案

## 1. 结论

当前新的 QwenPaw Shell Hook 数据查询流程已经基本验证通过，可以删除
QwenPaw 插件对外暴露的 `qdm_query` 工具。

本次删除应限定在 QwenPaw 的 Agent 工具面和安装/清理逻辑，不删除共享
`data-harness-cli` 的授权协议、Shell Hook 查询链路或其他宿主的兼容代码。

## 2. 调整目标

- QwenPaw Agent 不再看到或调用 `qdm_query`。
- QwenPaw 数据查询统一通过 `execute_shell_command` 触发 Shell Hook。
- QwenPaw 报告流程继续使用 `qdm_report_stage`。
- `qdm_scope_summary` 保持可用。
- 已有 `agent.json` 中残留的 `qdm_query` 和 `qdm_query_guide` 被清理。
- 插件热重载、workspace 重建和 setup/doctor 流程保持一致。

## 3. 具体调整

### 3.1 插件注册

调整 `.agents/qwenpaw/plugin.py`：

- 删除 `qdm_query` 的公开工具函数和注册分支。
- QwenPaw 工具面固定保留：
  - `qdm_scope_summary`
  - `qdm_report_stage`
- Shell Hook Middleware、请求身份绑定、授权快照和报告生命周期不变。
- 与 `qdm_scope_summary` 相关的内部授权组件继续保留。

`qdm_query_mode` 配置字段暂时保留读取兼容，避免旧配置因字段缺失或多余
字段启动失败；它不再决定是否注册 `qdm_query`。

### 3.2 已有 Agent 配置清理

调整以下清理逻辑：

- `.agents/qwenpaw/install-qwenpaw-plugin.py`
- `deploy/qwenpaw/ensure_qdm_agent.py`
- `npm/src/commands/qwenpaw.js`

要求：

- 删除 `qdm_query_guide`。
- 删除 `qdm_query`，而不是仅设置 `enabled: false`。
- 保留并确保启用 `qdm_scope_summary`。
- Shell Hook 模式保留并确保启用 `qdm_report_stage`。
- `preserve` 和 `strict` 两种策略都必须执行 QDM 工具迁移。
- 不改动其他非 QDM 内置工具。

### 3.3 工具白名单与 doctor

- Shell Hook 白名单只包含：
  - `execute_shell_command`
  - `qdm_scope_summary`
  - `qdm_report_stage`
  - `get_current_time`
- legacy 配置不再生成或启用 `qdm_query`，仅保留配置读取兼容。
- doctor/allowlist 检查应将残留的 `qdm_query` 视为异常。
- 已删除的 `qdm_query` 不应被重新加入 Agent 配置。

### 3.4 共享兼容边界

以下内容本次不删除：

- `packages/data-harness-cli/src/lib/authz/hook.js` 对
  `qdm_query` 的内部授权适配。
- `packages/data-harness-cli/src/lib/posttool/qwenpaw.js` 对历史
  `qdm_query` payload 的兼容。
- `.agents/qwenpaw/qdm_cli.py` 中供 Shell Hook 和权限摘要使用的执行能力。
- 其他宿主（Codex、Pi、WorkBuddy、Claude）的工具和协议。

这些代码属于共享运行时或历史兼容层，删除它们会扩大影响面，当前没有必要。

## 4. 测试调整

增加或修改离线测试，至少覆盖：

1. QwenPaw 插件注册后不包含 `qdm_query`。
2. Shell Hook 和 legacy 配置都不会注册 `qdm_query`。
3. 已有 `agent.json` 中的 `qdm_query` 和 `qdm_query_guide` 会被删除。
4. `qdm_scope_summary` 仍可注册、调用和返回结果。
5. `qdm_report_stage` 仍可注册并完成报告模板阶段。
6. `execute_shell_command` 的 Shell Hook 查询策略不受影响。
7. 共享 CLI 的历史 `qdm_query` 协议测试继续通过。
8. 非 QwenPaw 宿主的既有测试不受影响。

## 5. 验收边界

本次代码验收只执行离线测试、语法检查和 diff 检查。

不执行：

- QwenPaw 插件重装。
- QwenPaw 进程重启。
- 真实渠道端到端数据查询。

真实 QwenPaw 行为由后续人工验证确认。

## 6. 风险控制

- 删除范围限定在 QwenPaw 对外工具和 QwenPaw Agent 配置迁移。
- 不修改 Shell Hook 的授权注入、请求身份、Blob 获取和报告生命周期。
- 不回滚或覆盖工作区中与本次任务无关的已有修改。
- 配置字段保留兼容读取，避免旧安装直接因 schema 不兼容而失败。
