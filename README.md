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

本仓库的 `.agents/claude`、`.agents/codex`、`.agents/pi`、`.agents/openclaw`、`.agents/hermes` 可分别链接为项目级 `.claude`、`.codex`、`.pi`、`.openclaw`、`.hermes` 配置。Codex 首次运行项目 hook 时可能要求在 `/hooks` 中信任配置。

`context` 负责根据 `.harness/index/wikis-runtime-index.json` 召回相关 `wikis/metrics`、`wikis/reports`、`wikis/dims`、`wikis/rules` 文件清单；如果 runtime 索引尚未生成，会回退到 `.harness/index/wikis-index.json` 派生运行时索引。Agent 读取这些文件后判断取数路径、调用数据 CLI、执行 `bin/data-harness-cli inject-template`。`posttool` 负责记录 Bash 取数模块状态，并在 inject-template 成功后只注入 session state 中 selected template 的正文。

## 常用命令

一键交互式初始化：

```bash
npx @lumi-ai-lab/harness-data install
```

安装器访问 GitHub 私有仓库时默认使用 `--git-protocol auto`：先用 SSH 访问 `harness-data` 和 `harness-data-wikis`，如果本机没有可用 GitHub SSH key 或无权限，会自动回退到 HTTPS。GitHub HTTPS 不支持账号密码登录；HTTPS 需要本机 Git Credential Manager、`gh auth login` 已配置的凭据，或通过 token 环境变量提供访问权限。

`qdm-metric-cli`、`qdm-sql-cli`、`cas-cli` 的二进制文件来自各自私有仓库的 GitHub Release：`pengmide/qdm-metric-cli`、`pengmide/qdm-sql-cli`、`pengmide/qdm-cas-cli`。数据查询唯一入口是 `qdm-metric-cli`（不再安装 `qdm-cmr-cli` / `qdm-indicators-cli`）。安装器下载这些私有 Release asset 时优先使用本机 `gh auth login` 的登录状态；如果没有可用 `gh` 登录，则回退到 `--github-token-env` 指定的 token 环境变量。两者都没有时安装会停止并提示配置其中之一。

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

非交互安装需要显式选择 Agent，并指向已经通过 `cas-cli config set-credentials` 配置好的 CAS credential 目录：

```bash
npx @lumi-ai-lab/harness-data install \
  --yes \
  --agent codex \
  --cas-config-dir /secure/path/to/cas
```

CI 或非交互环境可用 token 环境变量完成 HTTPS 访问；同一个 token 也会用于下载私有 qdm CLI Release asset。token 不会写入 remote URL、安装状态或项目配置。

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install \
  --yes \
  --agent codex \
  --git-protocol https \
  --github-token-env GITHUB_TOKEN \
  --cas-config-dir /secure/path/to/cas
