# Codex Plugin 目录布局

本文定义 Harness Data 在 Codex 中的安装目录、Setup 生成内容和运行时写入边界。

## 身份和安装入口

```text
GitHub 仓库:       lumi-ai-lab/harness-data
Marketplace:       lumi-ai-lab
Plugin:            harness-data
Skill:             html-report
MCP Server:        html-report
```

用户从 GitHub 或 Gitee Release 下载公开 Marketplace ZIP，解压后本地注册：

```bash
unzip harness-data-codex-marketplace-vX.Y.Z.zip
codex plugin marketplace add "$PWD/harness-data-codex-marketplace"
codex plugin add harness-data@lumi-ai-lab
```

ZIP 内是 Marketplace 根目录：`.agents/plugins/marketplace.json` 指向 `./plugins/harness-data/`。私有 Wiki 不打进 ZIP，由 Setup 下载。

## 安装后的完整布局

`<version>` 是 Codex Plugin 的版本目录；具体缓存根由 `CODEX_HOME` 决定。下面的路径以默认 Codex Home 为例：

```text
$CODEX_HOME/
├── auth.json                                      ← Codex 自己管理，Harness 不读取或修改
├── plugins/
│   └── cache/
│       └── lumi-ai-lab/
│           └── harness-data/
│               └── <version>/                     ← pluginRoot
│                   ├── .codex-plugin/
│                   │   └── plugin.json             ← Codex 原生 Plugin manifest
│                   ├── .mcp.json                    ← MCP server 声明
│                   ├── hooks/
│                   │   └── hooks.json               ← 三类 Codex Hook
│                   ├── mcp/
│                   │   ├── kernel-loader.mjs
│                   │   ├── runtime-resolver.mjs
│                   │   └── server.mjs                ← html-report MCP
│                   ├── scripts/
│                   │   ├── setup.mjs                 ← Setup 入口
│                   │   ├── context-store.mjs         ← 持久 Root Context
│                   │   ├── setup-codex-hooks.mjs     ← 兼容入口
│                   │   └── data-harness-cli          ← Hook CLI wrapper
│                   ├── skills/
│                   │   └── html-report/SKILL.md
│                   ├── resources/
│                   │   └── wikis/                    ← 唯一一份 Wiki 内容
│                   │       ├── index.md
│                   │       ├── metrics/
│                   │       ├── reports/
│                   │       ├── dims/
│                   │       └── rules/
│                   ├── dist/                         ← Plugin 自带的运行时代码
│                   │   ├── data-harness-cli/
│                   │   ├── harness-runtime-node/
│                   │   ├── html-report-kernel/
│                   │   └── harness-data-installer/
│                   ├── bootstrap/
│                   │   └── cli-manifest.json           ← 外部 qdm-metric-cli 下载清单
│                   │
│                   │   ├── context.json                ← Setup 生成，可写
│                   │   ├── config/                      ← Setup 生成，可写
│                   │   │   ├── settings.json
│                   │   │   ├── harness-config.yaml
│                   │   │   └── workspace-policy.json
│                   │   ├── secrets/                     ← Setup 生成，可写，权限受限
│                   │   │   └── auth.blob
│                   │   ├── runtimes/                    ← Setup 生成，可写
│                   │   │   └── <platform>/
│                   │   │       └── qdm-metric-cli
│                   │   ├── .harness/                    ← Setup 生成，可写
│                   │   │   └── index/
│                   │   │       ├── wikis-index.json
│                   │   │       └── wikis-runtime-index.json
│                   │   ├── resource-manifest.json      ← Setup 生成
│                   │   └── install-manifest.json       ← Setup 生成
│                   │
│                   └── （以上 Setup 管理文件都不进入源码提交）
└── qdm-harness/
    └── data/                                       ← dataRoot，默认在 CODEX_HOME 下
        └── state/
            └── workspaces/
                └── <workspace-hash>/               ← stateRoot
                    ├── business-report/            ← 普通 Harness Hook 状态
                    ├── html-report/                 ← html-report Pipeline 状态
                    │   └── <session-hash>/
                    └── diagnostics/                ← 显式启用诊断后使用
```

`CODEX_HOME/auth.json` 是 Codex 登录文件。`qdm-harness/data` 不是 Codex 登录目录；它只保存 Harness 运行态。

## 各根的职责

| 根或路径 | 内容 | 默认写入者 |
| --- | --- | --- |
| `pluginRoot` | Plugin manifest、Hook、MCP、Skill、核心代码、内置 Wiki | Codex 安装；Setup 写入其管理文件 |
| `resourceRoot` | 当前版本的 `resources/wikis` 和生成索引 | Plugin Root |
| `dataRoot` | Harness 的外部持久根 | Setup 创建根目录；运行时写 `state` |
| `secretRoot` | `secrets/auth.blob` | Setup |
| `stateRoot` | 当前 workspace 的普通状态和报告 session | Hook、MCP、报告流程 |
| `workspaceRoot` | 用户当前项目 | 用户确认后的报告发布流程 |
| `workspaceRoot/analysis/main.md` | 最终 Markdown 报告 | html-report MCP |
| `workspaceRoot/analysis/main.html` | 可选 HTML 导出 | 用户明确确认后由 html-report MCP |

