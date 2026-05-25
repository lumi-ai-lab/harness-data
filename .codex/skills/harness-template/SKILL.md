---
name: harness-template
description: 用于 harness-data 项目中，把用户问题和一个报告模板/demo 串成完整 HARNESS 配置的项目级技能。适用于新增或改造模板、探索 CLI 取数路径、配置 spec/routing/playbook/intent/index、调整候选选择、验证 context 与 inject-template，最终让用户提问可以按模板生成报告。
---

# HARNESS Template

当用户提供或引用一个报告模板/demo，并希望 HARNESS 支持“用户提问 -> 取数 -> 注入模板 -> 生成报告”时，使用本技能。

标准链路：

`用户问题 -> context 召回 -> spec/routing/playbook -> CLI 取数 -> bin/data-harness-cli inject-template -> 模板正文注入 -> 最终报告`

## 硬性原则

- 在实际探索 CLI 之前，不要最终确定 playbook 的必要取数命令。
- CLI 探索必须包含 `--help` 和小样本真实调用，用来确认命令、参数、模块、返回字段是否可用。
- 正常报告生成阶段，在 `inject-template` 成功前不得读取或使用模板正文；配置 HARNESS 时可以编辑模板文件。
- 报告里的数值、同比、环比、排名、异常、根因必须来自 CLI 输出。
- demo 或本地样例报告只能用于抽象模板结构，不能作为数据源。
- 明确命中特定 child playbook 时，不要同时混入同 domain 的默认 playbook，除非用户问题确实要求多个报告。
- 改动范围优先局限在相关 domain/report；只有候选选择或路由机制需要时才改共享代码。

## 工作流程

### 1. 明确输入

先确认：

- 用户希望命中的问题表达。
- 模板/demo 来源文件。
- 所属 domain：通常是 `business`、`store`、`member`、`financial`。
- 最终模板路径。新增模板优先使用 `templates/<domain>/<report-name>.md`，文件名用 kebab-case。

先读相近文件和项目现状：

```bash
rg --files
sed -n '1,220p' spec/<domain>/index.md
sed -n '1,220p' playbooks/<domain>/index.md
sed -n '1,220p' routing/index.md
sed -n '1,240p' cli/internal/context/build.go
```

### 2. 抽象模板

把 demo 或已有报告改造成可复用模板：

- 删除示例数值、固定排名、固定日期、已发生结论和演示性根因。
- 保留稳定章节、表格结构和报告表达风格。
- 写明填充规则：CLI 未返回的指标行直接省略，不保留占位符，不估算。
- 写明指标归属和禁放规则。
- 写明所有事实必须来自 CLI 输出。

如果旧模板文件为空、路径不规范或会误导召回，且本次迁移已替代它，可以删除。

### 3. 梳理模板所需证据

在写 playbook 命令前，先列清楚模板到底需要什么数据：

- 核心指标和子指标。
- 维度证据：区域、品类、门店、会员分层、供应商、趋势、明细表等。
- 所需字段：当前值、同比、环比、排名、异常点、树结构、图表结构。
- 哪些是必要证据，哪些只是可选补充。

这份证据清单是后续 CLI 探索的依据。

### 4. 探索 CLI

这是强制步骤。目标是用真实命令找出“最短、有效、可复用”的取数路径。

先读取公共 CLI 规范和当前 domain 合同：

```bash
source config/qdm-cli-paths.env
sed -n '1,240p' spec/common/cmr-cli-readme.md
sed -n '1,220p' spec/<domain>/report-contract.md
```

探索候选命令帮助：

```bash
"$QDM_CMR_CLI" report <report> --help
"$QDM_CMR_CLI" report <report> <module> --help
```

然后用接近目标问题的小样本实际调用。每个候选模块都要确认：

- 是否支持目标时间过滤和指标/维度过滤参数。
- 返回的是原始数值、AI 摘要、树结构、图结构还是明细行。
- 是否覆盖模板字段，是否存在重复取数或过量上下文。
- `--ai` 是否能压缩上下文且不丢失必要事实。
- 是否真的需要额外 `table` 或明细命令，还是可作为可选补充。

只有探索确认后的最小命令集，才能写进 playbook 和 routing。若命令不存在、参数不支持或字段拿不到，应调整模板或取数方案，不要猜。

