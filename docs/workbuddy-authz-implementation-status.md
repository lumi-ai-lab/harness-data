# Windows WorkBuddy 鉴权实施状态

## 当前结论

`feat/windows-workbuddy-auth` 已完成仓库侧修复和 fix2 真实客户端回归。**Windows WorkBuddy 5.3.8+ 的第一阶段 Local Blob 鉴权已达到生产发布条件**。

第一阶段 Spy CLI 已在真实 WorkBuddy 5.3.8 中验证 `updatedInput` 替换和 deny 零副作用。随后真实 QDM 命令回归的第四、第五步发现三项问题：

1. 部分 PowerShell sandbox 路径丢失命令 stdout/stderr，只向会话返回 `Command completed with exit code 0`。
2. WorkBuddy 自动重试产生的 `$out = & ... 2>&1` 赋值命令未被分类器识别，Go hook 返回空对象，继而被 adapter 判为非法响应。
3. 直接写入 `updatedInput.command` 的完整 `qdm1enc...` blob 被 WorkBuddy 持久化到会话 JSONL。

进一步检查真实客户端日志和 WorkBuddy 代码后确认：WorkBuddy 5.3.8 的 PowerShell 工具固定经过 sandbox + ConPTY，宿主只返回 exit code，不返回 stdout/stderr；内存输出包装无法跨越该宿主边界。最终实现因此改为：受控 QDM 命令统一使用 Bash tool，PowerShell 在解析授权材料前 fail closed。fix2 已验证 stdout/stderr、broker 替换、deny 零副作用、会话历史无 blob 和 authz-off 回归；npm installer 允许显式 `--agent workbuddy --data-auth`，doctor 将宿主契约报告为通过，并拒绝低于 5.3.8 的客户端。

## 当前执行架构

```text
WorkBuddy Bash tool request
  -> PreToolUse: harness-hook.mjs authz
  -> data-harness-cli authz-hook --agent workbuddy
  -> classify and authorize
  -> updatedInput contains authz-exec broker command only (no blob)
  -> data-harness-cli authz-exec --agent workbuddy -- <allowed qdm args>
  -> broker resolves Local Blob internally
  -> broker starts the real qdm-metric-cli
  -> stdout/stderr/exit code returned to WorkBuddy

WorkBuddy PowerShell gated QDM request
  -> PreToolUse classification
  -> deny before ResolveAuthBlob
  -> QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED
  -> retry once with the Bash tool
```

WorkBuddy 的授权材料不依赖 WorkBuddy 登录身份。第一阶段只接受部署侧显式绑定的 Local Blob 与 userId；不自动继承 WorkBuddy 当前登录用户权限。

## 已落地修复

### 可信执行 broker

- 新增 `data-harness-cli authz-exec --agent workbuddy -- ...`。
- broker 只接受 `auth describe` 和 `analysis execute`，拒绝其他子命令。
- broker 删除模型提供的 `--data-auth`、`--auth-blob`、`--auth-json`，在进程内部解析并注入可信 blob。
- 启动真实 `qdm-metric-cli` 前清除授权来源环境变量。
- `updatedInput.command` 不再包含 blob 或 auth flags；JS adapter 也会拒绝任何泄漏这些内容的 allow 响应。
- 模型不得直接调用 `authz-exec`；它只能由可信 PreToolUse 改写引入。

### WorkBuddy shell 契约

- Windows WorkBuddy 的 `auth describe` 和 `analysis execute` 必须由 Bash tool 发起。
- Bash 分类器支持 `./original/qdm-metric-cli.exe`、`./real/qdm-metric-cli.exe` 等相对子目录入口，并严格要求 basename 为 `qdm-metric-cli` 或 `qdm-metric-cli.exe`。
- WorkBuddy PowerShell 中识别到的受控 QDM 命令固定 deny，错误码为 `QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED`，且不返回 `updatedInput`。
- PowerShell deny 发生在 `ResolveAuthBlob` 前，不读取、不注入授权材料，也不产生命令副作用。
- 不自动设置 `dangerouslyDisableSandbox=true`，不关闭 WorkBuddy sandbox。
- PowerShell parser/rewriter 仍保留给 Codex或未来具备完整输出契约的宿主，但不用于 WorkBuddy 5.3.8 执行。

### WorkBuddy adapter 与诊断

- adapter 保留完整 `tool_input`、session、cwd 和未知字段。
- CLI 缺失、失败、超时、非法 JSON、有损 `updatedInput` 或授权材料泄漏均 fail closed。
- `authz.mode=off`、非 shell tool 和 Harness workspace 外保持 no-op。
- installer 允许 Windows WorkBuddy 5.3.8+ 显式使用 `--agent workbuddy --data-auth`。
- doctor 在 WorkBuddy authz-on 时报告已验证的 host contract，并独立检查最低客户端版本、授权来源、userId、插件包和启用状态。

## 已完成的仓库验证

- `go test .\\cli\\internal\\agentauthz .\\cli\\cmd\\data-harness-cli`：通过。
- `node --test .\\npm\\test\\workbuddy-hook.test.js`：20 项，15 通过，5 跳过，0 失败。
- 临时 Windows `data-harness-cli.exe` 构建：通过。
- 使用真实 authz-on staging workspace 做本地 Bash broker smoke：
  - allow 响应保留 description 和其他字段；
  - `updatedInput` 使用 `authz-exec`；
  - `updatedInput` 不含 `qdm1enc.`、`--auth-blob` 或 `--auth-json`；
  - `auth describe --resolve-labels=false` 返回有效 JSON，且 stdout 不含 blob。

## fix2 真实客户端回归结果

以下项目已在 WorkBuddy 5.3.8 中重跑并通过：

1. Bash tool 执行 `auth describe` 的工具结果包含真实 JSON，而不是只有 exit-code 摘要。
2. PowerShell tool 执行受控 QDM 命令时稳定返回 `QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED`，不执行原命令；按提示改用 Bash 后成功。
3. Bash tool 执行 `analysis execute` 时 stdout/stderr 和退出码正常传递。
4. 新会话 JSONL、工具调用历史和诊断输出均不含完整 `qdm1enc...`、`--auth-blob` 或 `--auth-json`。
5. missing/invalid blob 仍在执行前 deny，且工具零副作用。
6. authz-off 包不改写命令、不调用 broker，无功能回归。

以上项目全部通过后，`workBuddyAuthzHostContractValidated` 已改为 `true`，最低支持版本收紧为实际验证基线 5.3.8，installer/doctor 生产门槛已经解除。详细证据见 [WorkBuddy Windows 鉴权 fix2 回归结果](workbuddy-fix2-regression-result.md)。Windows 默认 Agent、`both` 和 `all` 的既有语义保持不变，WorkBuddy 继续要求显式选择。
