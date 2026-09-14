# QwenPaw Windows Harness Context CLI 兼容性调整方案

> 状态：已确认并实施（2026-09-04）。

## 1. 文档目的

本文整理 QwenPaw 在 Windows 环境下返回“Harness 上下文不可用”的问题、已确认的根因及建议调整方案，供主窗口审核后实施。

本问题与 runtime MCP 权限查询、HookCycleError 修复相互独立。目标是在不改变 Harness CLI 业务逻辑、runtime MCP 和 QDM 查询逻辑的前提下，修复 Windows 下 Context CLI 的启动兼容性。

## 2. 问题现象

会话编号：

```text
6fafa35b-dd62-48ef-8607-dd587afe3034
```

用户通过企微发送：

```text
查询我的数据权限
```

QwenPaw 返回：

```text
Harness 上下文不可用
```

日志关键位置：

```text
C:\Users\QDM\.copaw\qwenpaw.log:3944
```

关键日志：

```text
qdm_harness_context_failed reason=context_cli_unavailable
```

对应处理顺序为：

```text
企微收到请求
  -> PRE_AGENT_BUILD
  -> qdm_harness.harness_context
  -> Context CLI 路径/执行检查失败
  -> 返回“Harness 上下文不可用”
  -> 未进入 qdm_scope_summary
  -> 未调用 qdm_auth_lookup_blob
```

## 3. 已确认事实

### 3.1 插件配置解析出的路径

当前 Root Context 的 `pluginRoot` 为：

```text
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw
```

当前 `qdm_config.py` 根据 Windows 平台拼接出的 Context CLI 路径为：

```text
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw\scripts\data-harness-cli.exe
```

### 3.2 实际安装文件

插件目录中实际存在：

```text
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw\scripts\data-harness-cli
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw\scripts\harness-data
```

不存在：

```text
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw\scripts\data-harness-cli.exe
```

实际存在的 `data-harness-cli` 是 Node shim，内容以以下形式开头：

```javascript
#!/usr/bin/env node
```

其职责是加载：

```text
dist/data-harness-cli/src/main.js
```

### 3.3 当前 Context CLI 的检查逻辑

`qdm_harness_context.py` 在执行前会检查：

```python
if cli_path.is_symlink() or not cli_path.is_file():
    raise HarnessContextError("context_cli_unavailable")
```

由于 Windows 配置解析出的 `.exe` 文件不存在，请求在执行 Context CLI 之前就失败。

即使改为指向无扩展名 shim，Windows 也不能稳定地通过 `subprocess.run([shim_path], shell=False)` 直接执行该 Node 脚本，因此还需要调整启动方式。

## 4. 根因判断

根因是 Windows 下“CLI 路径命名”和“CLI 实际启动方式”不一致：

```text
打包脚本生成：scripts/data-harness-cli（Node shim）
        |
        v
Windows 配置逻辑查找：scripts/data-harness-cli.exe
        |
        v
目标文件不存在
        |
        v
qdm_harness_context.py 返回 context_cli_unavailable
        |
        v
Harness 上下文不可用
```

这不是以下问题：

- qdm-auth-center 未启动；
- runtime MCP endpoint 不可达；
- runtime Token 无效；
- SQLite 中缺少权限数据；
- `qdm_auth_lookup_blob` 返回错误；
- `qdm_scope_summary` 业务逻辑异常。

因为 Context CLI 是进入 QDM 工具调用前的前置 Hook，所以权限 MCP 尚未执行。

## 5. 问题归属

该路径约定在 master 版本中已经存在，runtime-MCP 分支沿用了该逻辑：

```python
"data-harness-cli.exe" if os.name == "nt" else "data-harness-cli"
```

同时，QwenPaw 插件打包脚本生成的是无扩展名 Node shim。因此这是原有 Windows QwenPaw 插件适配中的兼容缺陷，不是 runtime MCP 授权功能本身引入的业务错误。

runtime-MCP 分支只是让该问题在本次权限查询链路中暴露出来。

## 6. 推荐调整方案

### 6.1 总体原则

保持跨平台行为和现有业务职责不变：

