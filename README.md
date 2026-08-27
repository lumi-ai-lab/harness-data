# QDM 运行约束数据

本目录存放 QDM 助手在用户提交提示词时使用的运行约束规格说明。当前版本覆盖经营分析、门店管理、用户运营和财务核心指标等上下文发现场景。

运行时入口由已编译的 `bin/data-harness-cli` 提供。Claude Code 的 `UserPromptSubmit` hook 调用：

```bash
"$CLAUDE_PROJECT_DIR/bin/data-harness-cli" context --format claude-hook
```

Claude Code 的 `PostToolUse` hook 调用：

```bash
"$CLAUDE_PROJECT_DIR/bin/data-harness-cli" posttool --format claude-hook
```

Codex 使用 `.codex/hooks.json` 配置同等事件：

- `UserPromptSubmit` 调用 `bin/data-harness-cli context --format codex-hook`
- `PreToolUse` 仅匹配 `Bash`，调用 `bin/data-harness-cli authz-hook --agent codex` 授权 `qdm-metric-cli` gated 命令
- `PostToolUse` 仅匹配 `Bash`，调用 `bin/data-harness-cli posttool --format codex-hook`

Pi 使用 `.pi/settings.json` 加载项目扩展：

- `before_agent_start` / `context` 调用 `bin/data-harness-cli context --format agent-hook`
- `tool_call` 在 `bin/data-harness-cli stage template` / `inject-template` 命令后追加 `posttool --format agent-hook`，并把 `additionalContext` 转成 Pi 可见的命令输出

OpenClaw 使用 `.openclaw` 加载 workspace instructions、skill 和 plugin：

- `before_prompt_build` 调用 `bin/data-harness-cli context --format agent-hook` 注入当前 turn 的 Harness context
- `after_tool_call` 观察 shell/exec 命令，在 `bin/data-harness-cli stage template` / `inject-template` 后调用 `posttool --format agent-hook` 注入 selected template context

Hermes-Agent 使用 `.hermes` 加载项目上下文、skill 和 hook：

- 优先使用 Hermes Python plugin 的 `pre_llm_call` / `post_tool_call`
- `agent-hooks/qdm-pre-llm-call.sh` 和 `agent-hooks/qdm-post-tool-call.sh` 作为 shell hook fallback，同样复用 `agent-hook` 格式

WorkBuddy 5.3.5+ 使用 `.agents/workbuddy` 中的原生插件包：

- `UserPromptSubmit` 通过零依赖 `harness-hook.mjs` 调用 `context --format workbuddy-hook`
- `PostToolUse` 匹配 `Bash|PowerShell|execute_command`，归一化为 `Bash` 后调用 `posttool --format workbuddy-hook`
- 插件清单位于 `agents/workbuddy/.codebuddy-plugin/plugin.json`，本地 Marketplace 清单位于 `agents/.codebuddy-plugin/marketplace.json`；目录存在不等于插件已经安装或启用
- 使用 `authz.mode=on` 接入 data-auth/auth blob；不兼容配置和 Hook 运行错误会同时通过 `additionalContext` 与 `systemMessage` 显式提示
- WorkBuddy 必须提供稳定 `session_id`；状态使用 Agent 命名空间和抗碰撞 SHA-256 文件名，不回退到共享 `unknown`

本仓库的 `.agents/claude`、`.agents/codex`、`.agents/pi`、`.agents/openclaw`、`.agents/hermes` 可分别链接为项目级 `.claude`、`.codex`、`.pi`、`.openclaw`、`.hermes` 配置；WorkBuddy 使用插件包，不创建误导性的 `.workbuddy` symlink。Codex 首次运行项目 hook 时可能要求在 `/hooks` 中信任配置。

`context` 负责根据 `.harness/index/wikis-runtime-index.json` 召回相关 `wikis/metrics`、`wikis/reports`、`wikis/dims`、`wikis/rules` 文件清单；如果 runtime 索引尚未生成，会回退到 `.harness/index/wikis-index.json` 派生运行时索引。Agent 读取这些文件后判断取数路径、调用数据 CLI、执行 `bin/data-harness-cli inject-template`。`posttool` 负责记录 Bash 取数模块状态，并在 inject-template 成功后只注入 session state 中 selected template 的正文。

