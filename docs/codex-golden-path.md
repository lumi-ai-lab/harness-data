# Codex Plugin Golden Path

> 当前方案记录：2026-08-31

本文记录 Harness Data 在 Codex 中的正式安装、Setup、运行和验证路径。目录职责的完整树形说明见 [`codex-plugin-layout.md`](codex-plugin-layout.md)。

## 产品身份

```text
GitHub 仓库       lumi-ai-lab/harness-data
Marketplace       lumi-ai-lab
Plugin            harness-data
Skill             html-report
MCP Server        html-report
```

用户下载公开 Marketplace ZIP（含 `dist`，不含 Wikis），解压后本地注册：

```bash
unzip harness-data-codex-marketplace-vX.Y.Z.zip
codex plugin marketplace add "$PWD/harness-data-codex-marketplace"
codex plugin add harness-data@lumi-ai-lab
```

Gitee Release 由现有同步程序从 GitHub Release 镜像。Plugin 版本与 Git tag 一致。

## Setup Golden Path

安装 Plugin 后，在 Codex Plugin cache 的当前版本目录执行：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs" \
  --workspace-allowlist "$PWD" \
  --auth-blob-file "$HOME/.config/qdm/auth.blob" \
  --auth-user-id "your-user-id"
```

`$PLUGIN_ROOT` 的典型值为：

```text
$CODEX_HOME/plugins/cache/lumi-ai-lab/harness-data/<version>
```

Setup 的职责：

1. 解析当前平台；
2. 下载私有 Wikis ZIP 到 Plugin `resources/wikis/`（或使用 `--wikis-source`）；
3. 没有本地可执行文件时，按 `darwin-arm64`、`linux-amd64`、`windows-amd64` 或 `windows-arm64` 下载 latest `qdm-metric-cli`；
4. Gitee `git_pengmd/harness-metric-release` 优先，GitHub `pengmide/qdm-metric-cli` 回退；
5. 在 Plugin 内生成索引、资源清单、配置、授权引用和 Root Context；
6. 用户级默认关闭本插件，并在 `--workspace-allowlist` 指定的项目中写入 `.codex/config.toml` 启用它。

Gitee/GitHub Token、ZIP 解压密码和 QDM `auth.blob` 都支持交互输入、参数和环境变量。Harness Data 不发布 `qdm-metric-cli`，也不复制 Wiki 到外部 dataRoot。

## Root Context

Codex Plugin 使用以下根：

| 根 | 用途 | 位置 |
| --- | --- | --- |
| `pluginRoot` | Plugin 代码、Setup 填入的 Wiki、Setup 管理文件 | Codex Plugin cache |
| `resourceRoot` | Wiki 和索引 | 等于 `pluginRoot` |
| `dataRoot` | 外部运行态根 | 默认 `$CODEX_HOME/qdm-harness/data` |
| `secretRoot` | `auth.blob` | 默认 `<pluginRoot>/secrets` |
| `workspaceRoot` | 当前用户项目 | 由 Codex Hook/MCP 提供 |
| `stateRoot` | 当前 workspace 的状态 | `dataRoot/state/workspaces/<hash>` |

Setup 后的关键文件：

```text
<pluginRoot>/
├── context.json
├── config/settings.json
├── config/harness-config.yaml
├── config/workspace-policy.json
├── secrets/auth.blob
├── runtimes/<platform>/qdm-metric-cli
├── .harness/index/wikis-index.json
├── .harness/index/wikis-runtime-index.json
├── resource-manifest.json
└── install-manifest.json
```

`dataRoot` 首次只创建外部根；普通 Harness 和 html-report 状态写入：

```text
<dataRoot>/state/workspaces/<workspace-hash>/
├── business-report/
├── html-report/<session-hash>/
└── diagnostics/
```

## 按项目启用

Setup 把 `--workspace-allowlist PATH`（可重复，目录不存在则创建）写成 Codex 的项目级启用：

```text
$USER Codex Home
  config.toml
    [plugins."harness-data@lumi-ai-lab"] enabled = false
    [projects."/proj"] trust_level = "trusted"

/proj/.codex/config.toml
    [plugins."harness-data@lumi-ai-lab"] enabled = true
