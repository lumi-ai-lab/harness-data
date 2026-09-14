# QwenPaw Shell Hook 查询首次失败问题整理

> 用途：转发主窗口审核，并据此调整工作区代码。
>
> 本文针对 QwenPaw 会话 `6fafa35b-dd62-48ef-8607-dd587afe3034` 中“查询昨天的毛利率”首次执行失败、随后重试成功的问题。
>
> 本文仅整理问题和建议，不执行端到端验证，不修改宿主机配置。

## 1. 结论先行

本次首次失败不是 `qdm-metric-cli.exe` 的业务执行失败，也不是用户权限、Blob、Runtime MCP 或 CLI 路径问题。

失败发生在 QwenPaw `execute_shell_command` 的 PreToolUse Hook 阶段：

```text
QDM_AUTHZ_REWRITE_FAILED: QDM Shell 命令无法安全改写
```

当前最可能且已通过离线等价复现确认的根因是：

> Agent 自行携带了 `--data-auth --auth-blob`，Hook 清理并重新注入授权参数后，生成的命令与原命令文本完全相同；Hook 将 `rewritten === command` 错误当成“没有完成安全改写”，从而拒绝了本来已经满足授权绑定条件的命令。

也就是说，当前 Hook 把“幂等改写”误判成“改写失败”。

## 2. 会话事实

### 2.1 首次失败命令

首次失败调用为：

```text
call_9ed67839a4c848d689fddc1a
```

命令结构如下，Blob 已脱敏：

```text
"C:\Users\QDM\.qdm\harness-data\instance\0.1.6\runtimes\windows-amd64\qdm-metric-cli.exe" analysis execute
  --start-date 2026-09-11
  --end-date 2026-09-11
  --measures-json "[{\"metric\":\"afcouponProfitRate\",\"statisticPolicy\":\"SUMMARY\"}, ... ]"
  --agg-dim bizDate
  --format json
  --output envelope
  --data-auth
  --auth-blob "qdm1enc.<REDACTED>"
```

工具结果：

```text
QDM_AUTHZ_REWRITE_FAILED: QDM Shell 命令无法安全改写
```

该结果来自 Hook，说明真实的 `qdm-metric-cli.exe` 尚未执行。

### 2.2 后续成功调用

后续成功调用为：

```text
call_cbc2a39bb54f48b6974fc67b
```

会话文件中记录的命令文本与首次失败调用相同，最终真实 CLI 返回：

```json
{
  "code": "OK"
}
```

并返回了五个原子指标及毛利率结果。

### 2.3 已确认正常的链路

- `qdm_scope_summary` 已成功，说明用户权限上下文可用。
- Runtime MCP 当前可用。
- 当前 requester 与 Blob 获取链路可用。
- `qdm-metric-cli.exe` 路径存在且可执行。
- Windows `cmd` 方言能够完成一次成功查询。
- 查询日期、指标参数和数据源均正常。
- 工作区 JS 文件与已安装插件对应文件的 SHA256 一致。

因此，本次问题不应归因于：

- 用户无数据权限；
- Blob 过期或无效；
- Runtime MCP 不可用；
- CLI 文件不存在；
- `--measures-json` 业务 JSON 无法解析；
- 数据查询服务或指标注册表失败。

## 3. 离线复现结果

使用当前工作区实现：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\authz\metric-command.js
```

并使用会话中的实际命令和受信任 CLI 路径进行离线调用，结果如下：

| 场景 | `rewriteGatedMetricCommands` 结果 |
| --- | --- |
| 命令已包含受信任绝对 CLI 路径和当前 `--data-auth --auth-blob` | 重写结果与原命令相同 |
| 删除模型自带授权参数后再重写 | 成功追加授权参数，结果与原命令不同 |

等价验证结果：

```text
原命令已含授权参数：rewritten === command -> true
删除模型授权参数后：rewritten === command -> false
```

这说明当前解析器可以识别本次命令形态，包括：

- Windows 绝对路径；
- 带引号的 CLI 路径；
- `--measures-json` 中的 `\"` 转义；
- `analysis execute`；
- 已有 `--data-auth --auth-blob`。

