# QwenPaw Shell Hook 查询方案：安装与运行态问题评审

> 文档用途：转发主窗口审核并据此调整工作区代码、安装器和宿主配置。
> 结论基于 2026-09-11 对本机 QwenPaw 安装目录、Agent 配置、插件配置和工作区源码的只读检查。
> 本轮未执行端到端验证，也未修改宿主配置。

## 1. 结论先行

当前插件文件已经按工作区代码安装成功，但安装后的运行环境尚未完整切换到 Shell Hook 方案。

需要区分两类问题：

1. **当前机器的一次性运行态问题**
   - QwenPaw 进程启动时间早于当前插件文件更新时间，运行进程可能仍持有旧插件代码；
   - `qdmDataAgent/agent.json` 中仍持久化保留并启用了旧工具 `qdm_query_guide`；
   - `C:\ProgramData\QDM\qwenpaw\plugin-config.json` 与当前插件配置契约不兼容，`load_config()` 会失败。

2. **工作区代码的长期一致性问题**
   - 安装器仍以 schema 1 / legacy 配置为主要写入契约；
   - 当前插件在配置加载失败时回退到 `legacy`，可能重新暴露 `qdm_query`；
   - 当前插件没有针对历史 `qdm_query_guide` Agent 配置条目的兼容清理逻辑；
   - 配置生成、配置校验、插件运行时三者没有完全统一到 Shell Hook 的发布契约。

因此，不能只清理当前机器后结束。为了保证后续重新安装不再复现，建议修改工作区代码和安装链路；当前机器的配置清理和重启作为后续部署动作单独执行。

## 2. 已确认事实

### 2.1 安装文件本身正确

- 安装目录：
  `C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw`
- 工作区源码目录：
  `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw`
- 已安装插件版本：`0.1.6`
- 已安装副本与工作区 `plugin.py` 的 SHA256 一致：
  `31FFBDA77C46221CB3F02DFA28D325DD59CABF0F8A85F597F49443B27F7AF93D`
- 当前安装副本和工作区源码中均搜索不到 `qdm_query_guide`。

结论：当前问题不是“工作区代码未安装”，而是旧运行态、持久化工具配置和配置契约不一致。

### 2.2 当前 Agent 仍保留旧工具

文件：

`C:\Users\QDM\.copaw\workspaces\qdmDataAgent\agent.json`

当前工具状态：

| 工具 | 当前状态 | Shell Hook 方案预期 |
| --- | --- | --- |
| `execute_shell_command` | enabled | enabled |
| `qdm_query_guide` | enabled | 不应存在 |
| `qdm_query` | disabled | 不应作为公共查询入口暴露 |
| `qdm_scope_summary` | disabled | 应保留并默认启用 |

`qdm_query_guide` 仍出现的直接原因是 Agent 配置文件中存在持久化条目。插件卸载或重新安装不会自动删除所有历史 Agent 工具配置。

`qdm_scope_summary` 与 `qdm_query_guide` 的职责不同：前者是当前 Shell Hook 方案仍需要保留的权限摘要工具，后者属于不再采用的结构化查询编排方案。当前 `qdm_scope_summary` 被关闭属于运行态配置问题，不应作为目标状态。

### 2.3 当前 QwenPaw 进程早于插件文件更新

- 当前 `qwenpaw app` 进程启动时间：**2026-09-10 12:15:34**
- 安装目录 `plugin.py` 更新时间：**2026-09-11 20:46:07**

因此，即使磁盘上的插件已经是新代码，当前运行进程也不能证明已经加载了新代码。必须完整重启 QwenPaw 后再判断工具列表。

### 2.4 当前插件配置无法被新代码加载

文件：

`C:\ProgramData\QDM\qwenpaw\plugin-config.json`

实际配置包含：

- `schema_version: 2`
- `runtime_mcp.enabled: true`
- `runtime_mcp.cache_*`
- `query_limits.batch_total_timeout_seconds`
- `query_limits.batch_result_bytes`
- `tool_execution_logging`

但当前 `qdm_config.py` 对 schema 2 只允许有限字段，并要求 Shell Hook 相关字段：

- `qdm_query_mode`
- `qdm_shell_hook_enabled`
- `qdm_shell_dialects`
- `qdm_shell_cmd_enabled`

当前配置缺少上述 Shell Hook 字段，同时包含当前实现不允许的额外字段。直接调用已安装副本的 `load_config()` 得到：