### 5. 新增或更新 Spec

创建 `spec/<domain>/<report-name>.md`：

```yaml
---
id: <domain>-<report-name>
kind: spec
domain: <domain>
title: <title>
tags:
  - report
  - metric
match:
  keywords:
    - <keyword>
---
```

内容应包括：

- 固定拆解链路。
- 指标归属表。
- 禁放规则。
- 缺失数据处理规则。
- 数据来源规则：只能来自 CLI。

更新 `spec/<domain>/index.md`：

- 增加 child path 和关键词。
- 必要时把关键词加入顶层 `match.keywords`，确保 domain 能被召回。
- 保持已有 `context.default_files` 不被破坏。

### 6. 新增或更新 Playbook

创建 `playbooks/<domain>/<report-name>.md`：

```yaml
---
id: playbook-<domain>-<report-name>
kind: playbook
domain: <domain>
title: <title>
tags:
  - playbook
match:
  keywords:
    - <keyword>
template: templates/<domain>/<report-name>.md
---
```

正文必须写清：

- 哪些用户问题命中，哪些不命中。
- 时间和筛选口径如何归一化。
- 必要 CLI 模块，必须来自 CLI 探索结果。
- 哪些命令可以并行。
- 门禁：必要模块全部成功后，下一步立即执行 `bin/data-harness-cli inject-template`。
- 异常处理：必要模块失败或模板注入失败时，不得生成最终报告。
- 证据规则和禁止使用 demo 数据。

更新 `playbooks/<domain>/index.md`，增加 child 和关键词。

### 7. 新增或更新 Routing

为专项报告创建 `routing/<domain>-<report-name>.md`，默认报告可更新已有 routing。

内容应包括：

- 固定 CLI family 和 report 名称。
- 经 CLI 探索确认的必要命令。
- 禁止的数据源或错误路由。
- `inject-template` 门禁。
- template 注入前禁止总结、整理素材、生成中间分析。

更新 `routing/index.md`，增加新报告意图行。

### 8. 必要时新增 Intent

当需要沉淀意图规范时，创建 `intents/<domain>-<report-name>.md`。

建议包含：

```yaml
query_type: <snake_case>
report: <report>
indicator: <optional indicator>
depth: <overview|deep_report|drill_report>
needs_clarification: false
```

### 9. 检查候选选择逻辑

新增同 domain 专项 playbook 时，检查 `cli/internal/context/build.go` 和相关测试。

期望行为：

- 明确命中专项 child：召回专项 playbook，不混入无关 default overview。
- 没有具体 child 命中：召回 domain 默认 overview。
- 多 domain 问题：保留多个真实命中的 domain 候选。
- domain routing 不应让泛问题召回所有专项 routing。

如修改候选逻辑，必须补测试。

### 10. 校验并构建索引

运行：

```bash
./bin/data-harness-cli validate
./bin/data-harness-cli build-index
```

如果改了 Go 代码，CLI 级测试前先重编：

```bash
go build -o bin/data-harness-cli ./cli/cmd/data-harness-cli
```

### 11. 验证 Context 和模板注入

专项问题：

```bash
./bin/data-harness-cli context --question "<专项问题>" --json
```

检查：

- 包含对应 spec。
- 包含对应 routing。
- 包含对应 playbook。
- 明确专项命中时，不包含无关 default playbook。
- session state 或 hook 测试中的 selected template 路径正确。

泛问题：

```bash
./bin/data-harness-cli context --question "<泛 domain 问题>" --json
```

检查：

- 仍命中默认 overview playbook。
- 不误召回新增专项 playbook。

还要补或更新 posttool 测试，确保执行：

```bash
bin/data-harness-cli inject-template
```

时注入的是新模板正文，而不是默认模板。

### 12. 回归测试

运行相关测试：

```bash
go test ./cli/...
python3 -m unittest tests/test_qdm_harness_context.py
```

如果系统没有 `python`，使用 `python3`。

### 13. 交付说明

最终回复用户时简要说明：

- 新增文件和关键更新文件。
- CLI 探索结论：最终必要命令是什么，为什么这样选。
- context 候选选择行为。
- 已运行的验证和测试结果。
- 哪些 demo/源文件被保留或删除。

保持简洁，重要文件用可点击路径链接。