当前实现中，Codex 的 `resourceRoot`、`configPath`、`workspacePolicyPath`、`secretRoot`、`runtimes` 和索引都位于 Plugin 内。`dataRoot` 只承担 `state`，不会复制 Wiki、配置或 `qdm-metric-cli`。

## Setup 写入顺序

```text
scripts/setup.mjs
    │
    ├── 解析 Root Context 和要启用插件的项目目录
    ├── 准备 Plugin/secrets/auth.blob
    ├── 查找本地 qdm-metric-cli
    │     └── 没有时：Gitee latest → GitHub latest
    ├── 将 qdm-metric-cli 写入 Plugin/runtimes/<platform>/
    ├── 下载或复制 Wiki 到 Plugin/resources/wikis/
    ├── 写入 config/harness-config.yaml
    ├── 在 Plugin/.harness/index/ 构建两个 Wiki 索引
    ├── 写入 Plugin/resource-manifest.json
    ├── 写入 Plugin/config/settings.json
    ├── 写入 Plugin/config/workspace-policy.json
    ├── 用户级默认关闭插件，并在指定项目写入 .codex/config.toml 启用
    ├── 写入 Plugin/install-manifest.json
    └── 写入 Plugin/context.json
```

Setup 使用临时文件和回滚快照；中途失败时，不发布新的 Root Context。`resource-manifest.json` 和索引不预打包，安装后在当前 Plugin 目录生成，因此索引中的资源路径可以保持相对、可重定位。

## 按项目启用

Setup 将重复出现的 `--workspace-allowlist PATH` 规范化为真实目录（不存在则创建），并同时写入三处：

```text
$CODEX_HOME/config.toml
  [plugins."harness-data@lumi-ai-lab"] enabled = false
  [projects."<path>"] trust_level = "trusted"

<PATH>/.codex/config.toml
  [plugins."harness-data@lumi-ai-lab"] enabled = true

<pluginRoot>/config/workspace-policy.json
  同一份目录列表，供 Hook / MCP 二次校验
```

比较规则是 `realpath` 加目录关系，不是字符串前缀。例如：

```text
允许: /Users/me/project
拒绝: /Users/me/project-evil
```

加载和执行边界：

```text
Codex 项目配置 ─> 未启用则不加载 Skill / Hook / MCP
UserPromptSubmit ─┐
PreToolUse        ├─> workspace-policy.json ─> allow / no-op / deny
PostToolUse       │
MCP               ┘
```

未启用的项目不会获得 Harness Context，不会创建 state，不会启动 `qdm-metric-cli` UI，也不会写入 `analysis/`。`codex plugin list` 只显示用户级 disabled；要以新会话里的 Skill / Hook 是否加载为准。

## 授权材料

Setup 支持交互式输入，也支持参数或环境变量：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs" \
  --auth-blob-file "$HOME/.config/qdm/auth.blob" \
  --auth-user-id "your-user-id" \
  --gitee-token "$GITEE_TOKEN" \
  --github-token "$GITHUB_TOKEN" \
  --release-archive-password "$HARNESS_RELEASE_ARCHIVE_PASSWORD"
```

如果未提供：

- Gitee/GitHub API 需要授权时，Setup 私密询问对应 Token；
- 下载的加密 `qdm-metric-cli` ZIP 需要密码时，Setup 私密询问解压密码；
- 未提供 `auth.blob` 或用户标识时，Setup 私密询问 QDM 授权材料。

Token 仅用于 Setup 的网络请求，不写入 `context.json`、`install-manifest.json` 或普通状态。用户已选择把 `secretRoot` 放在 Plugin 内，因此 `Plugin/secrets/auth.blob` 必须由文件权限和安装目录权限共同保护。

## 报告文件边界

```text
stateRoot/html-report/<session-hash>/
├── result.json、卡片数据、caption 和 pipeline debug 状态
└── analysis/main.md                       ← session 内中间/权威产物

workspaceRoot/analysis/
├── main.md                                ← MCP 发布的最终 Markdown
└── main.html                              ← 用户确认后才创建
```

MCP 不接受模型自定义输出路径。`main.md` 固定发布到当前允许的 `workspaceRoot/analysis/main.md`；`main.html` 需要同时满足 B2_MAIN 已完成和 `confirmation: "生成 HTML"`。

## 源码和生成文件

仓库中应提交：

```text
.agents/plugins/marketplace.json
plugins/harness-data/.codex-plugin/
plugins/harness-data/hooks/
plugins/harness-data/mcp/
plugins/harness-data/scripts/
plugins/harness-data/skills/
```

Release ZIP 生成且不应提交：

```text
plugins/harness-data/dist/
plugins/harness-data/bootstrap/cli-manifest.json
plugins/harness-data/resources/wikis/
```

Setup 生成且不应提交：

```text
plugins/harness-data/context.json
plugins/harness-data/config/
plugins/harness-data/secrets/
plugins/harness-data/runtimes/
plugins/harness-data/.harness/
plugins/harness-data/resource-manifest.json
plugins/harness-data/install-manifest.json
```

校验命令：

```bash
node scripts/build-codex-marketplace.mjs verify --repo-root "$PWD"
node --test scripts/build-codex-marketplace.test.mjs
```
