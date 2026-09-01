# Harness Data

Harness Data 是一个由 Agent Plugin 提供的 QDM 数据能力。当前正式的 Codex 分发身份如下：

| 层级 | 名称 |
| --- | --- |
| GitHub 仓库 | `lumi-ai-lab/harness-data` |
| Codex Marketplace | `lumi-ai-lab` |
| Codex Plugin | `harness-data` |
| Skill | `html-report` |
| MCP Server | `html-report` |

Plugin 内同时包含通用核心、Codex 适配层、Setup 脚本和 html-report 流程。私有 Wiki 不进入公开仓，由 Setup 下载加密 ZIP。当前用户安装入口是 Codex Plugin。

运行时核心同时提供 ChatGPT Desktop 的 `ChatGPTDesktopAdapter`。Desktop 的
普通 Chat/Work 使用 `surface = "chat"` 或 `"work"` 复用同一套 MCP 工具，
不依赖 Codex Hooks；原生 stdio 不可用时可使用本机 loopback Bridge。

## Codex 安装

先从 GitHub 或 Gitee Release 手动下载公开的 Marketplace ZIP（含 `dist`，不含 Wikis）：

```text
harness-data-codex-marketplace-vX.Y.Z.zip
```

Gitee 由现有同步程序从 GitHub Release 镜像。解压后必须是 Marketplace 根目录：

```text
harness-data-codex-marketplace/
├── .agents/plugins/marketplace.json
└── plugins/harness-data/
    ├── dist/
    └── scripts/setup.mjs
```

然后：

```bash
unzip harness-data-codex-marketplace-vX.Y.Z.zip
codex plugin marketplace add "$PWD/harness-data-codex-marketplace"
codex plugin add harness-data@lumi-ai-lab
```

安装 Plugin 后必须执行一次 Setup。典型的 Plugin 安装目录是：

```text
$CODEX_HOME/plugins/cache/lumi-ai-lab/harness-data/<version>/
```

实际路径以 Codex 的安装结果为准。可以在该目录执行：

```bash
node "$CODEX_HOME/plugins/cache/lumi-ai-lab/harness-data/<version>/scripts/setup.mjs"
```

Setup 会完成以下工作：

1. 根据当前平台解析并下载最新的 `qdm-metric-cli`；
2. 优先访问 Gitee Release `git_pengmd/harness-metric-release`，失败后回退 GitHub Release `pengmide/qdm-metric-cli`；
3. 下载私有 `harness-data-wikis-vX.Y.Z.zip`（Gitee 优先，GitHub 回退），解压到 Plugin `resources/wikis/`；
4. 在 Plugin 内生成 Wiki 索引和资源清单；
5. 写入 QDM 授权材料、配置，并按 `--workspace-allowlist` 启用指定项目；
6. 写入 Plugin Root Context，供 Hook 和 MCP 使用。

支持的平台为 `darwin-arm64`、`linux-amd64`、`windows-amd64` 和 `windows-arm64`。

### Setup 参数

带授权的交互式 Setup：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs"
```

也可以通过参数或环境变量提供所有材料：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs" \
  --workspace-allowlist "$PWD" \
  --auth-blob-file "$HOME/.config/qdm/auth.blob" \
  --auth-user-id "your-user-id"
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--workspace-allowlist PATH` | 启用本插件的项目目录，可重复传入；目录不存在时会创建 |
| `--metric-cli PATH` | 使用已有的 `qdm-metric-cli`，跳过下载 |
| `--gitee-token TOKEN` | Gitee Release API 或附件需要授权时使用 |
| `--github-token TOKEN` | GitHub Release API 或附件需要授权时使用 |
| `--release-archive-password VALUE` | 加密的 `qdm-metric-cli` ZIP 解压密码 |
| `--auth-blob BLOB` | 直接传入 `qdm1enc...` 授权内容 |
| `--auth-blob-file PATH` | 从文件读取授权内容，文件权限要求为 `0600` |
| `--auth-user-id ID` | 当前授权主体标识 |
| `--no-auth` | 明确关闭 QDM 命令授权 |
| `--json` | 输出机器可读的 Setup 报告 |

