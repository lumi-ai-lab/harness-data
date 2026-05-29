# 多指标组合 Template 方案

## 背景

这份方案最初是在 Git 子模块重构前编写的，当时默认 `spec / routing / playbooks / templates` 都直接位于 HARNESS 主仓库根目录。现在项目已经完成结构调整：

- HARNESS 主仓库负责工程化实现：CLI、hook、session state、索引构建、路径解析、配置和测试。
- `wikis/` 作为业务知识库根目录，可以由 Git submodule 独立管理。
- 业务逻辑和报告约束位于 `wikis/spec`、`wikis/routing`、`wikis/playbooks`、`wikis/templates`。
- `config/harness-config.yaml` 负责把逻辑路径映射到物理路径：

```yaml
paths:
  spec: wikis/spec
  routing: wikis/routing
  playbooks: wikis/playbooks
  templates: wikis/templates
```

因此，多指标组合 template 的方案需要更新。核心变化不是“路径前面加 `wikis/`”，而是要保持 HARNESS 工程能力和业务知识库的边界清晰：

- 主仓库只实现组合模式的识别、状态记录、路径解析、注入校验和测试。
- 组合模板、指标关系、业务归因口径仍属于 `wikis/` 子模块管理。
- frontmatter 和 session 中应优先保存逻辑路径，例如 `templates/...`、`playbooks/...`；CLI 再解析到 `wikis/...` 物理路径。

## 问题定义

当前 Harness 在用户问题命中单个完整链路时，流程比较清晰：

- `spec` 提供指标口径、业务归属和规则约束。
- `routing` 提供取数路由判断。
- `playbook` 指导 CLI 取数和证据准备。
- `template` 规定最终报告结构。

当用户同时询问 A 指标和 B 指标，并且两个指标都具备完整的 `spec / routing / playbook / template` 链路时，取数阶段可以分别按多个 playbook 完成；主要问题出现在 template 阶段：

- 如果注入多个单指标 template，章节可能重复，约束可能冲突，最终报告结构不稳定。
- 如果强行选择其中一个单指标 template，另一个指标容易被降级为补充信息。
- 如果因为多个 playbook candidate 直接进入 ambiguous 状态，无法覆盖真实的多指标业务问题。

因此推荐引入“多指标组合 template”机制。

## 核心思路

多指标问题不再强行选择 A 或 B 的单指标 template，而是路由到一个统一的组合分析 template。

职责划分如下：

- 多个 `spec`：分别提供各指标口径、业务归属和限制规则。
- 多个 `routing`：分别辅助判断每个指标的取数入口。
- 多个 `playbook`：分别指导每个指标需要执行哪些 CLI 取数。
- 一个 `composite template`：统一规定最终多指标报告的结构、表达顺序和综合判断方式。

关键原则：

> 不拼接多个单指标 template，而是用一个面向“多指标问题”的组合 template 输出一份综合报告。

在子模块重构后的边界下，还需要增加一条原则：

> 组合模式是 HARNESS 主仓库的工程能力；组合模板内容是 `wikis/` 子模块的业务资产。

## 路径和边界设计

组合模板建议放在业务知识库内，例如：

```text
templates/common/multi-metric-report.md
templates/cmr/business/multi-metric-report.md
templates/idx/business-manager/multi-metric-report.md
```

这些是逻辑路径。当前配置下实际文件会位于：

```text
wikis/templates/common/multi-metric-report.md
wikis/templates/cmr/business/multi-metric-report.md
wikis/templates/idx/business-manager/multi-metric-report.md
```

实现时不应在 session 或 frontmatter 中写死 `wikis/templates/...`。原因：

- 主仓库支持 `config/harness-config.yaml` 改变知识库物理位置。
- 旧结构仍可兼容 `templates/...` 根目录。
- 业务知识库作为 submodule 后，物理路径属于部署配置，不应污染业务文档引用。

推荐约定：

- `frontmatter.template` 保存逻辑路径：`templates/...`。
- `PlaybookCandidate.Path` 可以使用 context 输出中的可读物理路径：当前为 `wikis/playbooks/...`。
- `SelectedTemplate` 保存逻辑路径：`templates/...`。
- 注入时通过 `PathResolver.Resolve()` 解析到实际文件。

## 推荐报告结构

组合 template 不应该简单复制单指标模板章节，而应该围绕“多个指标共同回答一个业务问题”设计。

建议基础结构如下：