本次主要问题不是命令无法被解析，而是重写结果的判定方式不正确。

## 4. 当前代码问题

相关文件：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\authz\hook.js
```

### 4.1 Shell Hook 的失败判定

当前逻辑在约第 487 行：

```js
if (!rewritten.trim() || rewritten === command) {
  return {
    ok: true,
    output: denyOutput("QDM_AUTHZ_REWRITE_FAILED: ..."),
  };
}
```

这里同时检查了两个条件：

1. 没有生成有效命令；
2. 生成的命令与原命令文本相同。

第 2 个条件不成立为安全判据。经过清理、可信 CLI 替换和授权参数重新绑定后，合法结果可能与输入文本完全一致。例如本次命令已经由 Agent 提前写入了最终形式，Hook 的规范化操作是幂等的。

### 4.2 重写函数已经具备更强的校验

相关文件：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\authz\metric-command.js
```

`rewriteGatedMetricCommands()` 已经对以下条件进行校验：

- 命令中存在且只存在一条受保护的指标调用；
- 调用绑定到受信任 CLI 路径；
- `--auth-blob` 恰好绑定一次；
- `analysis execute` 包含且仅包含一次 `--data-auth`；
- `auth describe` 不包含 `--data-auth`；
- 不允许遗留 `--auth-json`；
- 多命令或重叠调用不能安全改写时直接抛错。

因此，Hook 不应再用“文本是否发生变化”作为第二套成功判据。

## 5. 建议调整内容

### 5.1 必须调整：移除幂等改写失败判定

建议将 Shell Hook 的判断从：

```js
if (!rewritten.trim() || rewritten === command) {
  deny("QDM_AUTHZ_REWRITE_FAILED");
}
```

调整为：

```js
if (!rewritten.trim()) {
  deny("QDM_AUTHZ_REWRITE_FAILED");
}
```

前提是 `rewriteGatedMetricCommands()` 继续保留现有的结构化安全校验。

安全判断应基于：

- 解析到唯一 QDM 受保护调用；
- 受信任 CLI 路径已绑定；
- Blob 已由当前 requester 对应的授权上下文提供；
- 授权参数数量和类型正确；
- 不存在明文 `--auth-json`；
- 不存在多命令、歧义命令或未授权执行路径。

不能基于：

- 重写前后字符串必须不同。

### 5.2 建议调整：Agent 侧继续禁止自行携带授权参数

设计文档已明确要求 Agent 只写业务参数，不自行添加：

```text
--data-auth
--auth-blob
--auth-json
```

本次会话中 Agent 仍然自行携带了这些参数。建议继续保留并强化提示词/Skill 约束，减少幂等场景出现。

但是，Agent 侧约束不能替代 Hook 的健壮性修复。Hook 必须能够安全处理重复授权参数，并在校验通过时允许幂等结果。

### 5.3 建议增加可脱敏诊断信息

当前 `catch` 直接丢弃了重写异常，随后统一返回 `QDM_AUTHZ_REWRITE_FAILED`，导致无法区分：

- 没有找到受保护调用；
- CLI 路径未绑定；
- 授权参数数量错误；
- 命令包含多个调用；
- 重写函数内部异常；
- 幂等重写被错误拒绝。

建议仅在本地日志中记录以下脱敏信息，不记录 Blob 原文：

```text
dialect
metricInvocationCount
trustedCliPathHash
blobHash
originalCommandHash
rewrittenCommandHash
rewrittenEqual
rewriteFailureReason
```

约束：

- Blob 只记录摘要或哈希；
- 不记录完整命令；
- 不记录 `--auth-blob` 值；
- 不向终端用户暴露内部诊断细节。

### 5.4 建议增加回归测试

应在以下测试场景中覆盖 Shell Hook：