```text
Linux：继续执行 data-harness-cli
Windows：使用 Node 显式执行 data-harness-cli shim
```

不把 Node shim 伪装成 `.exe`，也不修改 Harness CLI 的命令参数和输出协议。

### 6.2 修改 `qdm_config.py`

调整 `_harness_cli_from_context()` 的 Windows 路径解析逻辑。

当前逻辑：

```python
return base / "scripts" / (
    "data-harness-cli.exe" if os.name == "nt"
    else "data-harness-cli"
)
```

建议改为解析打包实际生成的 shim：

```text
Windows 和 Linux 均优先解析：scripts/data-harness-cli
```

同时保留对显式存在的 `.exe` 的兼容（如未来发布真正的 Windows 二进制）：

```text
优先级：
1. scripts/data-harness-cli.exe（存在时）
2. scripts/data-harness-cli（Node shim 存在时）
3. 否则报告 Context CLI unavailable
```

最终配置对象应保存实际可用的 CLI 路径，而不是根据平台盲目拼接扩展名。

### 6.3 修改 `qdm_harness_context.py`

调整 `request_context()` 的执行命令构造逻辑。

建议增加启动命令解析：

```text
如果 cli_path 是真正的 Windows 可执行文件：
    直接执行 cli_path

如果 cli_path 是无扩展名 Node shim：
    使用 node.exe 显式执行 cli_path

Linux：
    保持现有直接执行方式
```

Windows 推荐命令形态：

```text
node.exe <pluginRoot>\scripts\data-harness-cli context --format qwenpaw-hook
```

Node 路径建议按以下顺序解析：

```text
1. 配置或环境变量指定的 Node
2. 当前进程 PATH 中的 node.exe
3. 无法找到时返回 context_cli_unavailable
```

不建议使用 `shell=True`，避免引入命令拼接、转义和 Shell 注入风险。

建议继续使用：

```python
subprocess.run(..., shell=False, ...)
```

### 6.4 不建议修改打包结构作为唯一修复

可以增加 `.cmd` 启动器，但 `.cmd` 仍不能在 `shell=False` 下像普通可执行文件一样直接启动，最终仍需要特殊处理。

因此不建议仅增加：

```text
scripts/data-harness-cli.cmd
```

而不调整 Python 启动逻辑。

## 7. 推荐的执行命令抽象

建议在 `qdm_harness_context.py` 中封装一个内部函数，例如：

```python
def _build_context_argv(cli_path: Path, args: list[str]) -> list[str]:
    ...
```

逻辑示意：

```text
输入 cli_path
  |
  +-- data-harness-cli.exe 存在且为普通文件
  |      -> [str(cli_path), *args]
  |
  +-- data-harness-cli 无扩展名且为普通文件
  |      -> [node_executable, str(cli_path), *args]
  |
  +-- 其他情况
         -> HarnessContextError(context_cli_unavailable)
```

这样可以将路径识别、Node 解析和参数构造集中处理，避免在 `request_context()` 中增加平台分支散落。

## 8. 配置和安全约束

调整后继续保持以下约束：

- CLI 路径必须是绝对路径或由受信 Root Context 解析；
- 路径不能是符号链接；
- Node 可执行文件不能从用户输入参数中直接拼接；
- 使用 `shell=False`；
- 不把 Blob、Token 或权限内容写入 Context CLI 日志；
- Context CLI 超时仍由 `context_cli_timeout_seconds` 控制；
- CLI 非零退出、协议错误、空上下文仍映射为现有 `HarnessContextError` 分类。

## 9. 测试要求

### 9.1 路径解析测试

至少覆盖：

```text
Windows + data-harness-cli.exe 存在
Windows + 仅 data-harness-cli shim 存在
Linux + data-harness-cli 存在
目标文件缺失
目标路径为符号链接
```

### 9.2 执行命令测试

至少验证：

```text
Windows shim 使用 node.exe 启动
Windows 真正 exe 直接启动
Linux 直接启动原有 CLI
不使用 shell=True
参数包含 context --format qwenpaw-hook
```

### 9.3 协议和失败测试

保持现有行为，覆盖：