```markdown
# 多指标分析报告模板

## 1. 结论摘要

- 分别说明 A、B 指标当前表现。
- 明确两者是否同向、背离、互相解释。
- 给出最关键的业务判断。

## 2. 指标表现对比

- A 指标：当前值、同比、环比、排名、异常点。
- B 指标：当前值、同比、环比、排名、异常点。
- 对比：谁变化更明显，是否发生同步变化。

## 3. 拆解分析

- 按区域、品类、门店、时间趋势等共同维度拆解。
- 找出两个指标共同异常的维度。
- 找出只影响 A 或只影响 B 的维度。

## 4. 关系判断

- A 变化是否能解释 B 变化。
- 是否存在量价、客单客数、收入利润等业务关系。
- 如果不能解释，明确说明证据不足或需要补充取数。

## 5. 建议动作

- 针对共同问题给建议。
- 针对 A、B 各自问题给建议。
```

## 组合 Template 类型

不建议一开始为每两个指标都创建一个专属组合模板，否则会出现组合爆炸。

建议先沉淀少量通用组合模板：

### 1. 同域多指标概览模板

适用问题：

- “A 和 B 最近怎么样？”
- “帮我看看 A 指标和 B 指标的情况。”
- “A、B、C 这几个指标表现如何？”

分析重点：

- 并列呈现多个指标表现。
- 找共同异常。
- 判断变化方向是否一致。

### 2. 指标关系分析模板

适用问题：

- “A 下降是不是因为 B？”
- “A 和 B 有什么关系？”
- “B 是否拖累了 A？”
- “A 的变化会不会影响 B？”

分析重点：

- 判断指标之间是否存在业务解释链路。
- 明确相关、因果、贡献或证据不足。
- 典型关系包括销售额、客数、客单价、利润额、利润率等。

### 3. 多指标对比归因模板

适用问题：

- “A 和 B 为什么都下降？”
- “哪些区域导致 A、B 变差？”
- “A 和 B 的变化主要来自哪些品类？”

分析重点：

- 共同维度拆解。
- 找共同拖累项和差异拖累项。
- 输出归因判断。

## 路由规则建议

当用户问题命中两个或多个完整 playbook candidate 时，先判断是否属于多指标组合问题。

建议规则：

```text
如果命中 >= 2 个完整 playbook candidate：
  如果多个 candidate 属于同一业务域或存在明确业务关系：
    如果用户问题是并列问法：
      选择 multi-metric-overview template
    如果用户问题包含“关系 / 是否因为 / 影响 / 带动 / 拖累”：
      选择 metric-relation template
    如果用户问题包含“为什么 / 原因 / 归因 / 哪些区域 / 哪些品类”：
      选择 multi-metric-attribution template
  否则：
    保持 ambiguous，要求 Agent 先读 contextFiles 后选择或转 free_analysis
否则：
  走单指标 selected playbook/template
```

示例：

```text
“销售额和客单价最近怎么样？”
=> composite_overview

“销售额下降是不是因为客单价下降？”
=> composite_relation

“销售额和毛利率为什么都下降？”
=> composite_attribution
```

这里的“同一业务域”不应通过字符串路径硬编码判断，而应优先使用 frontmatter 中的 `domain`、`kind`、`template` 等结构化字段。

## Session 数据结构建议

当前 session 偏向单选：

```go
const (
  ModeTemplateReport = "template_report"
  ModeFreeAnalysis   = "free_analysis"
)

SelectedPlaybook string
SelectedTemplate string
PlaybookCandidates []PlaybookCandidate
```

建议扩展为支持组合模式：

```go
const (
  ModeTemplateReport = "template_report"
  ModeFreeAnalysis   = "free_analysis"
  ModeCompositeReport = "composite_report"
)

SelectedPlaybook string
SelectedTemplate string

SelectedPlaybooks []PlaybookCandidate
PlaybookCandidates []PlaybookCandidate

Composite *CompositeSelection

type CompositeSelection struct {
  Type string // overview, relation, attribution
  Metrics []string
  Domain string
}
```

设计要点：

- 保留 `SelectedPlaybook`，避免破坏单指标稳定路径。
- 新增 `SelectedPlaybooks`，只在 `composite_report` 模式使用。
- `SelectedTemplate` 仍然只保留一个，且必须是逻辑路径 `templates/...`。
- `PlaybookCandidate.Path` 可以继续记录 context 输出中的路径，便于 Agent 直接读取。
- 多个 playbook 解决“怎么取数”。
- 一个 composite template 解决“怎么写报告”。

这样比“多个 template 一起注入”更稳定，也更符合子模块重构后的职责边界。

## Context 和索引影响

当前 `build-index` 扫描的是配置后的知识库目录：

- `spec` 逻辑目录解析到 `wikis/spec`
- `routing` 逻辑目录解析到 `wikis/routing`
- `playbooks` 逻辑目录解析到 `wikis/playbooks`

组合模式不要求主仓库把业务关系写死在 Go 代码里。更合理的方式是：

