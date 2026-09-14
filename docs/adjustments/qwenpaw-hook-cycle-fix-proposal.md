# QwenPaw HookCycleError 修复方案

## 1. 文档目的

本文用于说明 QwenPaw 企微请求出现以下错误的原因，并提出 runtime-MCP 分支的最小范围修复方案，供主窗口审核后实施。

```text
qwenpaw.exceptions.HookCycleError:
hook ordering cycle detected; unresolved: []
```

本方案的目标是修复 runtime-MCP 分支引入的 Hook 重复注册问题，同时保持 master 分支已有的 QwenPaw 插件功能不变。

## 2. 问题现象

会话编号：

```text
6fafa35b-dd62-48ef-8607-dd587afe3034
```

用户通过企微发送“查询我的数据权限”后，请求未能进入 `qdm_scope_summary` 或 runtime MCP 权限查询，直接在 QwenPaw Runtime 的 `PRE_AGENT_BUILD` 阶段失败。

日志关键位置：

```text
C:\Users\QDM\.copaw\qwenpaw.log
```

关键调用链：

```text
runtime.run()
  -> hooks.hooks_for(Phase.PRE_AGENT_BUILD)
  -> _topo_sort(...)
  -> HookCycleError
```

错误处理阶段又执行了一次 Hook 排序，因此出现：

```text
During handling of the above exception, another exception occurred
```

这不是二次业务错误，而是 `ON_ERROR` 阶段再次遇到同一个 Hook 排序异常。

## 3. 已确认事实

### 3.1 master 分支的 Hook 注册方式

master 分支已经注册以下 runtime Hook：

```text
qdm_harness.requester_identity
qdm_harness.debug_identity
qdm_harness.harness_context
qdm_harness.requester_bind
qdm_harness.requester_cleanup.post_response
qdm_harness.requester_cleanup.on_error
```

master 通过 QwenPaw 标准 API 注册：

```python
api.register_runtime_hook(...)
api.register_workspace_created_hook(...)
```

这些 Hook 本身数量和依赖关系不是错误来源。

### 3.2 runtime-MCP 分支新增逻辑

runtime-MCP 分支提交：

```text
7bb8fa2 feat(qwenpaw): 接入 runtime MCP 授权 Blob Provider
```

该提交除增加 runtime MCP 授权客户端外，还引入了 legacy reload bridge：

```python
_install_legacy_reload_bridge()
```

该桥接逻辑会包装 `manager.reload_agent()`，并在 reload 完成后手动重放插件的 `workspace_created` 回调。

### 3.3 当前 QwenPaw 2.1.0 的宿主行为

当前本机 QwenPaw 版本为：

```text
2.1.0
```

QwenPaw 2.1.0 的 `MultiAgentManager.reload_agent()` 在替换 workspace 后已经会调用：

```python
await self._fire_workspace_created_hooks(...)
```

因此宿主已经负责在 reload 后重新触发 `workspace_created` 回调。

## 4. 根因判断

根因是 runtime-MCP 分支新增的 legacy reload bridge 与 QwenPaw 2.1.0 原生 reload 生命周期重复执行。

实际流程如下：

```text
QwenPaw reload_agent()
        |
        v
宿主替换 workspace
        |
        v
宿主自动执行 workspace_created 回调
        |
        v
runtime Hook 注册一次
        |
        +-----------------------------+
                                      |
                                      v
插件 legacy reload bridge 再次重放 workspace_created
                                      |
                                      v
同一 workspace 再次注册同名 runtime Hook
                                      |
                                      v
HookRegistry._by_phase 出现重复 Hook
                                      |
                                      v
_topo_sort() 抛出 HookCycleError
```

结论：

```text
问题由 runtime-MCP 分支新增的 reload 兼容桥触发；
不是 master 分支多个 runtime Hook 的正常注册机制本身导致。
```

## 5. 推荐修复方案

### 5.1 核心原则

按宿主能力选择 reload 机制：

```text
宿主支持 register_workspace_created_hook
  -> 使用宿主标准 workspace_created 生命周期
  -> 不安装 legacy reload bridge

宿主不支持 register_workspace_created_hook
  -> 保留 legacy reload bridge 作为旧版本兜底
```

### 5.2 具体调整位置

仅调整：

```text
D:\Repos\harness-data-qwenpaw-runtime-mcp\.agents\qwenpaw\plugin.py
```

当前代码在注册 `register_workspace_created_hook` 后，无论宿主是否已具备该能力，都会通过 startup hook 注册：

```python
qdm_harness_install_reload_bridge
```

建议改为：

