# Data Harness Context Hook 统一方案

## 背景

当前 `data-harness-cli` 已经承担两个相关职责：

- `context`：根据用户问题返回相关 `spec` / `routing` / `playbook` 文件。
- `claude-hook`：适配 Claude Code `UserPromptSubmit` 协议，把 `context` 结果包装为 `additionalContext`。

这两个命令本质上都围绕“上下文发现”。`claude-hook` 不是独立业务能力，只是 `context` 的一种输入输出格式。

同时，当前 `claude-hook` 仍保留了一些旧流程痕迹：

- 先用正则识别固定 report 类型。
- 输出 `query_type=...`。
- 诊断字段仍围绕 `report_name`。

这会让链路看起来像“CLI 先决定业务类型”，而不是“CLI 找上下文，Agent 基于上下文判断取数路径”。

## 目标

把 Harness 调整为更纯粹的上下文发现链路：

```text
用户问题
  -> data-harness-cli context --format claude-hook
  -> 返回 contextFiles / constraints / instruction
  -> Agent 读取 contextFiles
  -> Agent 基于 spec / routing / playbook 判断取数方式
  -> Agent 调用 qdm-cmr-cli
  -> data-harness-cli posttool --format claude-hook 记录 Bash 取数模块
  -> signal 后只注入匹配 template
  -> 输出最终报告
```

核心原则：

- 业务知识维护在 `spec` / `routing` / `playbook` 正文里。
- CLI 只负责找到相关上下文，不负责业务取数决策。
- Agent 读取上下文后判断怎么取数、怎么算、是否需要 signal/template。
- Claude hook 只是 `context` 的一种格式，不再作为独立子命令。
- PostToolUse 由 `posttool --format claude-hook` 处理，只在 signal 满足后注入匹配 template，不注入 spec / routing / playbook。

## 命令设计

保留 `context` 作为唯一上下文入口：

```bash
data-harness-cli context --question "会员复购为什么下降？" --json
```

用于人工调试和测试，输出普通结构化 JSON。

新增 Claude hook 输出格式：

```bash
data-harness-cli context --format claude-hook
```

用于 `.claude/settings.json` 的 `UserPromptSubmit` hook。该模式下：

- 从 stdin 读取 Claude Code 传入的 JSON。
- 从 `prompt` 字段取用户问题。
- 调用同一套 context 选择逻辑。
- 输出 Claude Code 需要的 `hookSpecificOutput.additionalContext`。

更新 hook 配置：

```json
{
  "type": "command",
  "command": "\"$CLAUDE_PROJECT_DIR/bin/data-harness-cli\" context --format claude-hook"
}
```

删除独立命令：

```bash
data-harness-cli claude-hook
```

## 输出设计

### 普通 JSON 模式

保持当前结构：

```json
{
  "question": "会员复购为什么下降？",
  "contextFiles": [
    {
      "path": "spec/member/index.md",
      "reason": "keyword: 会员"
    },
    {
      "path": "spec/member/repurchase.md",
      "reason": "keyword: 复购"
    }
  ],
  "instruction": "Read all contextFiles before running data CLI. Do not read templates before before-report-signal succeeds.",
  "constraints": [
    "values_must_come_from_cli",
    "do_not_estimate_missing_values",
    "do_not_write_report_file_unless_requested",
    "do_not_read_template_before_signal"
  ]
}
```

### Claude hook 模式

输出：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

`additionalContext` 只包含：

```text
# Data Harness Context

时间上下文 JSON：...

必须先读取以下 contextFiles：
- spec/...
- routing/...
- playbooks/...

读取完 contextFiles 后，再判断取数路径并执行数据 CLI。

Constraints:
- values_must_come_from_cli
- do_not_estimate_missing_values
- do_not_write_report_file_unless_requested
- do_not_read_template_before_signal
```

不再输出：

```text
query_type=business_overview
query_type=store_overview
query_type=member_overview
query_type=financial_overview
```

## Context 选择逻辑调整

当前逻辑仍然倾向于先选单一 domain/report。后续应改成“相关文件召回”：

1. 根据 frontmatter `match.keywords` 命中文件。
2. 命中某个 domain 的 index 时，加入该 index 的 `context.default_files`。
3. 命中 `children.keywords` 时，加入 child path。
4. 时间表达命中时加入 `spec/common/time-policy.md`。
5. 区域表达命中时加入 `spec/common/area.md`。
6. routing / playbook 也只按关键词和 frontmatter 召回，不由硬编码 report 正则决定。

返回结果可以包含多个 domain 的上下文。Agent 负责读取后判断本轮真正的取数路径。

## 诊断字段调整

当前诊断字段：

```json
{
  "report_name": "member-overview",
  "injected_files": [...]
}
```

建议改为：

```json
{
  "matched_domains": ["member"],
  "context_files": [...],
  "keyword_hits": [...],
  "context_bytes": 1234
}
```

这样诊断更贴近“上下文发现”，不再暗示 CLI 先决定 report。

## 文件与代码改造项

需要改动：

- `cli/cmd/data-harness-cli/main.go`
  - 删除 `claude-hook` case。
  - 给 `context` 增加 `--format` 参数。
  - `--format json` 输出普通 JSON。
  - `--format claude-hook` 读取 stdin 并输出 Claude hook JSON。

- `cli/internal/claudehook/`
  - 改名或合并到 `cli/internal/context`.
  - 移除 report 正则识别。
  - 保留 Claude hook 输入输出包装。

- `cli/internal/context/build.go`
  - 从“单 domain/report 选择”调整为“多文件相关召回”。
  - 不输出 query_type。

- `.claude/settings.json`
  - 改为：
    ```json
    "\"$CLAUDE_PROJECT_DIR/bin/data-harness-cli\" context --format claude-hook"
    ```

- `README.md`
  - 更新流程说明。
  - 删除 `claude-hook` 独立命令描述。

- `tests/test_qdm_harness_context.py`
  - 改为测试 `context --format claude-hook`。
  - 移除 `query_type=...` 断言。
  - 增加多上下文召回断言。

- `cli/tests/context_test.go`
  - 覆盖普通 JSON 模式。
  - 覆盖 `--format claude-hook` 或内部 hook formatter。

## 推荐实施步骤

1. 给 `context` 增加 `--format` 参数，先兼容 `json` 和 `claude-hook`。
2. 把 `claude-hook` 子命令改为临时别名，内部转调 `context --format claude-hook`。
3. 改 `.claude/settings.json` 使用新命令。
4. 移除 `query_type` 输出和 report 正则识别。
5. 调整 context 召回逻辑为多文件相关召回。
6. 更新 README 和测试。
7. 重新编译 `bin/data-harness-cli`。
8. 运行验证：

```bash
./bin/data-harness-cli validate
./bin/data-harness-cli context --question "会员复购为什么下降？" --json
printf '{"prompt":"会员复购为什么下降？"}' | ./bin/data-harness-cli context --format claude-hook
go test ./...
python3 -m unittest discover -s tests
```

## 最终期望

改造后概念收敛为：

```text
context = 上下文发现核心能力
--format json = 调试 / 测试输出
--format claude-hook = Claude Code hook 输出
```

不再有单独的 `claude-hook` 命令，也不再让 CLI 承担固定 report 类型识别职责。
