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

`context` 负责根据 `.harness/index/wikis-runtime-index.json` 召回相关 `wikis/spec`、`wikis/playbooks` 文件清单；如果 runtime 索引尚未生成，会回退到 `.harness/index/wikis-index.json` 派生运行时索引。Agent 读取这些文件后判断取数路径、调用数据 CLI、执行 `bin/data-harness-cli inject-template`。`posttool` 负责记录 Bash 取数模块状态，并在 inject-template 成功后只注入 session state 中 selected template 的正文。

## 常用命令

重新编译正式入口：

```bash
go build -o bin/data-harness-cli ./cli/cmd/data-harness-cli
```

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

- `.claude/settings.json`：注册 Claude Code hook，调用 `context --format claude-hook` 和 `posttool --format claude-hook`。
- `.harness/index/`：由 `data-harness-cli wikis build-index` 生成的机器索引。
- `bin/data-harness-cli`：正式运行使用的 Data Harness CLI。
- `cli/`：Data Harness CLI 源码和 Go 测试。
- `config/harness-config.yaml.example`：Harness 统一配置模板；本地运行前复制为 `config/harness-config.yaml` 并填入本机 QDM CLI 绝对路径。
- `config/qdm-cli-paths.env.example`：QDM CLI 环境变量模板；本地运行前复制为 `config/qdm-cli-paths.env`。
- `wikis/`：业务知识库根目录，可作为 git submodule 管理。
- `wikis/playbooks/`：分析流程与必要证据来源。
- `wikis/spec/`：报告指标归属和业务知识权威说明。
- `wikis/templates/`：inject-template 成功后二阶段注入的报告骨架与输出约束。
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

`config/harness-config.yaml` 是受限 YAML，目前支持 `paths` 和 `cli` 两个 section。example 默认提供：

```yaml
paths:
  spec: wikis/spec
  playbooks: wikis/playbooks
  templates: wikis/templates

cli:
  qdm_cmr_cli: /absolute/path/to/qdm-cmr-cli
  qdm_indicators_cli: /absolute/path/to/qdm-indicators-cli
  qdm_cas_cli: /absolute/path/to/cas-cli
```

未配置时默认兼容根目录 `spec/`、`playbooks/`、`templates/` 结构。Wiki 检查和索引内部统一使用 `spec/...`、`playbooks/...`、`templates/...` 逻辑路径；context 输出使用可直接读取的物理相对路径。

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

- 运行时从 `.harness/index/wikis-runtime-index.json` 的 recall term 召回 `spec` 和 combo `playbook`。
- 召回先做中文轻量 normalize：去空白、去常见标点、全角 ASCII 转半角，仅保留中文、数字、字母。
- 精确包含命中最高优先级；非精确命中使用中文 bigram/trigram 覆盖率打分。
- 1 字、2 字 term 只允许精确包含；3 字 term 需要完整 bigram 覆盖；4 字及以上 term 需要至少 2 个 bigram 且覆盖率不低于 0.5。
- 同一 `targetPath` 只保留最高分 term，并继续抑制已命中长 term 内包含的短 term。
- 最终 plan 只选择 `spec`、`playbook`、`templates` 逻辑路径；template 正文仍只在 `inject-template` 阶段注入。

## 运行约束

- 数值、同比、环比、排名、阈值必须来自 CLI 输出。
- 不得估算、补造或用示例数值替代缺失数据。
- 除非用户明确要求导出文件，否则不得写入报告文件。
- 必需取数完成后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、整理报告素材、生成中间分析、输出阶段性结论。
- template 注入前禁止读取、打开、猜测或使用任何 `wikis/templates/` 文件。
- inject-template 成功后只由 `posttool` 注入 selected playbook 绑定的 template 正文。

## 诊断

默认不写诊断。设置 `QDM_HARNESS_DIAG=1` 后，hook 会向 `.claude/hooks/state/diagnostics/<session>.jsonl` 追加 context 发现诊断，核心字段包括：

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