```

同一份目录列表仍写入 `config/workspace-policy.json`，Hook 和 MCP 会再校验一次：

```text
Codex 项目配置 ─> 未启用则不加载插件
                     │
UserPromptSubmit ─┐  ▼
PreToolUse        ├─> workspace-policy.json ─> allow / no-op / deny
PostToolUse       │
MCP               ┘
```

未启用或未列入的工作目录：

- 不加载 Skill / Hook / MCP（用户级默认关闭时）；
- 不注入 Harness Context；
- 不创建普通或报告 session；
- 不启动 `qdm-metric-cli` UI；
- 不写入工作区报告。

路径比较先执行 `realpath`，再使用目录关系判断，避免 `/project` 错误匹配 `/project-evil`。修改配置后必须开新会话；`codex plugin list` 只反映用户级状态。

## html-report 验收路径

```text
A_CONFIG
  └─ qdm-metric-cli UI 中搭卡并点击保存
      ↓ 用户回复“继续”
B0_PREFLIGHT
  └─ 校验 result.json 和 metric CLI，关闭 UI
      ↓
B2_WRITER
  └─ 逐卡取数、生成证据、提交 caption
      ↓
B2_MAIN
  └─ 生成 workspaceRoot/analysis/main.md
      ↓
用户明确决定是否生成 HTML
      ↓ 明确同意
workspaceRoot/analysis/main.html
```

必须满足的输出约定：

```text
workspaceRoot/analysis/main.md       # 固定最终 Markdown 路径
workspaceRoot/analysis/main.html     # 不自动生成
```

`html_report_generate_html` 必须在 B2_MAIN 完成后调用，并传入：

```json
{
  "sessionId": "<session-id>",
  "confirmation": "生成 HTML"
}
```

缺少确认值时 MCP 拒绝调用。MCP 不接受模型传入的输出路径。

## 验证矩阵

| 场景 | 自动化证据 |
| --- | --- |
| Marketplace 名称、Plugin 名称和源路径 | `scripts/build-codex-marketplace.test.mjs` |
| Marketplace ZIP 含 dist、不含 Wikis | `scripts/build-codex-marketplace.test.mjs` |
| Setup 下载或复制 Wikis 到 Plugin | `npm/test/setup.test.js` |
| Setup 写入 Plugin、不写项目状态 | `plugins/harness-data/test/clean-room-setup.test.mjs` |
| 多 workspace 白名单和状态隔离 | `plugins/harness-data/test/clean-room-setup.test.mjs`、MCP 测试 |
| MCP 未授权 workspace 阻断 | `plugins/harness-data/mcp/server.test.mjs` |
| Markdown 发布和 HTML 确认 | `plugins/harness-data/mcp/server.test.mjs` |
| Root Context 规范化和状态根 | `packages/data-harness-cli/test/root-context.test.js`、`packages/harness-runtime-node/src/root-context.test.mjs` |
| latest metric CLI 解析 | `npm/test/setup.test.js`、`npm/test/cli.test.js` |
| 旧 runtime 数据迁移兼容 | `npm/test/migrate.test.js` |

## 开发初始化

```bash
make plugin init codex dev
```

开发脚本会注册当前主仓库、安装 `harness-data@lumi-ai-lab`、执行 Plugin Setup，并完成 Hook、MCP 和索引自检。启动 Codex 时，脚本会显式传递 `HARNESS_WORKSPACE_ROOT`、`CODEX_WORKSPACE_ROOT` 和 `PWD`，避免 MCP 进程以 Plugin cache 作为当前工作目录。系统 Codex `auth.json` 仅用于隔离开发环境复用登录状态，正式 Plugin 不管理 Codex 登录状态。

## 发布边界

主仓库 Git tag 是 Codex Plugin 的版本边界。Git 提交源码；Release 上传公开 Marketplace ZIP（含 `dist`）和加密 Wikis ZIP。Setup 生成的配置、secret、runtime binary、索引和状态不提交。

当前不作为 Harness Data 用户渠道发布：

- 独立 Marketplace 仓库；
- Harness Data runtime ZIP；
- GHCR 容器镜像；
- 通用 host artifact；
- 独立 npm 安装包。

旧本地 runtime 的迁移代码只用于内部数据迁移，不改变新的 Plugin-first 安装路径。