1. 未携带授权参数的 Windows 绝对路径命令，能够完成注入。
2. 携带模型自带 `--data-auth --auth-blob` 的命令，能够清理并重新绑定。
3. 清理并重新绑定后文本与原命令相同，仍应允许。
4. 绝对 CLI 路径不受信任时拒绝。
5. `--auth-blob` 出现两次时拒绝。
6. `--auth-json` 出现时拒绝。
7. 同一 Shell 调用包含两个 QDM 查询时拒绝。
8. `--measures-json` 含 `\"` 转义时能够正确识别。
9. `cmd /c` 包裹命令时能够正确识别和改写。
10. `auth describe` 只注入 `--auth-blob`，不注入 `--data-auth`。

推荐重点断言：

```text
授权结构合法 + 改写结果等于原命令 -> allow
授权结构不合法或无法绑定受信任 CLI -> deny
```

## 6. 建议修改文件

### 必改

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\authz\hook.js
```

- 移除 `rewritten === command` 导致的误拒绝；
- 保留并依赖 `rewriteGatedMetricCommands()` 的结构化校验；
- 必要时保留内部脱敏失败原因。

### 应补测试

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\test\authz-hook.test.js
```

如现有测试拆分需要，也可以补充：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\test\metric-command.test.js
```

当前工作区未发现必须同步修改的 Python Shell Middleware、安装器或宿主配置文件。它们负责调用授权适配器和回传 `updatedInput.command`，本次失败的直接判定点在 JS Hook。

## 7. 修复后的验证要求

本次按用户要求不执行端到端验证，待主窗口审核并完成代码调整后，由用户手动重启 QwenPaw，再验证：

1. 首次查询“查询昨天的毛利率”不再出现 `QDM_AUTHZ_REWRITE_FAILED`。
2. Agent 即使错误携带授权参数，也不会因幂等重写被误拒绝。
3. Hook 仍会清理并重新绑定当前 requester 的授权 Blob。
4. 无权限、Blob 无效、CLI 不可信、多命令等异常仍然 fail-closed。
5. 查询结果仍按当前用户数据权限返回。

## 8. 审核时需要确认的边界

主窗口审核时请重点确认：

- 是否同意将 `rewritten === command` 从失败条件中移除；
- 是否要求 `rewriteGatedMetricCommands()` 改为返回“重写结果 + 校验元数据”，以便 Hook 显式判断授权绑定状态；
- 是否需要将本次失败原因作为独立错误码，例如 `QDM_AUTHZ_REWRITE_IDEMPOTENT`；
- 诊断日志是否只记录哈希和计数，不记录命令全文及 Blob；
- 是否将 Agent 自带授权参数视为提示词违规但仍由 Hook 兼容处理。

## 9. 最终建议

建议主窗口优先完成以下最小修复：

1. 删除 `hook.js` 中 `rewritten === command` 的拒绝条件。
2. 增加“已有授权参数、清理后再注入、最终文本不变仍允许”的单元测试。
3. 增加 Windows `cmd` + `--measures-json` + 绝对 CLI 路径的回归测试。
4. 保留 Agent 侧“不要手写授权参数”的约束。
5. 修复后再由用户手动执行端到端验证。

## 10. Agent Skill 约束补充

本次会话暴露出 Agent 可能把授权参数直接写入 QDM Shell 命令。建议将以下约束补充到 QwenPaw 插件的 Skill 文档中，而不是写入单独的 `agent.md`：

- Agent 只生成 QDM 查询所需的业务参数。
- Agent 不得添加、复制、保留或修复 `--data-auth`。
- Agent 不得添加、复制、保留或修复 `--auth-blob`。
- Agent 不得添加、复制、保留或修复 `--auth-json`。
- 即使重试失败命令，也不得补写上述授权参数。
- 即使命令示例中包含上述参数，Agent 也只能提取业务参数重新生成查询命令。
- 授权参数由 Shell Hook 根据当前 requester 自动清理、注入和校验。

建议写入 Skill 的规范文本：

```text
QDM Shell 查询只生成业务参数。禁止 Agent 添加、复制、保留或修复
--data-auth、--auth-blob、--auth-json。授权参数由 Shell Hook 根据当前
requester 自动清理、绑定和校验。重试失败命令时仍只能重新生成业务参数，
不得携带或补写授权参数。
```

该 Skill 约束用于降低 Agent 误用授权参数的概率，不能替代 Hook 对重复授权参数和幂等改写结果的兼容处理。