```text
CLI 正常返回 hookSpecificOutput.additionalContext
CLI 返回非零退出码
CLI 返回非法 JSON
CLI 返回空 additionalContext
CLI 返回 QDM_* safety 输出
CLI 超时
```

### 9.4 QwenPaw 实机回归

修复并重新安装后：

```text
1. 完整重启 QwenPaw
2. 选择 qdmDataAgent
3. 企微发送“查询我的数据权限”
4. 确认不再出现 Harness 上下文不可用
5. 确认 qdm_scope_summary 被调用
6. 确认 runtime MCP lookup 成功
7. 检查未出现 HookCycleError
```

预期链路：

```text
Windows Node shim
  -> Harness Context
  -> qdm_scope_summary
  -> qdm_auth_lookup_blob
  -> qdm-auth-center SQLite
  -> 权限摘要
```

## 10. 不调整的内容

本次修复不修改：

- qdm-auth-center 服务；
- runtime/admin MCP endpoint；
- runtime Token 文件；
- SQLite 权限数据；
- `qdm_runtime_mcp.py`；
- `qdm_runtime_hooks.py` 的 Hook 业务顺序；
- `qdm_query` 和 `qdm_scope_summary` 业务逻辑；
- Harness CLI 命令协议；
- Linux 下现有直接执行逻辑；
- 其他 agent 的权限流程。

## 11. 影响范围

建议代码改动限定在：

```text
D:\Repos\harness-data-qwenpaw-runtime-mcp\.agents\qwenpaw\qdm_config.py
D:\Repos\harness-data-qwenpaw-runtime-mcp\.agents\qwenpaw\qdm_harness_context.py
D:\Repos\harness-data-qwenpaw-runtime-mcp\.agents\qwenpaw\tests\...
```

如果实现选择在打包脚本中补充 Windows 元数据，也应作为兼容性辅助改动，不能替代 Python 端的正确启动逻辑。

## 12. 回滚方案

若实机验证失败，可回滚本次插件代码提交并重新安装旧版本。回滚不应影响：

- qdm-auth-center 进程；
- MCP 端口；
- Token 文件；
- SQLite 数据；
- QwenPaw 工作区和会话数据。

回滚或重新安装后都应完整重启 QwenPaw，确保 Python 进程不再使用旧插件模块。

## 13. 建议提交说明

建议提交信息：

```text
fix(qwenpaw): support Windows Node shim for Harness context
```

提交正文可简要说明：

```text
- Windows 配置不再盲目查找不存在的 data-harness-cli.exe
- 支持通过 node.exe 执行无扩展名 Harness CLI shim
- 保持 Linux 执行方式和 Harness CLI 协议不变
- 补充 Windows 路径、启动和失败场景测试
```

## 14. 审核建议结论

建议主窗口审核通过以下方案：

```text
同意实施。

当前错误发生在 Harness Context 前置 Hook，原因是 Windows 下路径解析为
data-harness-cli.exe，但插件实际打包的是无扩展名 Node shim。

采用最小代码修复：qdm_config.py 解析实际存在的 CLI，
qdm_harness_context.py 在 Windows 下使用 node.exe 显式执行 shim。

不修改 qdm-auth-center、runtime MCP、SQLite 数据、QDM 工具业务逻辑和 Linux 行为。
```

## 15. 实施记录

本方案已实施，实际改动如下：

- 新增 `qdm_subprocess.py`，统一封装跨平台 CLI 命令构造：Windows 优先使用同名 `.exe`，否则使用 PATH 中的 `node` 显式启动无扩展名 shim；Linux/macOS 保持直接执行。
- `qdm_config.py` 不再盲目拼接 `.exe`，在原生文件存在时使用原生文件，否则解析无扩展名 shim。
- `qdm_harness_context.py`、`qdm_cli.py` 和 `qdm_report_lifecycle.py` 统一使用该命令构造器，覆盖 Context、授权预检和报告生命周期调用。
- `test_core.py` 增加 Windows 原生 exe、Windows Node shim、POSIX 直执行三类回归测试。

所有子进程继续使用参数数组和 `shell=False`，未改变 Harness CLI 参数及输出协议。