## 常用命令

一键交互式初始化：

```bash
npx @lumi-ai-lab/harness-data install
```

Wikis 仍通过 GitHub 访问：默认 `--git-protocol auto` 会先用 SSH 访问 `harness-data` 和 `harness-data-wikis`，不可用时回退 HTTPS。GitHub HTTPS 不支持账号密码登录；HTTPS 需要本机 Git Credential Manager、`gh auth login` 已配置的凭据，或通过 token 环境变量提供访问权限。

Release 下载与 GitHub 授权解耦。安装器默认 `--release-source auto`，先从 Gitee 的同 Tag Release 查找精确同名的普通附件，缺少该附件、Release 不存在或接口失败时才回退 GitHub。可强制指定 `gitee` 或 `github`，环境变量为 `HARNESS_RELEASE_SOURCE`；命令行优先级更高。`data-harness-cli` 与 runtime 映射到 `git_pengmd/harness-release`，`qdm-metric-cli` 映射到 `git_pengmd/harness-metric-release`。Gitee 镜像完整时，即使没有 GitHub token 也能远程安装两个 CLI；但没有 GitHub 授权时仍需提供本地 `harness-data-wikis`。强制 GitHub 时，`qdm-metric-cli` 保持私有 Release 的 `gh auth login` / `GITHUB_TOKEN` / `--github-token` 限制。

强制使用 SSH：

```bash
npx @lumi-ai-lab/harness-data install --git-protocol ssh
```

强制使用 HTTPS：

```bash
npx @lumi-ai-lab/harness-data install --git-protocol https
```

指定安装目录：

```bash
npx @lumi-ai-lab/harness-data install --dir ~/harness-data
```

指定 Release 下载源：

```bash
npx @lumi-ai-lab/harness-data install --release-source gitee
HARNESS_RELEASE_SOURCE=github npx @lumi-ai-lab/harness-data update --dir ~/harness-data
```

非交互安装需要显式选择 Agent：

```bash
npx @lumi-ai-lab/harness-data install \
  --yes \
  --agent codex
```

所有受支持平台都需要 `git`、`tar` 和 `unzip` 在 PATH 中；`tar` 仅保留给历史明文
`.tar.gz` Release 的兼容回退。Release ZIP 密码已内置在安装器中，交互式与非交互式
安装、更新都不会再询问密码，也不需要设置 `HARNESS_RELEASE_PASSWORD`。

WorkBuddy 安装会准备本地 Marketplace；完成后在 WorkBuddy 插件管理中选择 **Add Marketplace**，添加 runtime 的 `agents` 目录，再安装并启用 `qdm-harness@lumi-harness-data`、reload plugins：

```bash
npx @lumi-ai-lab/harness-data install \
  --yes \
  --agent workbuddy
```

CI 或非交互环境可用 token 环境变量完成 HTTPS 访问；同一个 token 也会用于下载私有 qdm CLI Release asset。token 不会写入 remote URL、安装状态或项目配置。

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install \
  --yes \
  --agent codex \
  --git-protocol https \
  --release-source github