```

`--agent` 支持 `claude`、`codex`、`pi`、`openclaw`、`hermes`、`both` 和 `all`。其中 `both` 表示 Claude + Codex，`all` 表示 Claude + Codex + Pi + OpenClaw + Hermes。

安装器会按步骤确认：clone 或复用仓库、按 `bootstrap/cli-manifest.json` 下载 CLI（`qdm-metric-cli` / `qdm-sql-cli` / `cas-cli` 等）、生成本地配置、配置或复用 CAS credentials、用 ticket 换取 SQL token、构建索引，并把所选 `.agents/*` Agent 模板链接为本地 `.claude` / `.codex` / `.pi` / `.openclaw` / `.hermes`。SQL token 对应 `cas-cli token --app rtp`；metric-cli 使用 auth-blob / data-auth，无需 CAS set-token。

更新工作目录：

```bash
npx @lumi-ai-lab/harness-data update --dir ~/harness-data
```

CAS 账号或密码发生变化，或者本地 `.qdm-auth` 被删除后，重新配置认证：

```bash
npx @lumi-ai-lab/harness-data auth --dir ~/harness-data
```

该命令会自动重建 `.qdm-auth/cas`、加密保存新的 CAS 凭证，并重新签发和校验 SQL Token；不会更新 runtime、CLI、Wikis 或 Agent Hook。metric-cli 数据权限仍走 auth-blob，不经本命令 set-token。

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
- `data-harness-cli-v0.0.1-linux-amd64.tar.gz`
- `data-harness-cli-v0.0.1-darwin-amd64.tar.gz`
- `data-harness-cli-v0.0.1-darwin-arm64.tar.gz`
- 每个压缩包都有对应的 `.sha256` 校验文件

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

发布失败后可以通过 Actions 页面重新运行失败的 job。需要针对已经存在的 Tag
重新执行完整编排时，可手动运行 `Release` workflow 并填写 Tag；如果 npm 已成功发布，
应关闭 `publish_npm`，因为 npm 的同版本内容不可覆盖。

需要配置 GitHub Actions secrets：

- `NPM_TOKEN`：发布 `@lumi-ai-lab/harness-data` 到 npm registry。
- `RELEASE_GH_TOKEN`：用于读取私有 `harness-data-wikis` submodule 和跨仓库 Release assets；当默认 `GITHUB_TOKEN` 没有这些权限时必须配置。

### Wikis submodule 与发布

`wikis` submodule 指针用于固定开发和 CI 的兼容性测试快照。runtime bundle 不包含
Wikis 内容；安装器会单独 clone 或更新 `harness-data-wikis`，并在安装端重新构建
Wikis 索引。因此，指标、报告、维度、规则或模板等普通知识内容更新不要求重新发布
本项目。

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
./bin/data-harness-cli show member-repurchase --json
```

不再提供独立的 `data-harness-cli claude-hook` 子命令。

## 目录结构

- `.agents/`：Agent 配置模板；npm 安装器可按用户选择链接到本地 `.claude`、`.codex`、`.pi`、`.openclaw` 或 `.hermes`。
- `bootstrap/cli-manifest.json`：npm 安装器下载 5 个 CLI 的版本、平台包 URL 和 sha256 配置。
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
  qdm_sql_cli: /absolute/path/to/qdm-sql-cli
  qdm_cas_cli: /absolute/path/to/cas-cli

authz:
  mode: off
  # blob_file: config/dev-auth.blob          # local only
  # dev_user_id: local-test-user             # required with blob_file; no code default
  allow_local_blob: true                     # production: set false
```

未配置时会自动识别 `wikis/` 下的新知识结构。Wiki 检查和索引使用 `metrics/...`、`reports/...`、`dims/...`、`rules/...` 逻辑路径；读取层仍兼容旧 `spec/...`、`playbooks/...`、`templates/...` 布局。

### 数据权限（qdm-metric-cli，默认关闭）

`authz.mode` 默认 `off`，不影响现有行为。设为 `on` 后，PI 扩展在 `tool_call` 中保证：

- 凡 `qdm-metric-cli analysis execute` 都会被强制加上 `--data-auth --auth-blob '<加密blob>'`
- 凡 `qdm-metric-cli auth describe` 都会被强制加上 `--auth-blob '<加密blob>'`（用于回答「当前用户有哪些权限」）
- 模型自带的 `--data-auth` / `--auth-blob` / `--auth-json` 会被剥掉并替换
- 当前 turn 没有有效 blob / userId 时直接 **block** 上述调用

Agent 侧完整约定见 Wiki：`wikis/rules/qdm-metric-cli/spec.md`（Harness context 默认 always inject）。权限内容全程是 **已加密** 的 `qdm1enc...` blob（Harness 不解密；metric-cli 内过滤）。

| 来源 | 说明 |
| --- | --- |
| Host `_auth` + `_auth_user_id` | **生产主路径**：网关加密后旁路下发（不写进用户 prompt 正文） |
| `HARNESS_AUTH_BLOB` + `HARNESS_AUTH_USER_ID` | 本地/调试 env，优先于文件 |
| `authz.blob_file` + `authz.dev_user_id` | **仅本地**：预生成密文；`dev_user_id` 必须显式配置，代码无默认用户 |

生产建议：`allow_local_blob: false`，只接受 Host `_auth`，避免仓库内测试 blob 污染生产。

`qdm-metric-cli` 与其它 QDM CLI 一样通过路径配置发现（**不要写死本机绝对路径进产品逻辑**）：

- `config/harness-config.yaml` → `cli.qdm_metric_cli`（安装器写 `…/bin/qdm-metric-cli`）
- `config/qdm-cli-paths.env` → `export QDM_METRIC_CLI="..."`
- 回退：仓库根下 `bin/qdm-metric-cli`
- PI Hook 会把裸名 / `$QDM_METRIC_CLI` 改写成解析到的绝对路径

本地生成测试 blob（gitignored，勿提交）：

```bash
cd /path/to/qdm-metric-cli
go run ./scripts/auth_blob_encrypt.go -in test/auth.json > /path/to/harness-data/config/dev-auth.blob
```

分槽 key 为 `sessionId::userId`；userId 来自 Host `_auth_user_id` 或本地显式 `dev_user_id` / `HARNESS_AUTH_USER_ID`。

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