```python
register_ws_hook = getattr(api, "register_workspace_created_hook", None)

if callable(register_ws_hook):
    register_ws_hook(...)
    # 使用宿主标准生命周期，不安装 legacy reload bridge
else:
    logger.warning(...)
    # 仅旧宿主启用 legacy reload bridge
    register_startup_hook(
        hook_name="qdm_harness_install_reload_bridge",
        callback=_install_legacy_reload_bridge,
        priority=95,
    )
```

`_install_legacy_reload_bridge()` 函数本身暂不删除，以保留没有 `workspace_created` 能力的旧宿主兼容性。

### 5.3 当前环境的预期行为

当前 QwenPaw 2.1.0 支持 `register_workspace_created_hook`，因此应：

```text
注册标准 runtime Hook
注册标准 workspace_created 回调
不注册 qdm_harness_install_reload_bridge
```

workspace reload 时由 QwenPaw 宿主自动重新执行回调，不再由插件额外重放。

## 6. 不调整的内容

为降低回归风险，以下内容不修改：

- master 分支代码；
- `qdm_runtime_mcp.py`；
- `qdm_runtime_hooks.py` 的业务 Hook 顺序；
- `qdm_config.py` 的 runtime MCP 配置解析；
- `qdm_query` 和 `qdm_scope_summary` 工具逻辑；
- agent scope 规则；
- qdm-auth-center 服务；
- QwenPaw 宿主源码；
- runtime MCP endpoint、Token 或 SQLite 数据。

不建议通过降低 Hook priority、删除所有同名 Hook 或修改 QwenPaw `_topo_sort()` 来规避问题。

## 7. 测试要求

### 7.1 单元测试

建议在：

```text
D:\Repos\harness-data-qwenpaw-runtime-mcp\.agents\qwenpaw\tests
```

增加或调整测试，至少覆盖：

1. 宿主支持 `register_workspace_created_hook` 时，不注册 legacy bridge；
2. 宿主不支持 `register_workspace_created_hook` 时，仍注册 legacy bridge；
3. workspace reload 后每个 runtime Hook 仅存在一个实例；
4. `hooks_for(Phase.PRE_AGENT_BUILD)` 能正常完成拓扑排序；
5. `qdm_scope_summary` 可正常执行；
6. `qdm_query` 可正常执行；
7. 未启用的 agent 仍保持原有工具隐藏行为；
8. 普通聊天不触发 QDM 权限查询。

### 7.2 运行时验证

修复后必须完整重启 QwenPaw，以清理当前进程中已经重复注册的 Hook，然后执行：

```text
1. 启动 qdm-auth-center
2. 启动 QwenPaw
3. 选择 qdmDataAgent
4. 调用 qdm_scope_summary
5. 修改 agent 配置，触发 workspace reload
6. 再次调用 qdm_scope_summary
7. 调用 qdm_query
8. 检查日志
```

日志中应满足：

```text
不再出现 HookCycleError
不再出现 hook ordering cycle detected
不再出现 qdm_harness_install_reload_bridge（当前 QwenPaw 2.1.0）
```

每次 reload 后，Hook 列表应保持唯一：

```text
qdm_harness.requester_identity  1 次
qdm_harness.debug_identity      1 次
qdm_harness.harness_context     1 次
```

## 8. 回滚方案

本次修复只涉及插件代码和测试。若验证失败，可回滚该修复提交，不影响：

- qdm-auth-center SQLite 数据；
- runtime/admin MCP 监听端口；
- Token 文件；
- QwenPaw 工作区数据；
- master 分支。

回滚后需要重新启动 QwenPaw，避免旧进程中的 Hook 注册状态残留。

## 9. 建议提交说明

建议使用 Angular 风格提交信息，正文简要说明：

```text
fix(qwenpaw): avoid duplicate runtime hooks during workspace reload
```

提交说明建议包含：

```text
- QwenPaw 2.1 已自动触发 workspace_created
- runtime-MCP legacy reload bridge 会造成重复 Hook 注册
- 仅在宿主缺少 workspace_created 能力时保留 bridge
- 补充新旧宿主能力分支测试
```

## 10. 最终审核结论建议

建议主窗口按以下结论审核：

```text
同意实施。

这是 runtime-MCP 分支新增的 reload 兼容逻辑与 QwenPaw 2.1 原生生命周期冲突，
不是 master 分支正常 Hook 注册功能的问题。

采用能力检测进行最小修复：当前宿主支持 workspace_created 时禁用 legacy bridge，
旧宿主仍保留 bridge 兜底；不修改 master、QwenPaw 宿主或 QDM 业务逻辑。
```