```text
ConfigError: plugin config contains unsupported fields
```

这会导致：

- Shell Hook Middleware 无法读取有效配置；
- `_query_mode_for_registration()` 捕获配置错误后回退到 `legacy`；
- `qdm_query` 可能重新注册；
- 配置错误被掩盖，运维侧难以判断真实状态。

## 3. 与设计文档的偏差

设计文档：

`D:\Repos\qwenpaw-harness-shell-hook-query-design.md`

实施规划：

`D:\Repos\qwenpaw-harness-shell-hook-query-implementation-plan.md`

两份文档均明确：

- Shell Hook 方案不新增 `qdm_query_guide`；
- 查询入口使用宿主 `execute_shell_command`；
- `qdm_query` 不应作为 Shell Hook 方案的公共查询入口；
- 配置应通过 feature flag 明确选择 `legacy` 或 `shell_hook`；
- 配置错误、Runtime MCP 不可用、requester 未绑定等情况必须 fail-closed；
- Shell Hook 与旧结构化查询方案不应在同一已安装实例中同时暴露同名公共入口。

当前实现存在以下偏差：

1. 旧的 `qdm_query_guide` 已写入 Agent 持久化配置，但没有被兼容清理。
2. 配置加载失败时，插件注册逻辑回退到 `legacy`，与 fail-closed 要求不一致。
3. Python 安装器默认写入 schema 1、`qdm_query_mode=legacy`、`qdm_shell_hook_enabled=false`。
4. 当前运行中的 schema 2 配置看起来由另一条安装/配置链路生成，字段集合与 Python 插件实现不一致。
5. 配置模板、安装器、Node setup、插件 `qdm_config.py` 没有形成唯一且可验证的配置来源。

## 4. 建议调整内容

### 4.1 必须调整：统一配置契约

建议主窗口先确定唯一的配置权威：

- 如果 Shell Hook 方案以 schema 2 为正式发布契约，则所有安装器、setup 命令、doctor 和模板都统一生成 schema 2；
- 如果仍需保留 schema 1 兼容，则必须明确 schema 1 只能用于 legacy，不得在 Shell Hook 发布流程中隐式生成。

建议调整：

1. 统一配置字段白名单，至少覆盖：

   ```text
   schema_version
   plugin_id
   plugin_version
   root_context_path
   secret_ref
   enabled_agents
   user_id_display_mode
   tool_policy
   context_limits
   query_limits
   report_limits
   runtime_mcp
   qdm_query_mode
   qdm_shell_hook_enabled
   qdm_shell_dialects
   qdm_shell_cmd_enabled
   ```

2. 删除当前实现不认识的字段，除非同时把它们正式加入 `qdm_config.py` 的数据模型和校验：

   ```text
   query_limits.batch_total_timeout_seconds
   query_limits.batch_result_bytes
   tool_execution_logging
   runtime_mcp.cache_max_entries
   runtime_mcp.cache_max_blob_bytes
   runtime_mcp.cache_max_total_bytes
   runtime_mcp.negative_cache_seconds
   ```

3. Windows 配置模板必须包含 Runtime MCP 和 Shell Hook 的完整示例，不能继续只提供 schema 1 legacy 模板。

4. `install-qwenpaw-plugin.py`、Node `qwenpaw setup`、doctor 和配置模板必须使用同一套字段命名、默认值和 schema 语义。

### 4.2 必须调整：配置错误禁止回退到 legacy

当前文件：

`D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\plugin.py`

当前逻辑在 `_query_mode_for_registration()` 中捕获 `ConfigError` 后返回 `"legacy"`。

建议改为：

1. 配置读取失败时不注册 `qdm_query`；
2. 保留 `qdm_scope_summary` 的注册和默认启用状态，但调用时返回明确的配置不可用错误；权限工具不能在缺少有效 requester、Runtime MCP 或配置时伪造结果；
3. Shell Middleware 返回稳定的初始化错误，并阻止原始 QDM Shell 命令执行；
4. 日志记录配置错误码和配置文件路径，但不记录 Blob、Token 或完整敏感配置；
5. doctor/安装器在启动前直接报告配置无效，不等到模型发起查询后才暴露。

核心原则：

```text
配置无效 -> 不启用查询能力 -> 不回退旧公共工具
```

这样可以避免配置错误时出现“表面上插件启动成功，实际又注册了 legacy 查询入口”的混合状态。

