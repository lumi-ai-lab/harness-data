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

`context` 负责根据用户问题召回相关 `spec`、`routing`、`playbook` 文件清单；Agent 读取这些文件后判断取数路径、调用 `qdm-cmr-cli`、执行 `before-report-signal.py`。`posttool` 负责记录 Bash 取数模块状态，并在 signal 成功后只注入匹配 report 的 template 正文。

## 常用命令

重新编译正式入口：

```bash
go build -o bin/data-harness-cli ./cli/cmd/data-harness-cli
```

验证与调试：

```bash
./bin/data-harness-cli validate
./bin/data-harness-cli build-index
./bin/data-harness-cli context --question "华东区最近会员复购为什么下降？" --json
printf '{"prompt":"会员复购为什么下降？"}' | ./bin/data-harness-cli context --format claude-hook
printf '{"session_id":"debug","tool_name":"Bash","tool_input":{"command":"python3 .claude/hooks/before-report-signal.py member-overview"}}' | ./bin/data-harness-cli posttool --format claude-hook
./bin/data-harness-cli show member-repurchase --json
```

不再提供独立的 `data-harness-cli claude-hook` 子命令。

## 目录结构

- `.claude/settings.json`：注册 Claude Code hook，调用 `context --format claude-hook` 和 `posttool --format claude-hook`。
- `.claude/hooks/`：报告 signal 薄脚本。
- `.harness/index/`：由 `data-harness-cli build-index` 生成的机器索引。
- `bin/data-harness-cli`：正式运行使用的 Data Harness CLI。
- `cli/`：Data Harness CLI 源码和 Go 测试。
- `config/qdm-cli-paths.env`：集中维护 QDM CLI 绝对路径。
- `routing/`：Agent 读取后的取数路由规则。
- `playbooks/`：分析流程与必要证据来源。
- `spec/`：报告指标归属和业务知识权威说明。
- `templates/`：signal 成功后二阶段注入的报告骨架与输出约束。
- `tests/`：Python 集成测试。

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

`additionalContext` 只包含时间上下文、必须读取的 `contextFiles`、执行指令和约束；不会输出 `query_type=...`，也不会注入 spec、routing、playbook 或 template 正文。

## PostToolUse 输出

Claude hook 模式：

```bash
printf '{"session_id":"debug","tool_name":"Bash","tool_input":{"command":"python3 .claude/hooks/before-report-signal.py financial-overview"}}' \
  | ./bin/data-harness-cli posttool --format claude-hook
```

`posttool` 只处理 `Bash` 工具事件：

- 取数命令：记录对应 report 的必需模块，不输出 additionalContext。
- `before-report-signal.py <report_name>`：若模块缺失，输出缺失模块提醒。
- signal 满足：只注入该 report 对应的 `templates/*-report.md` 正文，不注入 spec、routing 或 playbook。

## 召回原则

- 根据 frontmatter `match.keywords` 召回相关文件。
- 命中某个 domain 的 index 时，加入该 index 的 `context.default_files`。
- 命中 index 的 `children.keywords` 时，加入 child path。
- 时间表达加入 `spec/common/time-policy.md`。
- 区域表达加入 `spec/common/area.md`。
- routing 和 playbook 按关键词及已召回 domain 加入，不由 hook 正则硬编码决定。
- 结果可以包含多个 domain；Agent 负责读取上下文后判断本轮实际取数路径。

## 运行约束

- 数值、同比、环比、排名、阈值必须来自 CLI 输出。
- 不得估算、补造或用示例数值替代缺失数据。
- 除非用户明确要求导出文件，否则不得写入报告文件。
- 必需取数完成后，下一步必须立即执行对应 `before-report-signal.py <report_name>`。
- signal 前禁止总结、整理报告素材、生成中间分析、输出阶段性结论。
- signal 前禁止读取、打开、猜测或使用任何 `templates/` 文件。
- signal 成功后只由 `posttool` 注入匹配 report 的 template 正文。

## 诊断

默认不写诊断。设置 `QDM_HARNESS_DIAG=1` 后，hook 会向 `.claude/hooks/state/diagnostics/<session>.jsonl` 追加 context 发现诊断，核心字段包括：

- `matched_domains`
- `context_files`
- `keyword_hits`
- `context_bytes`
- `before_report_signal`
- `template_path`
- `template_stats`

诊断不再使用 `report_name` / `injected_files` 表达 hook 预先判定的单一报告类型。