- `wikis/playbooks/...` 的 frontmatter 继续声明单指标 `template`。
- `wikis/templates/...` 新增组合模板。
- 如需让组合选择更稳定，可以在 `wikis/routing` 或 playbook frontmatter 中补充组合关系元数据。
- 主仓库只消费结构化元数据，不维护具体指标之间的业务关系表。

短期最小版本可以先只利用已有候选结果：

- `PlaybookCandidates` 数量大于等于 2。
- 候选项属于同一 `domain`。
- 用户问法包含并列、关系或归因信号。
- 选择一个默认 composite template。

中长期再把组合关系沉淀到 `wikis/` 子模块中。

## PostToolUse 注入逻辑建议

`inject-template` 阶段建议增加 composite mode 分支：

```text
如果 Mode == composite_report：
  校验 SelectedPlaybooks 非空，且至少 2 个。
  校验 SelectedTemplate 非空。
  校验 SelectedTemplate 使用逻辑路径 templates/...
  通过 PathResolver 解析模板实际位置。
  校验模板文件存在，且不是目录。
  注入 SelectedTemplate。
  在 additionalContext 中说明本轮是多指标组合分析。
否则：
  保持当前单指标 selected playbook/template 逻辑。
```

注入时可以附带类似提示：

```text
本轮是多指标组合分析。
已选 playbooks:
- wikis/playbooks/idx/business-manager/s-sale-amt.md
- wikis/playbooks/idx/business-manager/s-per-cust-amt.md

最终必须按 composite template 输出，不得分别套用单指标 template。
```

注意：这里展示的是 Agent 可直接读取的物理路径；`SelectedTemplate` 仍建议保存为 `templates/...` 逻辑路径。

## 落地步骤

### 第一步：在 wikis 子模块新增通用组合 Template

先新增一个通用组合模板，例如：

```text
wikis/templates/common/multi-metric-report.md
```

或先按当前主要业务域落地：

```text
wikis/templates/idx/business-manager/multi-metric-report.md
```

初期先覆盖同域多指标问题，不急于拆分 overview、relation、attribution 三类模板。

### 第二步：扩展 Session

在主仓库 `cli/internal/sessionstate/state.go` 中增加：

- `ModeCompositeReport`
- `SelectedPlaybooks []PlaybookCandidate`
- `Composite *CompositeSelection`

保留当前单指标字段，避免影响现有稳定路径。

### 第三步：扩展 Context 候选选择

在 context 构建或 session 初始化阶段，当发现多个有效 playbook candidate 时：

- 不再直接把所有多候选都视为无法处理。
- 先判断是否满足同域多指标组合条件。
- 满足时写入 `ModeCompositeReport`、`SelectedPlaybooks` 和组合 `SelectedTemplate`。
- 不满足时保持当前 ambiguous 行为。

### 第四步：扩展 inject-template

让 `posttool` 在 `Mode == composite_report` 时注入组合 template，而不是报 ambiguous playbook candidates。

同时保持当前逻辑：

- `free_analysis` 不注入 template。
- 单指标 `template_report` 只注入 selected playbook 绑定的单一 template。
- 重复注入仍只允许一次。

### 第五步：补充测试

建议覆盖：

- 单指标问题仍然注入原单指标 template。
- 两个同域指标命中时进入 `composite_report`。
- `composite_report` 注入唯一 composite template。
- 多个 playbook 但不满足组合条件时仍给出 ambiguous 提示。
- `SelectedTemplate` 不是 `templates/...` 逻辑路径时拒绝注入。
- 配置为 `wikis/templates` 时，可以从逻辑路径正确解析到物理文件。
- 重复 `inject-template` 时仍然只注入一次。

## 推荐优先级

短期建议先做最小可用版本：

1. 在 `wikis/templates/...` 新增一个通用 `multi-metric-report.md`。
2. 主仓库新增 `composite_report` session 模式。
3. 支持同域多指标进入 `composite_report`。
4. `SelectedPlaybooks` 多选，`SelectedTemplate` 单选。
5. `inject-template` 注入唯一 composite template。

后续再根据真实问题量，把通用组合模板拆成：

- `multi-metric-overview-report.md`
- `metric-relation-report.md`
- `multi-metric-attribution-report.md`

## 结论

需要更新这份方案文档。

子模块重构后，方案的核心仍然成立：多指标问题应该注入一个组合 template，而不是拼接多个单指标 template。但实现边界必须调整：

- HARNESS 主仓库负责组合模式的工程实现。
- `wikis/` 子模块负责组合模板和业务关系沉淀。
- session 和 frontmatter 尽量使用 `templates/...` 等逻辑路径。
- 物理路径 `wikis/...` 只由配置和 `PathResolver` 解析。

这个调整可以避免多指标方案重新把工程实现和业务知识库耦合在一起。