### 4.3 必须调整：清理历史 `qdm_query_guide`

当前 Shell Hook 代码只管理当前版本的工具名，没有清理历史版本写入的 `qdm_query_guide` Agent 条目。

建议增加一个范围明确的兼容清理机制：

1. 只清理本插件历史明确拥有的工具名：

   ```text
   qdm_query_guide
   qdm_query
   qdm_scope_summary
   ```

2. 只处理插件曾写入且位于目标 Agent 配置中的条目；
3. 不删除其他插件或宿主内置工具；
4. 在卸载、安装、启动同步和 Agent scope 收敛时都能执行；
5. 清理动作必须幂等，重复执行不会破坏配置；
6. 清理结果写入日志，便于确认旧工具是否已移除。

建议优先由安装器/卸载器执行一次持久化清理；插件启动时可再做一次窄范围兼容清理，防止历史配置在重启后重新注入。

### 4.4 必须调整：Shell Hook 模式下明确公共工具集合

Shell Hook 模式下建议最终只保留：

- 宿主内置：`execute_shell_command`
- 插件权限工具：`qdm_scope_summary`，默认启用

不应出现：

- `qdm_query_guide`
- `qdm_query`
- 任何仅为兼容旧编排流程而存在的公共查询工具

`qdm_scope_summary` 必须默认开启，原因如下：

1. 用户主动询问“我有哪些数据权限”时，需要通过该工具返回当前请求对应的权限摘要；
2. 权限模式下，最终查询回答需要披露账号可见范围时，需要通过该工具获取可信的权限范围；
3. 它是独立的权限摘要入口，不是 Shell Hook 获取 Blob 的前置步骤；
4. 普通数据查询的 Blob 获取由 Shell Middleware 在 `execute_shell_command` 执行前，通过 Runtime MCP 按当前 requester 独立完成，不依赖模型先调用 `qdm_scope_summary`。

因此，`qdm_scope_summary` 被禁用会导致用户无法主动查询权限摘要，并影响权限范围披露；但在 Shell Hook 配置正确时，不应因为该工具未被调用而阻断普通查询的 Blob 获取。普通查询是否能够获取 Blob，取决于 requester 绑定、Runtime MCP 和 Shell Middleware 配置是否正常。

实现上仍需明确：

- 是否仅对 `enabled_agents` 中的 Agent 注册；
- 是否在无 requester 或 Runtime MCP 不可用时显示为不可用；
- 是否会被写入 Agent `builtin_tools`，以及卸载时如何清理。

### 4.5 建议调整：安装器与 Doctor 增加运行态检查

安装器/Doctor 至少检查：

1. 当前 QwenPaw 版本是否支持 `register_middleware()`；
2. `execute_shell_command` 是否存在；
3. Shell Middleware 是否已经注册；
4. Runtime MCP endpoint、token 文件和权限是否有效；
5. `qdm-metric-cli` 和 `data-harness-cli` 是否存在且版本正确；
6. 当前配置能否被 `load_config()` 成功加载；
7. 当前 `qdm_query_mode` 是否为 `shell_hook`；
8. `qdm_shell_hook_enabled` 是否为 `true`；
9. Shell Hook 模式下 `qdm_query` 是否未启用；
10. Agent 配置中是否不存在 `qdm_query_guide`；
11. QwenPaw 进程是否需要重启；
12. 重启后实际 Agent 工具列表是否符合预期。

Doctor 输出建议区分：

```text
PASS  文件安装
PASS  源码版本
FAIL  plugin-config.json 配置契约
FAIL  Agent 遗留工具清理
WARN  QwenPaw 进程早于插件更新时间
BLOCKED  Shell Hook 尚未确认生效
```

### 4.6 建议调整：安装完成后的重启提示和版本证据

插件文件替换后，安装器必须明确提示：

```text
插件文件已更新，但当前 QwenPaw 进程仍可能加载旧代码；请完整重启 QwenPaw 后再检查工具列表。
```

建议同时记录：

- 插件版本；
- 安装目录；
- 工作区源码版本或 hash；
- 配置文件 hash；
- QwenPaw 进程启动时间；
- 插件加载时间；
- 实际注册的工具列表；
- Shell Middleware 注册结果。

## 5. 当前机器的一次性处理建议

这部分不是工作区代码修改，而是部署到本机时应执行的操作：

