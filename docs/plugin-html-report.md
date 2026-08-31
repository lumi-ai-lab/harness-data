# Harness Data Codex Plugin 与 html-report

## 产品身份

```text
GitHub 仓库       lumi-ai-lab/harness-data
Marketplace       lumi-ai-lab
Codex Plugin      harness-data
Skill             html-report
MCP Server        html-report
```

`harness-data` 是完整的 Codex Plugin，`html-report` 是其中一个能力，不是另一个 Plugin。Plugin 携带通用数据 Harness 核心、Node 运行时、报告核心和 Setup 脚本；私有 Wiki 由 Setup 下载。

## 安装

从 GitHub 或 Gitee Release 下载公开 Marketplace ZIP 后本地注册：

```bash
unzip harness-data-codex-marketplace-vX.Y.Z.zip
codex plugin marketplace add "$PWD/harness-data-codex-marketplace"
codex plugin add harness-data@lumi-ai-lab
```

安装完成后，在 Codex 的 Plugin cache 中找到当前版本的 `scripts/setup.mjs` 并执行一次。典型路径为：

```text
$CODEX_HOME/plugins/cache/lumi-ai-lab/harness-data/<version>/scripts/setup.mjs
```

Setup 不是 Marketplace 安装步骤的一部分；它负责把当前 Plugin 变成可运行实例。

## Setup

最小交互式调用：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs"
```

带工作目录和授权材料的非交互调用：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs" \
  --workspace-allowlist "$PWD" \
  --auth-blob-file "$HOME/.config/qdm/auth.blob" \
  --auth-user-id "your-user-id" \
  --gitee-token "$GITEE_TOKEN" \
  --github-token "$GITHUB_TOKEN" \
  --release-archive-password "$HARNESS_RELEASE_ARCHIVE_PASSWORD" \
  --json
```

Setup 的 `qdm-metric-cli` 处理规则：

```text
Plugin 内 bootstrap/cli-manifest.json
              │
              v
当前平台 darwin-arm64 / linux-amd64 / windows-amd64 / windows-arm64
              │
              v
Gitee latest: git_pengmd/harness-metric-release
              │ 失败时
              v
GitHub latest: pengmide/qdm-metric-cli
              │
              v
Plugin/runtimes/<platform>/qdm-metric-cli
```

Harness Data 不发布 `qdm-metric-cli`，也不把下载后的二进制写入 Git 仓库。没有本地可执行文件时，Setup 会按需询问 Gitee/GitHub Token 和 ZIP 解压密码；参数和环境变量也都支持。

Setup 还会：

- 下载私有 Wikis ZIP 到 `resources/wikis/`（或 `--wikis-source`）；
- 在 Plugin 内构建 `.harness/index/wikis-index.json` 和 `wikis-runtime-index.json`；
- 写入 `resource-manifest.json`；
- 写入 `config/settings.json`、`config/harness-config.yaml` 和 `config/workspace-policy.json`；
- 用户级默认关闭本插件，并在 `--workspace-allowlist` 指定的项目写入 `.codex/config.toml` 启用（目录不存在则创建）；
- 把 `auth.blob` 写入 `secrets/auth.blob`；
- 写入 `context.json` 和 `install-manifest.json`。

索引不预打包。Setup 在当前 Plugin 目录执行索引构建，生成文件使用相对资源路径，Plugin 被安装到不同缓存目录后仍可运行。

## 目录职责

```text
$CODEX_HOME/
├── plugins/cache/lumi-ai-lab/harness-data/<version>/
│   ├── .codex-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── mcp/server.mjs
│   ├── scripts/setup.mjs
│   ├── scripts/context-store.mjs
│   ├── skills/html-report/SKILL.md
│   ├── resources/wikis/
│   ├── dist/
│   ├── context.json
│   ├── config/
│   ├── secrets/auth.blob
│   ├── runtimes/<platform>/qdm-metric-cli
│   └── .harness/index/
└── qdm-harness/data/state/workspaces/<workspace-hash>/
    ├── business-report/
    └── html-report/<session-hash>/
```

| 内容 | 所在位置 | 生命周期 |
| --- | --- | --- |
| Plugin 代码、Skill、MCP、Wiki | Plugin 目录 | 随 Plugin 版本 |
| Setup 配置和 Root Context | Plugin 目录 | 由 Setup 管理 |
| 授权文件和 `qdm-metric-cli` | Plugin 目录 | 由 Setup 管理 |
| 普通 Harness Hook 状态 | `dataRoot/state/.../business-report` | 跨会话保留 |
| html-report Pipeline 状态 | `dataRoot/state/.../html-report` | 按 workspace/session 隔离 |
| 最终 Markdown | `workspaceRoot/analysis/main.md` | 用户项目文件 |
| 可选 HTML | `workspaceRoot/analysis/main.html` | 明确确认后生成 |