对应的环境变量为 `GITEE_TOKEN`、`GITHUB_TOKEN`、`HARNESS_RELEASE_ARCHIVE_PASSWORD`、`HARNESS_AUTH_BLOB`、`HARNESS_AUTH_BLOB_FILE`、`HARNESS_AUTH_USER_ID`。Setup 没有收到凭据时会在交互终端中私密询问；非交互执行应显式提供参数或环境变量。

`qdm-metric-cli` 不由 Harness Data 仓库发布。它始终从自己的 Release 中按当前 CPU 和操作系统选择附件，并安装到当前 Plugin 的 `runtimes/<platform>/`。

## 安装后的目录结构

Setup 允许修改已安装的 Plugin 目录。下面是 Codex 的典型布局：

```text
$CODEX_HOME/
├── plugins/
│   └── cache/
│       └── lumi-ai-lab/
│           └── harness-data/
│               └── <version>/                    ← Plugin Root
│                   ├── .codex-plugin/
│                   │   └── plugin.json            ← Codex Plugin 身份
│                   ├── .mcp.json                   ← html-report MCP 声明
│                   ├── hooks/
│                   │   └── hooks.json              ← UserPromptSubmit / PreToolUse / PostToolUse
│                   ├── mcp/                        ← MCP Server 和上下文解析
│                   ├── scripts/
│                   │   ├── setup.mjs               ← 一次性初始化入口
│                   │   ├── context-store.mjs       ← Plugin 内 Root Context
│                   │   └── data-harness-cli        ← Hook 使用的 CLI 入口
│                   ├── skills/
│                   │   └── html-report/SKILL.md
│                   ├── resources/
│                   │   └── wikis/                   ← Setup 下载的私有 Wiki，运行时直接读取
│                   ├── dist/                        ← Marketplace ZIP 中的核心代码快照
│                   │   ├── data-harness-cli/
│                   │   ├── harness-runtime-node/
│                   │   ├── html-report-kernel/
│                   │   └── harness-data-installer/
│                   ├── bootstrap/
│                   │   └── cli-manifest.json        ← 外部 metric-cli 下载目录
│                   ├── context.json                 ← Setup 生成
│                   ├── config/
│                   │   ├── settings.json            ← Setup 生成
│                   │   ├── harness-config.yaml      ← Setup 生成
│                   │   └── workspace-policy.json    ← Setup 生成
│                   ├── secrets/
│                   │   └── auth.blob                ← Setup 生成，权限 0600
│                   ├── runtimes/
│                   │   └── <platform>/
│                   │       └── qdm-metric-cli       ← Setup 下载或复制
│                   ├── .harness/
│                   │   └── index/                   ← Setup 生成的 Wiki 索引
│                   │       ├── wikis-index.json
│                   │       └── wikis-runtime-index.json
│                   ├── resource-manifest.json       ← Setup 生成
│                   └── install-manifest.json        ← Setup 生成
└── qdm-harness/
    └── data/                                        ← 外部 dataRoot
        └── state/
            └── workspaces/<workspace-hash>/        ← 只保存运行态
                ├── business-report/                ← 普通 Harness 状态
                ├── html-report/<session-hash>/     ← html-report Pipeline 状态
                └── diagnostics/                    ← 仅在启用诊断时使用
```

职责边界如下：

```text
Plugin Root
├── 代码、Skill、MCP、Wiki                       产品资源（Wiki 由 Setup 填入）
├── context.json、config、secret、metric-cli     Setup 管理的本地内容
└── .harness/index、manifest                    Setup 生成的本地索引和记录

外部 dataRoot
└── state/workspaces/<workspace-hash>            普通 Hook / 报告 Pipeline 运行态

workspaceRoot
└── analysis/main.md                             最终 Markdown 报告
    analysis/main.html                          用户明确确认后才生成
```