1. 备份：
   - `C:\ProgramData\QDM\qwenpaw\plugin-config.json`
   - `C:\Users\QDM\.copaw\workspaces\qdmDataAgent\agent.json`
2. 按最终配置契约重写 `plugin-config.json`；
3. 删除 `qdmDataAgent/agent.json` 中遗留的 `qdm_query_guide`；
4. 确认 `qdm_scope_summary` 已保留且默认启用；
5. 确认 `qdm_query` 未启用；
6. 完整停止并重启 QwenPaw；
7. 重启后检查实际工具列表和启动日志；
8. 最后再执行用户手动安排的端到端验证。

本次用户已明确端到端验证暂不由实施过程执行，因此本文件只要求完成静态检查、安装检查和重启后的工具注册检查；真实查询验证留给后续人工验收。

## 6. 建议修改文件清单

### 必改

- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\install-qwenpaw-plugin.py`
  - 统一配置 schema 和 Shell Hook 默认值；
  - 增加历史工具清理；
  - 增加配置校验和重启提示。
- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\plugin.py`
  - 配置错误禁止回退 legacy；
  - 增加历史工具的窄范围清理；
  - 明确 Shell Hook 模式下工具集合。
- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\qdm_config.py`
  - 与最终 schema、配置字段和默认值保持一致；
  - 如需保留缓存/批量限制字段，必须正式加入模型和校验，否则从生成端删除。
- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\config\qwenpaw-qdm.windows.json.example`
  - 改为与正式 Shell Hook 配置契约一致。

### 应同步检查

- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\npm\src\commands\qwenpaw.js`
- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\deploy\qwenpaw\ensure_qdm_agent.py`
- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\deploy\qwenpaw\README.md`
- `D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\skills\qdm-harness\SKILL.md`
- 相关 `tests/test_core.py`
- 相关 `tests/test_golden_path.py`
- 新增或扩展安装、配置、遗留工具清理测试

## 7. 建议新增测试

### 配置

- schema 2 完整 Shell Hook 配置可以加载；
- schema 2 包含未知字段时明确失败；
- 缺少 Shell Hook 配置字段时使用约定默认值或明确失败；
- 不允许通过配置失败隐式切换到 legacy；
- schema 1 只在明确 legacy 场景下可用。

### 工具注册

- Shell Hook 模式不注册 `qdm_query`；
- 任意模式都不注册 `qdm_query_guide`；
- 历史 Agent 配置包含 `qdm_query_guide` 时可以被窄范围清理；
- 清理其他插件工具不会发生；
- Agent scope 和 workspace reload 后工具集合保持一致。

### 安装与重启

- 从工作区重新安装后，安装副本与源码版本一致；
- 安装器写出的配置可被当前插件加载；
- 当前已有 QwenPaw 进程时，安装器明确要求重启；
- 重启后启动日志不再出现 `qdm_query_guide` 注册记录。

## 8. 主窗口审核结论项

请主窗口重点确认以下决策：

- [ ] 正式发布是否以 schema 2 为 Shell Hook 配置契约？
- [ ] schema 1 是否继续保留为 legacy 兼容入口？
- [ ] 配置错误是否统一采用 fail-closed，禁止回退 legacy？
- [ ] 是否由插件启动时兼容清理 `qdm_query_guide`，还是只由安装器/卸载器清理？
- [ ] Shell Hook 模式保留并默认启用 `qdm_scope_summary`（建议直接确认，不再作为开放决策项）；
- [ ] `runtime_mcp.cache_*`、批量超时和工具日志字段是删除，还是正式纳入配置模型？
- [ ] Node setup、Python installer、Doctor 是否统一由同一个配置生成逻辑负责？
- [ ] 完成静态修复和重启检查后，再由用户执行端到端验证？

## 9. 完成标准

满足以下条件后，才认为“安装与运行态问题已修复”：

1. 工作区所有配置生成入口输出同一套有效配置；
2. `load_config()` 可以成功读取部署配置；
3. 配置错误不会注册或暴露 legacy 查询工具；
4. `qdm_query_guide` 不存在于插件注册逻辑和目标 Agent 配置；
5. Shell Hook 模式下保留并默认启用 `qdm_scope_summary`，同时不启用 `qdm_query`；
6. 完整重启后日志和实际 Agent 工具列表一致；
7. 安装器、Doctor 和测试覆盖上述检查；
8. 端到端业务查询由用户按计划手动验证。
