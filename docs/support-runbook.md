# Harness Data 支持运行手册

> 当前产品路径：Codex Plugin `harness-data@lumi-ai-lab`。更新日期：2026-08-31。

本文用于处理 Plugin 安装、Setup、Root Context、按项目启用、授权和报告状态问题。完整目录见 [`codex-plugin-layout.md`](codex-plugin-layout.md)。

## 1. 安装和 Setup

用户先下载并解压公开 Marketplace ZIP，再安装 Plugin：

```bash
unzip harness-data-codex-marketplace-vX.Y.Z.zip
codex plugin marketplace add "$PWD/harness-data-codex-marketplace"
codex plugin add harness-data@lumi-ai-lab
```

再在安装后的 Plugin Root 执行：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs" \
  --workspace-allowlist "$PWD" \
  --auth-blob-file "$HOME/.config/qdm/auth.blob" \
  --auth-user-id "your-user-id"
```

Setup 没有本地 `qdm-metric-cli` 时，会按当前平台从 Gitee latest 回退到 GitHub latest。Gitee Token、GitHub Token、ZIP 解压密码和 QDM `auth.blob` 都支持交互输入、参数和环境变量。

## 2. 最小诊断

从当前 Plugin Root 执行：

```bash
node "$PLUGIN_ROOT/scripts/data-harness-cli" \
  --plugin-root "$PLUGIN_ROOT" \
  --data-root "${HARNESS_DATA_ROOT:-$CODEX_HOME/qdm-harness/data}" \
  paths --json
```

Setup 生成的 `context.json` 也可用于诊断：

```bash
node "$PLUGIN_ROOT/scripts/data-harness-cli" \
  --context-file "$PLUGIN_ROOT/context.json" \
  paths --json
```

诊断输出可以包含 Plugin、resource、data、secret、workspace、state 根、版本和 secret 类型；不得包含 auth blob 内容、Token 或完整用户 prompt。

## 3. 错误码

| 错误码 | 含义 | 处理方式 |
| --- | --- | --- |
| `QDM_CONTEXT_INVALID` | Root Context 格式、路径或根关系无效 | 重新执行 Setup，检查绝对路径和 realpath |
| `QDM_PLUGIN_ROOT_UNAVAILABLE` | Plugin Root 不存在 | 在 Codex 中重新安装 `harness-data@lumi-ai-lab` |
| `QDM_DATA_ROOT_UNAVAILABLE` | 外部 dataRoot 不可用 | 检查 `CODEX_HOME/qdm-harness/data` 或显式 `HARNESS_DATA_ROOT` 的权限 |
| `QDM_WORKSPACE_REQUIRED` | 操作缺少有效工作目录 | 从目标项目重新启动 Codex，或提供 workspace root |
| `QDM_WORKSPACE_NOT_ALLOWED` | 工作目录未启用本插件 | 用 Setup 重写 `--workspace-allowlist`，确认项目 `.codex/config.toml` 已启用且目录已 trusted |
| `QDM_STATE_LOCKED` | 同一 session 正在写入 | 等待活动操作结束，再清理确认过期的锁 |
| `QDM_RESOURCE_MISMATCH` | Wiki、索引和资源清单不一致 | 在当前 Plugin Root 重新执行 Setup，不能手工改索引 |
| `QDM_SECRET_UNAVAILABLE` | `auth.blob` 缺失、权限错误或格式无效 | 使用有效的 `qdm1enc...` 文件并设置 `0600` |
| `QDM_SETUP_REQUIRED` | Plugin 尚未完成 Setup | 执行安装后的 `scripts/setup.mjs` |
| `QDM_MIGRATION_REQUIRED` | 检测到旧本地 runtime 数据 | 仅在需要保留旧数据时执行内部迁移检查 |

## 4. 目录和写入边界

```text
Plugin Root
├── 代码、Skill、MCP、Setup 填入的 Wiki
├── Setup 生成的 context/config/secrets/runtimes/index
└── 不保存普通跨 workspace 状态

$CODEX_HOME/qdm-harness/data/state/workspaces/<hash>
├── business-report/
├── html-report/<session-hash>/
└── diagnostics/

workspaceRoot/analysis/
├── main.md       ← 固定最终 Markdown
└── main.html     ← 明确确认后才生成
```

普通无关 prompt 不创建状态。未授权 workspace 不注入上下文、不创建 session、不启动 `qdm-metric-cli` UI，也不写入 `analysis/`。

## 5. 授权排查

检查以下内容，不打印文件内容：

1. `Plugin/secrets/auth.blob` 是 regular file；
2. Unix 权限为 `0600`；
3. 内容以 `qdm1enc.` 开头；
4. `config/settings.json` 中存在 auth 用户标识；
5. `config/harness-config.yaml` 的 `authz.mode` 与用户意图一致；
6. 用户级 `config.toml` 中本插件为 `enabled = false`，当前项目 `.codex/config.toml` 为 `enabled = true`，且 `config/workspace-policy.json` 包含当前 workspace 的真实路径；
7. `runtimes/<platform>/qdm-metric-cli` 存在且可执行。

Token 和 ZIP 密码只用于 Setup 的网络下载过程，不应写入普通状态、Marketplace manifest 或项目文件。

## 6. 报告排查

报告状态应位于：

```text
<dataRoot>/state/workspaces/<workspace-hash>/html-report/<session-hash>/
```

最终 Markdown 应位于：

```text
<workspaceRoot>/analysis/main.md
```

如果 `main.md` 已生成但没有 `main.html`，这是正常状态。只有用户明确同意生成 HTML，并通过 `confirmation: "生成 HTML"` 调用 MCP，才会创建同级 `main.html`。

如果 workspace 不在白名单，先修复白名单，再重新启动报告；不要手工复制 session 目录或在项目中创建隐藏状态目录。

## 7. 旧数据迁移

旧本地 runtime 迁移是内部兼容路径，不是新用户安装流程。迁移应先只读检查，再写入新的外部 state/data 结构；源目录必须保持不变：

```text
qdm-harness migrate --check --from <old-runtime> --to <data-root> --workspace-root <workspace>
qdm-harness migrate --from <old-runtime> --to <data-root> --workspace-root <workspace>
```

迁移完成后，配置、迁移记录和 metric CLI 路径必须按迁移后的 dataRoot 显式检查。新 Plugin 的安装不依赖旧 runtime、Wiki checkout 或独立资源包。

## 8. 支持记录模板

```text
日期：
Codex 版本：
Plugin 版本：
Plugin Root（可脱敏）：
dataRoot/stateRoot：
workspaceRoot 是否在白名单：
secret 类型和状态（不填内容）：
命令和错误码：
是否创建了不应存在的项目文件：
复现步骤：
已执行的修复：
证据文件：
```