## 按项目启用

插件全局安装一次。Setup 将用户级默认关闭，只在指定项目启用：

```text
~/.codex/config.toml                          项目/.codex/config.toml
  enabled = false                               enabled = true
```

`--workspace-allowlist` 可重复，目录不存在则创建，并把该项目标为 trusted。同一份目录仍写入 `config/workspace-policy.json`，Hook 和 MCP 会再校验一次。未启用的目录不会得到 Harness Context，不会创建报告 session，不会启动 `qdm-metric-cli` UI，也不会写入工作区报告。修改配置后必须开新会话。

## html-report 流程

```text
A_CONFIG
  用户在 qdm-metric-cli UI 中编辑卡片并点击保存
      │ 用户回复“继续”
      v
B0_PREFLIGHT
  校验 result.json 和 qdm-metric-cli；通过后关闭 UI
      v
B2_WRITER
  逐卡取数、生成 evidence、提交 caption
      v
B2_MAIN
  compose-main 生成 session 内 analysis/main.md
  发布到 workspaceRoot/analysis/main.md
      v
等待用户决定是否生成 HTML
      │ 明确同意
      v
workspaceRoot/analysis/main.html
```

### MCP 工具

| 工具 | 作用 |
| --- | --- |
| `html_report_start` | 创建外部 state session，并打开 `qdm-metric-cli` UI |
| `html_report_next` | 执行 B0、逐卡取数，或在所有卡完成后生成 Markdown |
| `html_report_close_ui` | 关闭 UI，不删除 session 状态 |
| `html_report_submit_writer` | 校验证据并写当前卡片的 caption |
| `html_report_generate_html` | 用户明确确认后生成同级 HTML |
| `html_report_status` | 读取当前 stage、进度和 HTML 状态 |

### HTML 确认

B2_MAIN 完成后，MCP 返回 `html: "awaiting_confirmation"`。Skill 必须先询问：

> 初版 `analysis/main.md` 已生成。是否生成同级 `analysis/main.html`？

只有用户明确同意后，才调用：

```json
{
  "sessionId": "<session-id>",
  "confirmation": "生成 HTML"
}
```

MCP 会拒绝缺少该确认值的调用，不接受模型自定义输出路径，也不会自动调用 `md2html`。用户拒绝时，保留 `main.md`，不创建 `main.html`。

## Hook 行为

Plugin 注册三个 Codex Hook：

- `UserPromptSubmit`：命中 Harness 计划时读取 Plugin 内 Wiki；普通无关问题保持 no-op；
- `PreToolUse`：只对受控 QDM 命令注入授权，不把授权来源泄漏给普通 Bash；
- `PostToolUse`：在允许的工作区内处理模板注入和普通状态更新。

Hook 不从 Plugin cache 的当前目录猜测业务工作区。Codex 提供的 `cwd`、`HARNESS_WORKSPACE_ROOT` 或 `CODEX_WORKSPACE_ROOT` 会经过规范化和白名单校验。

## 开发验证

```bash
node plugins/harness-data/scripts/bundle-dist.mjs \
  --output-dir plugins/harness-data/dist
node scripts/build-codex-marketplace.mjs verify --repo-root "$PWD"
node --test scripts/build-codex-marketplace.test.mjs
node --test plugins/harness-data/mcp/server.test.mjs
node --test plugins/harness-data/test/clean-room-setup.test.mjs
```

Codex 开发环境初始化：

```bash
make plugin init codex dev
```

该命令在开发机生成 `dist`、注册本地仓库 Marketplace、安装 `harness-data@lumi-ai-lab` 并执行 Setup。系统 Codex `auth.json` 只用于开发环境复用登录状态，Plugin 不管理 Codex 登录状态。

## 发布边界

主仓库的 Git tag 是 Plugin 的版本发布边界。Git 提交源码，Release 上传：

```text
harness-data-codex-marketplace-vX.Y.Z.zip   公开，含 dist，不含 Wikis
harness-data-wikis-vX.Y.Z.zip               加密私有 Wiki
```

Setup 生成的 `context.json`、`config/`、`secrets/`、`runtimes/`、`.harness/`、`resource-manifest.json`、`install-manifest.json` 以及 `resources/wikis/`、`dist/` 不应提交。