```

`--agent` 支持 `claude`、`codex`、`pi`、`openclaw`、`hermes`、`workbuddy`、`both` 和 `all`。其中 `both` 表示 Claude + Codex；在项目自有 WorkBuddy E2E 矩阵完成前，`all` 继续保持 Claude + Codex + Pi + OpenClaw + Hermes 的既有语义，WorkBuddy 需要显式选择 `--agent workbuddy`。

安装器会按步骤确认：clone 或复用仓库、按 `bootstrap/cli-manifest.json` 下载 CLI（`data-harness-cli` / `qdm-metric-cli`）、生成本地配置、构建索引，并把所选 `.agents/*` Agent 模板链接为本地 `.claude` / `.codex` / `.pi` / `.openclaw` / `.hermes`。选择 WorkBuddy 时，安装器只准备 `agents` Marketplace 与其中的 `agents/workbuddy` 插件包并打印 Add Marketplace/启用路径，不会自动修改 WorkBuddy settings 或 Marketplace 注册。metric-cli 数据权限默认开启；WorkBuddy auth 仅支持 macOS 和 Windows，其他平台请选择受支持的 Agent。

更新工作目录：

```bash
npx @lumi-ai-lab/harness-data update --dir ~/harness-data
```

仅检查可用更新：

```bash
npx @lumi-ai-lab/harness-data update --check --dir ~/harness-data
```

诊断当前环境：

```bash
npx @lumi-ai-lab/harness-data doctor --dir ~/harness-data
```

全局安装作为可选方式：

```bash
npm install -g @lumi-ai-lab/harness-data
harness-data doctor --dir ~/harness-data
```

重新编译正式入口：

```bash
go build -o bin/data-harness-cli ./cli/cmd/data-harness-cli
```

也可以直接使用 GHCR 上发布的 CLI 容器镜像：

```bash
docker run --rm ghcr.io/lumi-ai-lab/harness-data-cli:latest --help
docker run --rm -v "$PWD:/workspace" -w /workspace ghcr.io/lumi-ai-lab/harness-data-cli:latest context --question "华东区最近会员复购为什么下降？" --json
docker run --rm -v "$PWD:/workspace" -w /workspace ghcr.io/lumi-ai-lab/harness-data-cli:latest wikis check-all
```

镜像包名为 `ghcr.io/lumi-ai-lab/harness-data-cli`。推送 `v*` Git tag 时会发布同名版本标签和 `latest` 标签；普通 `master` push 只做容器构建验证，不推送镜像。

版本标签同时提供多架构入口和显式架构标签：

- `ghcr.io/lumi-ai-lab/harness-data-cli:v0.0.1`
- `ghcr.io/lumi-ai-lab/harness-data-cli:v0.0.1-linux-amd64`
- `ghcr.io/lumi-ai-lab/harness-data-cli:v0.0.1-linux-arm64`

GitHub Releases 同时提供可直接下载的 CLI 二进制包：

- `data-harness-cli-v0.0.1-windows-amd64.zip`
- `data-harness-cli-v0.0.1-windows-arm64.zip`
- `data-harness-cli-v0.0.1-linux-amd64.zip`
- `data-harness-cli-v0.0.1-darwin-arm64.zip`
- `harness-data-runtime-v0.0.1.zip`
- `harness-data-wikis-v0.0.1.zip`

从新版本开始，Release ZIP 使用固定密码的传统 ZIP 加密。安装器内置与发布产物一致的
密码，用户不需要输入密码或设置环境变量；Intel Mac（`darwin-amd64`）不再受支持。
传统 ZIP 加密只用于避免下载后被随手查看，不能作为对抗破解、再分发或源码泄露的安全
边界。

## 发布流程

正式发布由不可变的 SemVer Tag 驱动。发布前先在普通提交中更新
`npm/package.json` 的版本，以及需要随版本固定的 CLI manifest 和 `wikis`
submodule 指针；确认 CI 通过后创建并推送同版本 Tag：

```bash
git tag -a v0.0.27 -m "v0.0.27"
git push origin v0.0.27
```

GitHub Actions 的 `Release` workflow 会校验 Tag 符合 `vMAJOR.MINOR.PATCH`，且
`v0.0.27` 必须对应 `npm/package.json` 中的 `0.0.27`。workflow 只读取 Tag
指向的内容，不会修改提交、移动 Tag 或自动替换已存在的 Tag。

总编排会 checkout Tag 中固定的 `wikis` submodule，执行 `npm test`、
`npm pack --dry-run`、Wikis 索引构建和 `go test ./...`，随后发布
`data-harness-cli` GitHub Release assets 与 GHCR 镜像。Release assets 验证通过后
才发布 npm 包，最后检查 npm public 状态、`latest` dist-tag 和实际 `npx` 执行结果。

先在 `qdm-metric-cli` 发布包含四个平台加密 ZIP 的新 Tag，再发布本仓库 Tag；本仓库
发布前会校验最新 `qdm-metric-cli` Release 的 ZIP 资产。Gitee 同步器只会原样同步新
Tag 的 Release assets，不会删除或重建历史 Release，也不会同步 GitHub 自动生成的
源码归档。

Gitee 镜像由发布者手动维护：每个 GitHub Tag 都必须在对应 Gitee 仓库创建同 Tag 的
Release，而不只是同步 Tag。`git_pengmd/harness-release` 必须上传名称完全一致的四平台
`data-harness-cli-*.zip`、`harness-data-runtime-<tag>.zip` 与
`harness-data-wikis-<tag>.zip`；
`git_pengmd/harness-metric-release` 必须上传名称完全一致的四平台
`qdm-metric-cli-*.zip`。安装器只选择这些普通附件，不使用源码归档；不要求额外上传
`.sha256`。发布工作流的 `RELEASE_ARCHIVE_PASSWORD` 必须与安装器内置值保持一致。

发布失败后可以通过 Actions 页面重新运行失败的 job。需要针对已经存在的 Tag
重新执行完整编排时，可手动运行 `Release` workflow 并填写 Tag；如果 npm 已成功发布，
应关闭 `publish_npm`，因为 npm 的同版本内容不可覆盖。

需要配置 GitHub Actions secrets：

- `NPM_TOKEN`：发布 `@lumi-ai-lab/harness-data` 到 npm registry。
- `RELEASE_GH_TOKEN`：用于读取私有 `harness-data-wikis` submodule 和跨仓库 Release assets；当默认 `GITHUB_TOKEN` 没有这些权限时必须配置。
- `RELEASE_ARCHIVE_PASSWORD`：两仓库使用相同值，生产 Tag 发布时用于生成和验证传统加密 ZIP；必须与安装器内置的 `RELEASE_ARCHIVE_PASSWORD` 值一致。它不是强保密边界，仍不应写入 Release 文案或工作流日志。

### Wikis submodule 与发布

`wikis` submodule 指针用于固定开发和 CI 的兼容性测试快照。runtime bundle 不包含
Wikis 内容；Release 会从该固定快照额外生成
`harness-data-wikis-<tag>.zip`，并使用与其他 Release ZIP 相同的密码加密。安装器
会从所选 Release 源下载、校验并替换 Wikis，然后在安装端重新构建索引；Gitee 安装
不需要 GitHub 访问条件或用户准备本地 `harness-data-wikis` 副本。

因此，指标、报告、维度、规则或模板等知识内容需要通过新的本项目 Tag 下发。发布者
同步 Gitee Release 时必须一并同步同 Tag 的 Wikis ZIP，保证 `auto` 和
`--release-source gitee` 仍可完整安装。

当 Wikis 目录结构、frontmatter/schema、索引格式或 Agent/CLI 运行时契约发生变化时，
应先更新本项目实现和 submodule 指针，通过兼容性测试后再创建新的本项目 Tag。
主仓库中涉及 `wikis` 指针、CLI、配置、bootstrap 或 Agent Runtime 的 PR 会自动运行
`Wikis Compatibility` workflow；该检查只验证精确 submodule 快照，不发布任何产物。

验证与调试：

```bash
./bin/data-harness-cli wikis check-all
./bin/data-harness-cli wikis build-index
./bin/data-harness-cli context --question "华东区最近会员复购为什么下降？" --json
./bin/data-harness-cli wikis recall-debug --question "会员复购为什么下降？"
printf '{"prompt":"会员复购为什么下降？"}' | ./bin/data-harness-cli context --format claude-hook
printf '{"session_id":"debug","tool_name":"Bash","tool_input":{"command":"bin/data-harness-cli inject-template"}}' | ./bin/data-harness-cli posttool --format claude-hook
printf '{"session_id":"workbuddy-debug","prompt":"会员复购为什么下降？"}' | ./bin/data-harness-cli context --format workbuddy-hook
printf '{"session_id":"workbuddy-debug","tool_name":"Bash","tool_input":{"command":"bin/data-harness-cli stage template"}}' | ./bin/data-harness-cli posttool --format workbuddy-hook
./bin/data-harness-cli show member-repurchase --json
```

不再提供独立的 `data-harness-cli claude-hook` 子命令。

## 目录结构

- `.agents/`：Agent 配置模板；npm 安装器可按用户选择链接到本地 `.claude`、`.codex`、`.pi`、`.openclaw` 或 `.hermes`，WorkBuddy 则使用 `.agents/workbuddy` 原生插件包。
- `bootstrap/cli-manifest.json`：npm 安装器下载两个 CLI 的四个平台 ZIP 坐标；安装状态仅保留本地二进制复用所需的 SHA-256。
- `.harness/index/`：由 `data-harness-cli wikis build-index` 生成的机器索引。
- `.harness/state/`：hook 运行态，包括 session 选择、取数模块记录和诊断日志。
- `bin/data-harness-cli`：正式运行使用的 Data Harness CLI。
- `cli/`：Data Harness CLI 源码和 Go 测试。
- `config/harness-config.yaml.example`：Harness 统一配置模板；本地运行前复制为 `config/harness-config.yaml` 并填入本机 QDM CLI 绝对路径。
- `config/qdm-cli-paths.env.example`：QDM CLI 环境变量模板；本地运行前复制为 `config/qdm-cli-paths.env`。
- `wikis/`：业务知识库根目录，可作为 git submodule 管理。
- `wikis/metrics/`：指标对象目录，每个对象聚合 `spec.md` 和 `playbook.md`。
- `wikis/reports/`：报告对象目录，每个对象聚合 `spec.md`、`playbook.md` 和 `template.md`；`selection.yaml` 维护报告模板选择。
- `wikis/dims/`：维度编码与映射规则。
- `wikis/rules/`：通用取数、时间口径和 CLI 使用规则。
- `tests/`：Python 集成测试。

### 本地配置

真实配置文件包含本机绝对路径，不提交到 Git。首次运行前先从 example 生成本地配置：

```bash
cp config/harness-config.yaml.example config/harness-config.yaml
cp config/qdm-cli-paths.env.example config/qdm-cli-paths.env
```

然后把两个文件里的 `/absolute/path/to/...` 改成当前机器上的 QDM CLI 路径。需要在 shell 中使用这些 CLI 环境变量时，执行：

```bash
source config/qdm-cli-paths.env
```

`config/harness-config.yaml` 是受限 YAML，目前支持 `paths`、`cli` 和可选的 `authz` section。example 默认提供：

```yaml
paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /absolute/path/to/qdm-metric-cli

authz:
  mode: on
  # blob_file: config/dev-auth.blob          # local only
  # dev_user_id: <user-id>                   # required with blob_file
  allow_local_blob: true                     # admin-distributed local blob requires true
```

未配置时会自动识别 `wikis/` 下的新知识结构。Wiki 检查和索引使用 `metrics/...`、`reports/...`、`dims/...`、`rules/...` 逻辑路径；读取层仍兼容旧 `spec/...`、`playbooks/...`、`templates/...` 布局。

### 数据权限（qdm-metric-cli，默认开启）

macOS 与 Windows WorkBuddy 共用本地 Blob auth 流程。WorkBuddy auth 要求 Desktop `5.3.11+`、内置 CodeBuddy CLI `2.115.0+`；Windows 的受控 QDM 命令使用 Bash，PowerShell 路径在读取凭据前 fail-closed。

安装器默认写入 `authz.mode: on`，并要求 Blob 与 `dev_user_id`。开发环境可使用 `install --dev` 调用 `qdm-metric-cli dev` 注册管理员 Blob；该流程同样只写入 `mode: on`。设为 `on` 后，Agent authz 适配器进入命令识别与授权流程，并保证：

- 凡 `qdm-metric-cli analysis execute` 都会被强制加上 `--data-auth --auth-blob '<加密blob>'`
- 凡 `qdm-metric-cli auth describe` 都会被强制加上 `--auth-blob '<加密blob>'`（用于回答「当前用户有哪些权限」）
- 模型自带的 `--data-auth` / `--auth-blob` / `--auth-json` 会被剥掉并替换
- 当前 turn 没有有效 blob / userId 时直接 **block** 上述调用

Pi 的实现基于扩展 `tool_call` 事件读取授权信息，并在 tool call 阶段直接改写 Bash command。Codex 适配按同一思路实现：`PreToolUse matcher=Bash` 每次读取本地 blob 来源（环境变量或配置文件），然后直接把 gated `qdm-metric-cli` 命令改写成带 runtime auth flags 的命令。MVP 不接入 Host `_auth`，不读取 Lumi Envelope。

无 wrapper 模式下，Codex `updatedInput.command` 这个必要传输面会承载完整 `qdm1enc...`，因为 `qdm-metric-cli` 当前只通过 `--auth-blob` 接收权限 blob。约束边界是：除 `updatedInput.command` 中执行所必需的 argv 外，hook 不额外在 stderr、诊断文案、context 文案或普通日志中输出完整 blob。模型自带的 `--auth-blob` / `--auth-json` / `--data-auth` 会先被剥离并替换成 runtime blob。

`authz.mode=on` 时启用第二层 blob 来源隔离：

```text
普通 Bash
  -> Codex PreToolUse
  -> unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR
  -> 执行原 Bash 命令

qdm-metric-cli gated Bash
  -> Codex PreToolUse
  -> hook 读取本地 blob（env / config file）
  -> hook strip 模型自带 auth flags
  -> hook 直接返回 qdm-metric-cli --data-auth --auth-blob ...
  -> 返回命令前 unset auth 来源 env
```

当前目标使用场景是：用户在 Codex App 或终端里使用 Harness，权限 blob 由管理员预先生成并分发到用户本机。Harness 只负责验证本地是否绑定了有效 blob，并在执行 `qdm-metric-cli analysis execute` / `qdm-metric-cli auth describe` 前注入权限参数；不负责生成、加密或解密 blob。

管理员分发 blob 的推荐接入方式：

```text
管理员
  -> 生成 qdm1enc... blob
  -> 分发到用户本机 workspace 外，例如 ~/.qdm/auth/qdm-auth.blob
  -> 文件权限 0600

用户 Codex App
  -> 启动 Codex 时提供 HARNESS_AUTH_BLOB_FILE + HARNESS_AUTH_USER_ID
  -> Codex PreToolUse hook 改写 gated qdm-metric-cli 命令
  -> hook 直接注入 --auth-blob
  -> qdm-metric-cli 做真实权限验证

用户终端
  -> 提供同一组 HARNESS_AUTH_BLOB_FILE + HARNESS_AUTH_USER_ID
  -> 在 Codex hook 生效的终端里直接执行 qdm-metric-cli 命令
  -> qdm-metric-cli 做真实权限验证
```

配置要求：

```yaml
authz:
  mode: on
  allow_local_blob: true
```

`allow_local_blob=true` 是管理员分发本地 blob 场景的必要开关；若设为 `false`，Harness 会禁用所有本地 blob 来源（`HARNESS_AUTH_BLOB*` 和 `authz.blob_file`）。

安全约束：管理员分发的 blob 文件建议放在 workspace 外，不提交、不让模型通过项目文件直接读取。`authz.mode=on` 时，Codex hook 会对普通 Bash 注入 `unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR`，避免普通 Bash 继承 auth 来源 env；gated command 也会在直接注入 runtime blob 后先 unset 这些来源 env。`LUMI_REQUESTER_CONTEXT_DIR` 虽已不再读取，但为兼容旧运行环境仍一并清理。当前 Codex 没有 hook-only env 通道，因此该隔离依赖 Codex `PreToolUse` hook 被启用且可信。

**安装器开关**（不必手改配置）：

```bash
# ① 默认安装（带权限）——交互输入 blob + dev_user_id
npx @lumi-ai-lab/harness-data install

# ② 带权限 + flag 直传 blob（非交互，适合 CI）
npx @lumi-ai-lab/harness-data install \
  --auth-blob 'qdm1enc...' --auth-user-id 'your-user-id' --yes

# ③ 带权限 + env 传入 blob
HARNESS_AUTH_BLOB='qdm1enc...' HARNESS_AUTH_USER_ID='your-user-id' \
npx @lumi-ai-lab/harness-data install --yes

# ④ 开发管理员注册（交互式密码）
npx @lumi-ai-lab/harness-data install --dev

# ⑤ 开发管理员注册（非交互）
npx @lumi-ai-lab/harness-data install --dev --dev-password 'PASSWORD' --yes

# ⑥ 开发/测试快捷方式（用内置 fixture blob）
npx @lumi-ai-lab/harness-data install --data-auth
```

默认安装会写入：

```yaml
authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: <用户输入>
  allow_local_blob: true
```

并将用户提供的 Blob 写入权限为 `0600` 的 `config/dev-auth.blob`（工作副本 gitignore）。`--data-auth` 会用 runtime 内置的 `config/fixtures/local-test-auth.blob` 覆盖该文件，并使用 `dev_user_id: local-test-user`。
说明：`harness-data auth` 是 **CAS** 子命令，与 metric data-auth **无关**。

Agent 侧完整约定见 Wiki：`wikis/rules/qdm-metric-cli/spec.md`（Harness context 默认 always inject）。权限内容全程是 **已加密** 的 `qdm1enc...` blob（Harness 不解密；metric-cli 内过滤）。

| 来源 | 说明 |
| --- | --- |
| Host `event._auth` + `_auth_user_id` | Pi 主路径；Codex MVP 不接入 Host `_auth` |
| `HARNESS_AUTH_BLOB_FILE` + `HARNESS_AUTH_USER_ID` | **管理员分发 blob 的推荐路径**：blob 文件放 workspace 外，文件权限建议 `0600`；`allow_local_blob: false` 时禁用。`authz.mode=on` 时普通 Bash 会被 PreToolUse 改写为先 unset 这些变量 |
| `HARNESS_AUTH_BLOB` + `HARNESS_AUTH_USER_ID` | 本地/调试 env，优先于文件；`allow_local_blob: false` 时禁用。`authz.mode=on` 时普通 Bash 会被 PreToolUse 改写为先 unset 这些变量 |
| `authz.blob_file` + `authz.dev_user_id` | 本地文件配置；`dev_user_id` 必须显式配置；`allow_local_blob: false` 时禁用。若用于管理员分发 blob，建议配置 workspace 外绝对路径 |

解析优先级：`HARNESS_AUTH_BLOB` -> `HARNESS_AUTH_BLOB_FILE` -> `authz.blob_file`。MVP 只读取本机 Local Blob，不接收 Host `_auth`，不读取 Lumi Envelope。

默认 install 为 `mode: on`；开发管理员可用 `--dev` 注册隐藏 admin Blob，开发测试可用 `--data-auth` + 内置 fixture。管理员分发 Blob 的正式使用场景保持 `allow_local_blob: true`，并把 Blob 文件放在 workspace 外。

`qdm-metric-cli` 与其它 QDM CLI 一样通过路径配置发现（**不要写死本机绝对路径进产品逻辑**）：

- `config/harness-config.yaml` → `cli.qdm_metric_cli`（安装器写 `…/bin/qdm-metric-cli`）
- `config/qdm-cli-paths.env` → `export QDM_METRIC_CLI="..."`
- 回退：仓库根下 `bin/qdm-metric-cli`
- `authz.mode=on` 时，Agent authz 会把受控命令中的裸名 / `$QDM_METRIC_CLI` 改写成解析到的绝对路径

仓库已提交 fixture 密文（`config/fixtures/`）；也可自行再生成工作副本（gitignored，勿提交 `config/dev-auth.blob`）：

```bash
cd /path/to/qdm-metric-cli
go run ./scripts/auth_blob_encrypt.go \
  -in /path/to/harness-data/config/fixtures/local-test-auth.json \
  > /path/to/harness-data/config/dev-auth.blob
```

分槽 key 为 `sessionId::userId`；userId 来自本地显式 `dev_user_id` / `HARNESS_AUTH_USER_ID`。

## Context 输出

普通 JSON 模式：

```bash
./bin/data-harness-cli context --question "会员复购为什么下降？" --json
```

输出包含：

- `question`
- `contextFiles`
- `instruction`
- `constraints`

Claude hook 模式：

```bash
printf '{"prompt":"会员复购为什么下降？"}' | ./bin/data-harness-cli context --format claude-hook
```

输出为 Claude Code hook JSON：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

`additionalContext` 只包含时间上下文、必须读取的 `contextFiles`、执行指令和约束；不会输出 `query_type=...`，也不会注入 spec、playbook 或 template 正文。

## PostToolUse 输出

Claude hook 模式：

```bash
printf '{"session_id":"debug","tool_name":"Bash","tool_input":{"command":"bin/data-harness-cli inject-template"}}' \
  | ./bin/data-harness-cli posttool --format claude-hook
```

`posttool` 只处理 `Bash` 工具事件：

- 取数命令：记录对应 report 的必需模块，不输出 additionalContext。
- `bin/data-harness-cli inject-template`：根据当前 session 中的 selected playbook 注入其绑定的 template。
- template 注入满足：只注入 selected playbook 绑定的 template 正文，不注入 spec 或 playbook。

## 召回原则

- 运行时从 `.harness/index/wikis-runtime-index.json` 的 recall term 召回 spec 文档，并按同目录 sibling 规则选择单指标 playbook。
- 召回先做中文轻量 normalize：去空白、去常见标点、全角 ASCII 转半角，仅保留中文、数字、字母。
- 精确包含命中最高优先级；非精确命中使用中文 bigram/trigram 覆盖率打分。
- 1 字、2 字 term 只允许精确包含；3 字 term 需要完整 bigram 覆盖；4 字及以上 term 需要至少 2 个 bigram 且覆盖率不低于 0.5。
- 同一 `targetPath` 只保留最高分 term，并继续抑制已命中长 term 内包含的短 term。
- 最终 plan 只选择 spec、playbook、template 逻辑路径；template 正文仍只在 `inject-template` 阶段注入。

## 运行约束

- 数值、同比、环比、排名、阈值必须来自 CLI 输出。
- 不得估算、补造或用示例数值替代缺失数据。
- Harness 的分析结果、查询结果、报告、摘要和诊断结论默认必须直接回复用户。
- 除非用户明确要求导出、保存或生成文件，否则不得把最终结果或中间分析结果写入文件。
- 必需取数完成后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、整理报告素材、生成中间分析、输出阶段性结论。
- template 注入前禁止读取、打开、猜测或使用任何 `template.md` 文件。
- inject-template 成功后只由 `posttool` 注入 selected playbook 绑定的 template 正文。

## 诊断

默认不写诊断。设置 `QDM_HARNESS_DIAG=1` 后，hook 会向 `.harness/state/diagnostics/<session>.jsonl` 追加 context 发现诊断，核心字段包括：

- `matched_domains`
- `context_files`
- `keyword_hits`
- `context_bytes`
- `inject_template`
- `template_path`
- `template_stats`

诊断使用上下文发现和 selected playbook 字段表达当前运行状态。

召回调试可直接查看 normalized question、query bigrams/trigrams、top matches、score、exact/fuzzy、matched ngrams、targetPath 和最终 plan：

```bash
./bin/data-harness-cli wikis recall-debug --question "会员复购为什么下降？" --top 20
./bin/data-harness-cli wikis recall-debug --question "会员复购为什么下降？" --json
```
