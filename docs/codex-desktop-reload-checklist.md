# Codex Desktop reload/new-session 验收清单

> 用途：补齐 Phase 5 P5-02 唯一未完成的桌面客户端证据。
> 说明：该清单必须由人工在真实 Codex Desktop 中执行；CLI TUI、进程重启或目录替换不能替代。

## 前置条件

- Codex Desktop 已登录并能打开一个测试项目。
- 当前插件版本为正式 `0.0.54`，并已在目标 marketplace 中启用。
- 测试项目、独立 `dataRoot`、`secretRoot` 和 `stateRoot` 均可访问。
- 使用测试 secret；不要把生产 auth 内容写入记录或截图。

## Reload 前

1. 在 Codex Desktop 中确认插件列表包含 `harness-data` 且状态为 enabled。
2. 确认 html-report MCP 显示 connected，工具数量与当前 artifact 一致。
3. 输入框中键入 `$html-report`，确认 skill 可被发现，但不要提交业务 prompt。
4. 通过 CLI 记录一次只读诊断：

   ```text
   qdm-harness paths --json
   qdm-harness doctor --json
   ```

5. 在测试 workspace 中启动一个显式 report session，记录 session ID 和当前阶段。

## 执行 reload/new-session

1. 使用 Codex Desktop 的原生 reload/restart 操作重新加载插件。
2. 关闭当前会话并新建一个会话，保持 workspace 不变。
3. 重新检查插件 enabled、MCP connected 和 `$html-report` skill discovery。
4. 使用同一 session ID 或宿主提供的恢复入口检查既有 report session 是否可读。
5. 在只读 pluginRoot + 可写 dataRoot 条件下完成一次不写入 pluginRoot 的 report 操作。

## 通过标准

- reload 后插件仍能被发现并启用；
- MCP 工具连接正常，skill 可被发现；
- 既有 report/session state、metric runtime 和 secret reference 仍可用；
- 新建 session 与原 workspace 隔离，不覆盖旧 session；
- pluginRoot 内容未发生写入，最终报告只写入 workspaceRoot；
- `doctor --json` 不输出 secret 内容；
- 普通非 QDM prompt 不创建 durable state。

## 证据记录

```text
执行日期：
Codex Desktop 版本：
插件版本：
workspaceRoot（可脱敏）：
dataRoot/stateRoot（可脱敏）：
Reload 操作：
插件/MCP/skill 结果：
既有 session 恢复结果：
新 session 结果：
pluginRoot 只读检查：
doctor 输出摘要（不含 secret）：
截图或日志位置：
执行人：
```