`dataRoot` 在首次 Setup 时只创建根目录；普通 Hook 不会因为无关问题创建项目内 `.harness`。普通 Harness 状态和 html-report 状态都不写入 Plugin，也不写入项目的隐藏目录。

## 按项目启用

插件只全局安装一次。Setup 用 Codex 原生的配置分层代替“全局开启 + 自建白名单”：

```text
~/.codex/config.toml
  [plugins."harness-data@lumi-ai-lab"]
  enabled = false                 ← 默认不加载 Skill / Hook / MCP
        │
        │  setup --workspace-allowlist /proj-a --workspace-allowlist /proj-b
        ▼
/proj-a/.codex/config.toml        /proj-b/.codex/config.toml
  enabled = true                    enabled = true
        │
        ▼
只有这些 trusted 项目的新会话会加载插件
```

`--workspace-allowlist` 可重复。目录不存在时 Setup 会创建它，并同时：

1. 把该项目标为 `trust_level = "trusted"`（项目级 `.codex/` 配置才会被加载）；
2. 写入 `<project>/.codex/config.toml` 启用本插件；
3. 把同一份目录列表同步到 Plugin 内的 `config/workspace-policy.json`，供 Hook / MCP 二次校验。

`codex plugin list` 仍显示用户级 `disabled`，不能用来判断项目里是否已启用。修改配置后必须开新会话。项目必须处于 trusted 状态，否则项目配置层可能不会生效。

## html-report 流程

安装并 Setup 完成后，在 Codex 中触发 `$html-report`。流程为：

```text
A_CONFIG
  ↓ 在 qdm-metric-cli UI 中搭卡并点击保存
B0_PREFLIGHT
  ↓ 用户回复“继续”后校验 result.json，关闭 UI
B2_WRITER
  ↓ 逐卡取数、生成 evidence、提交 caption
B2_MAIN
  ↓ compose-main 生成 workspaceRoot/analysis/main.md
等待用户决定是否生成 HTML
  ↓ 仅在用户明确同意后
workspaceRoot/analysis/main.html
```

最终 Markdown 固定写入：

```text
<workspaceRoot>/analysis/main.md
```

HTML 不是自动生成的。只有用户明确同意后，模型才可以调用：

```json
{
  "sessionId": "<session-id>",
  "confirmation": "生成 HTML"
}
```

MCP 提供以下工具：

| 工具 | 作用 |
| --- | --- |
| `html_report_start` | 创建外部 state session，打开 `qdm-metric-cli` UI |
| `html_report_next` | 执行 B0、逐卡取数或生成 `main.md` |
| `html_report_close_ui` | 关闭 UI，不删除 session 数据 |
| `html_report_submit_writer` | 校验证据并写入当前卡片 caption |
| `html_report_generate_html` | 用户确认后生成同级 `main.html` |
| `html_report_status` | 查看 stage、卡片进度和 HTML 状态 |

完整流程说明见 [`docs/plugin-html-report.md`](docs/plugin-html-report.md)、
[`docs/host-adapters.md`](docs/host-adapters.md) 和
[`plugins/harness-data/skills/html-report/SKILL.md`](plugins/harness-data/skills/html-report/SKILL.md)。

## 本地开发初始化

当前工作树可以用一个命令初始化隔离的 Codex 开发环境：

```bash
make plugin init codex dev
```

开发脚本会：

1. 重置 `/tmp/codex-home/dev-harness-plugin` 和 `/tmp/codex-dev-harness-plugin`；
2. 将当前仓库注册为 Codex Marketplace；
3. 安装 `harness-data@lumi-ai-lab`；
4. 使用本地 `qdm-metric-cli`（若不存在则走下载路径）；
5. 交互式获取或读取开发用 `auth.blob` 和用户标识；
6. 执行 Plugin Setup，并检查 Hook、MCP 和索引。

脚本启动 Codex 时会同时设置 `HARNESS_WORKSPACE_ROOT`、`CODEX_WORKSPACE_ROOT` 和 `PWD`。这是因为 MCP 的启动目录是 Plugin cache，单独依赖操作系统工作目录可能导致 MCP 无法识别当前项目。

