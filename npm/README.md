# Harness Data Plugin 内部 Setup 实现

这里的代码不是当前用户安装入口。它会被复制到：

```text
plugins/harness-data/dist/harness-data-installer/
```

用户先下载公开 Marketplace ZIP，解压后安装：

```bash
unzip harness-data-codex-marketplace-vX.Y.Z.zip
codex plugin marketplace add "$PWD/harness-data-codex-marketplace"
codex plugin add harness-data@lumi-ai-lab
```

然后执行已安装 Plugin 内的：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs"
```

## Setup 职责

`src/commands/setup.js` 为 Codex Plugin 准备运行实例：

- 解析 `pluginRoot`、`resourceRoot`、`dataRoot`、`secretRoot` 和 `workspaceRoot`；
- 将配置、Root Context、授权文件和外部 `qdm-metric-cli` 写入 Plugin 目录；
- 优先从 Gitee `git_pengmd/harness-metric-release`，失败后从 GitHub `pengmide/qdm-metric-cli` 获取当前平台的 latest Release；
- 下载私有 Wikis ZIP（或 `--wikis-source`）到 Plugin `resources/wikis/`，并在 Plugin 内构建索引；
- 用户级默认关闭插件，并在指定项目写入 `.codex/config.toml` 启用；
- 不在项目目录创建 Harness 状态目录。

支持的平台：

```text
darwin-arm64
linux-amd64
windows-amd64
windows-arm64
```

## Setup 参数

```text
--data-root PATH
--workspace-root PATH
--workspace-allowlist PATH       可重复；目录不存在则创建并启用本插件
--metric-cli PATH
--gitee-token TOKEN
--github-token TOKEN
--release-archive-password VALUE
--auth-blob BLOB
--auth-blob-file PATH
--auth-user-id ID
--secret-ref VALUE
--no-auth
--json
```

未提供 Gitee/GitHub Token、Release ZIP 密码或 QDM `auth.blob` 时，交互式终端会私密询问。非交互运行必须通过参数或环境变量提供所需材料。

## 目录约定

Codex Plugin 布局：

```text
<pluginRoot>/
├── resources/wikis/                  # Setup 下载后运行时直接读取
├── .harness/index/                   # Setup 生成的索引
├── resource-manifest.json            # Setup 生成
├── config/                           # Setup 生成
├── secrets/auth.blob                 # Setup 生成，0600
├── runtimes/<platform>/qdm-metric-cli
├── context.json                      # Setup 生成
└── install-manifest.json             # Setup 生成
```

普通 Harness 状态和 html-report Pipeline 状态在外部 `dataRoot/state/workspaces/<hash>/`。最终报告由 html-report MCP 写入 `workspaceRoot/analysis/main.md`；同级 HTML 只有在用户明确确认后才生成。

## 兼容实现

旧本地 runtime 的 `install`、`update` 和 `migrate` 代码仍保留在源码中，用于内部迁移和回归测试；它们不属于新用户的 Plugin 安装流程。Wiki Git checkout、独立 Wiki 发布和独立 runtime 发布也不属于当前产品渠道。

## 开发测试

```bash
npm test -- --test-concurrency=1
node ../plugins/harness-data/scripts/bundle-dist.mjs \
  --output-dir ../plugins/harness-data/dist
```