可通过环境变量覆盖开发默认值：

```bash
QDM_CODEX_AUTH_SOURCE="$HOME/.codex/auth.json" \
QDM_METRIC_CLI="/path/to/qdm-metric-cli" \
QDM_SECRET_SOURCE="/path/to/auth.blob" \
QDM_AUTH_USER_ID="your-user-id" \
QDM_PLUGIN_DEV_NO_LAUNCH=1 \
make plugin init codex dev
```

系统 Codex `auth.json` 仅用于开发初始化复用登录状态；Plugin Setup 不管理 Codex 登录状态。

## 发布模型

Harness Data 的用户安装源是 GitHub/Gitee Release 上的 Marketplace ZIP：

```text
Git tag
  ↓
harness-data-codex-marketplace-vX.Y.Z.zip
  ↓
解压后本地 marketplace add
  ↓
Setup 再下载 harness-data-wikis-vX.Y.Z.zip 和 qdm-metric-cli
```

当前不单独发布以下用户产物：

- Marketplace Git 仓库；
- Harness Data runtime ZIP；
- GHCR 容器镜像；
- 通用 host artifact；
- 独立 npm 安装包。

`qdm-metric-cli` 仍由独立仓库发布，Harness Data Setup 只负责在安装 Plugin 后按平台动态下载。私有 Wiki 随 `harness-data-wikis-vX.Y.Z.zip` 发布，Setup 解压到当前 Plugin 后重建索引。

发布前应更新 `plugins/harness-data/.codex-plugin/plugin.json` 和内部 Setup 元数据中的版本，创建符合 `vMAJOR.MINOR.PATCH` 的 Git tag。发版工作流上传公开 `harness-data-codex-marketplace-vX.Y.Z.zip` 和加密 `harness-data-wikis-vX.Y.Z.zip`。Gitee 由现有同步程序从 GitHub Release 镜像。

## 核心开发检查

重新生成 Plugin bundle：

```bash
node plugins/harness-data/scripts/bundle-dist.mjs \
  --output-dir plugins/harness-data/dist
```

验证 Marketplace 和 Plugin 源目录：

```bash
node scripts/build-codex-marketplace.mjs \
  verify --repo-root "$PWD" --version 0.0.55
node --test scripts/build-codex-marketplace.test.mjs
```

运行关键测试：

```bash
npm --prefix npm test -- --test-concurrency=1
node --test packages/data-harness-cli/test/*.test.js
node --test packages/harness-runtime-node/src/*.test.mjs
node --test plugins/harness-data/mcp/server.test.mjs
node --test plugins/harness-data/test/clean-room-setup.test.mjs
```

旧本地 runtime 的迁移实现仍作为内部数据迁移兼容路径保留，但不属于新用户安装入口。`npm/src` 目录也保留为 Plugin 内部 bundled installer 的源码，不代表独立 npm 分发渠道。

## 安全边界

- `auth.blob` 只接受加密的 `qdm1enc...` 内容；Harness 不解密；
- Setup 接受交互输入、参数和环境变量，写入 Plugin 内 `secrets/auth.blob` 时使用 `0600`；
- GitHub/Gitee token 只用于 Setup 的 Release 查询和下载，不写入 Plugin manifest、工作区状态或 remote URL；
- Hook 会清理普通命令继承的授权来源环境变量；
- 不允许的 workspace 不创建 session、不写状态、不启动数据 UI；
- `analysis/main.md` 生成后，HTML 必须等待用户明确确认；
- Plugin 源目录不应包含 Setup 生成的 `context.json`、secret、runtime binary、index 或 install manifest。

Root Context 和安全约束见：

- [`docs/root-context-v1.md`](docs/root-context-v1.md)
- [`docs/root-context-threat-model.md`](docs/root-context-threat-model.md)
- [`docs/codex-plugin-layout.md`](docs/codex-plugin-layout.md)
