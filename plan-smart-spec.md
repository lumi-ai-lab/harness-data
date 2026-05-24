# Data Harness Smart Spec 方案

## 目标

当前 Harness 在取数前会注入完整 `spec`、`routing`、`playbook` 等上下文。这个方式在业务域少的时候可控，但后续指标和业务问题变多后，会造成上下文膨胀、无关规则干扰、检索不可测试等问题。

本方案目标是把 Harness 改造成：

```text
用户问题
  -> data-harness-cli 生成结构化 context
  -> Agent 按 contextFiles 读取必要 Spec / routing / playbook
  -> Agent 调用 CMR CLI 取数
  -> signal 后读取 template
  -> 输出最终答案
```

核心原则：

- Spec 仍然是业务知识权威来源。
- 不再全量注入所有 Spec。
- 不使用 BM25，不使用 embedding。
- 本期完成 Spec 文档迁移，不保留旧全文注入兼容模式。
- `index.md` 负责人类导航，frontmatter 负责机器检索。
- CLI 指令风格尽量对齐 OpenSpec，便于理解和对比。

## 参考项目启发

### Trellis / Typeless

启发：用 `index.md` 做 Spec 导航，不把所有 Spec 一次性放进上下文。

对应到本项目：

```text
spec/<domain>/index.md
```

用于说明该业务域下有哪些具体 Spec、什么时候读、哪些是默认规则。

### OpenSpec

启发：CLI 是中控器。Agent 不自己猜该读哪些文件，而是调用 CLI 获取 `contextFiles` 和下一步指令。

对应到本项目：

```bash
data-harness-cli context --question "..."
```

返回：

```json
{
  "contextFiles": [
    "spec/member/index.md",
    "spec/member/repurchase.md",
    "routing/member-overview.md"
  ],
  "instruction": "Read contextFiles before running CMR CLI."
}
```

### superpowers

启发：只预加载元信息，正文按需读取。大文档只要不读取，就不占上下文。

对应到本项目：

```text
frontmatter / index / generated index
```

先用于检索；真正命中的文档才进入上下文。

## CLI 命名

CLI 名称：

```bash
data-harness-cli
```

不使用 `qdm-context`。这个名字更贴近项目定位，也方便未来支持更多业务域和更多数据工具。

## CLI 指令设计

命令尽量对齐 OpenSpec 的习惯，但保留本项目更直观的命名。本期只保留必要命令：`build-index`、`context`、`validate`、`show`。不设计 `init`，也不设计 runtime 目录。

### build-index

扫描 `spec/`、`routing/`、`playbooks/` 的 frontmatter，生成机器索引。

```bash
data-harness-cli build-index
data-harness-cli build-index --json
```

生成：

```text
.harness/index/spec-index.json
.harness/index/routing-index.json
.harness/index/playbook-index.json
```

本期索引使用 JSON，不使用 JSONL。索引是结构化对象，需要包含文件列表、按 domain/keyword/id 的反向映射；JSON 更适合一次性加载、校验和调试。本期索引只基于结构化 frontmatter 和明确关键词，不做 BM25/embedding。

### context

核心命令。根据用户问题返回本轮应读取的上下文文件和下一步指令。

```bash
data-harness-cli context --question "华东区最近会员复购为什么下降？" --json
```

返回示例：

```json
{
  "question": "华东区最近会员复购为什么下降？",
  "contextFiles": [
    {
      "path": "spec/member/index.md",
      "reason": "domain: member"
    },
    {
      "path": "spec/member/repurchase.md",
      "reason": "keyword: 复购"
    },
    {
      "path": "spec/common/time-policy.md",
      "reason": "time expression: 最近"
    },
    {
      "path": "spec/common/area.md",
      "reason": "area expression: 华东区"
    },
    {
      "path": "routing/member-overview.md",
      "reason": "domain routing: member"
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

说明：

- 不返回 `confidence` 字段。
- 不做概率化置信度。
- `reason` 必须可解释，来自明确规则：domain、keyword、metric、scenario、default、routing。
- 如果 `.harness/index/*.json` 不存在或落后于源文件，`context` 可以自动触发 `build-index`，避免 hook 因忘记手动构建索引而失败。

### validate

校验所有 frontmatter 和索引引用。

```bash
data-harness-cli validate
data-harness-cli validate --json
```

校验范围：

- `spec/**/*.md`
- `routing/**/*.md`
- `playbooks/**/*.md`

校验内容：

- `id` 是否唯一。
- `kind` 是否合法。
- `domain` 是否合法。
- `tags` 是否为数组。
- `match.keywords` 是否为数组。
- `context.default_files` 引用是否存在。
- `children.path` 引用是否存在。

### show

查看某个索引项或文件的解析结果。

```bash
data-harness-cli show spec/member/repurchase.md --json
data-harness-cli show member-repurchase --json
```

用于调试某个 Spec 为什么能被检索。

## 推荐目录结构

```text
harness-data/
├── cli/
│   ├── go.mod
│   ├── go.sum
│   │
│   ├── cmd/
│   │   └── data-harness-cli/
│   │       └── main.go
│   │
│   ├── internal/
│   │   ├── harness/
│   │   │   ├── paths.go
│   │   │   └── types.go
│   │   │
│   │   ├── frontmatter/
│   │   │   ├── parse.go
│   │   │   └── validate.go
│   │   │
│   │   ├── index/
│   │   │   ├── build.go
│   │   │   ├── load.go
│   │   │   └── query.go
│   │   │
│   │   └── context/
│   │       ├── build.go
│   │       └── match.go
│   │
│   └── tests/
│       ├── build_index_test.go
│       ├── context_test.go
│       └── validate_test.go
│
├── .harness/
│   └── index/
│       ├── spec-index.json
│       ├── routing-index.json
│       └── playbook-index.json
│
├── spec/
│   ├── common/
│   ├── business/
│   ├── store/
│   ├── member/
│   └── financial/
│
├── routing/
├── playbooks/
├── templates/
├── .claude/hooks/
├── scripts/
└── tests/
```

目录边界：

- `cli/`：`data-harness-cli` 的 Go 实现和测试，作为独立 Go module 管理。
- `spec/`、`routing/`、`playbooks/`：业务知识源，由 CLI 读取。
- `.harness/index/`：项目级生成索引，放在仓库根目录，不放进 `cli/`。
- `.claude/hooks/`：Agent 入口，负责调用 `data-harness-cli context`。

## Frontmatter 设计原则

frontmatter 只保留检索和校验必要字段，不放冗余业务正文。

统一字段：

```yaml
id: string
kind: spec | spec_index | routing | playbook | playbook_index
domain: common | business | store | member | financial
title: string
tags: string[]
match:
  keywords: string[]
```

字段说明：

- `id`：唯一标识，用于索引和调试。
- `kind`：文档类型。
- `domain`：业务域。
- `title`：人可读标题。
- `tags`：稳定标签，例如 `report`、`cli`、`time`、`area`、`repurchase`。
- `match.keywords`：明确关键词，用于本期检索。

不设计 `rules.severity`、`applies_before_cli`、`applies_before_report`。

原因：

- 这些字段意图是表达规则重要性和适用阶段。
- 但本项目当前所有被 `context` 召回的 Spec 都默认必须在取数和报告生成时遵守。
- 再增加这些字段会造成维护负担和解释成本。
- 如果未来确实需要阶段化规则，再单独设计。

## Spec frontmatter

具体 Spec 示例：

```md
---
id: member-repurchase
kind: spec
domain: member
title: 会员复购规则
tags:
  - report
  - metric
  - repurchase
match:
  keywords:
    - 复购
    - 会员复购率
    - 复购会员数
    - 老客
---

# 会员复购规则
```

目录级 `index.md` 示例：

```md
---
id: member-index
kind: spec_index
domain: member
title: 用户运营 Spec Index
tags:
  - index
  - user-report
match:
  keywords:
    - 用户
    - 会员
    - 用户运营
context:
  default_files:
    - spec/member/report-contract.md
    - spec/member/category-unsupported.md
children:
  - path: spec/member/repurchase.md
    keywords:
      - 复购
      - 会员复购率
  - path: spec/member/retention.md
    keywords:
      - 留存
      - 流失
      - 休眠
---

# 用户运营 Spec Index
```

额外字段：

- `context.default_files`：命中该业务域后默认需要读取的关键规则。
- `children`：该目录下具体 Spec 的导航关系。

这两个字段只用于 `kind: spec_index`。

## Routing frontmatter

routing 也需要轻量 frontmatter，使 `data-harness-cli` 能把 routing 纳入 `contextFiles`。

示例：

```md
---
id: routing-member-overview
kind: routing
domain: member
title: 用户运营路由规则
tags:
  - routing
  - user-report
match:
  keywords:
    - 用户
    - 会员
    - 活跃用户
    - 会员复购
---

# 用户运营深度报告路由
```

routing frontmatter 不放 CLI 命令细节。CLI 命令仍然写在正文里，因为这部分需要人类可读、可 review。

## Playbook frontmatter

playbook 不再使用“高置信度”这种概念。本期不做置信度计算。

playbook 是否被返回，依据明确规则：

- 用户问题命中该 playbook 的 `match.keywords`。
- 或命中某个 `spec_index.children` 后，该业务域 index 指向需要的 playbook。
- 或该 playbook 是对应业务域的默认 playbook index。

示例：

```md
---
id: playbook-member-overview
kind: playbook
domain: member
title: 用户运营默认取数 Playbook
tags:
  - playbook
  - user-report
match:
  keywords:
    - 用户报表
    - 用户运营
    - 会员分析
---

# 用户运营默认取数 Playbook
```

如果需要 playbook index：

```md
---
id: playbook-member-index
kind: playbook_index
domain: member
title: 用户运营 Playbook Index
tags:
  - index
  - playbook
match:
  keywords:
    - 用户
    - 会员
children:
  - path: playbooks/member/default-overview.md
    keywords:
      - 用户报表
      - 用户运营
  - path: playbooks/member/region-drilldown.md
    keywords:
      - 区域
      - 华东
      - 管理区域
---

# 用户运营 Playbook Index
```

## 本期明确不做

本期不做以下能力：

- 不做 BM25。
- 不做 embedding。
- 不做指标元数据生成 CLI。
- 不做 `catalog/generated/metrics.json`。
- 不做基于 CLI 输出的 learned override。
- 不保留旧的全文注入兼容模式。

这些能力后续可以单独设计，但不进入本期方案。

## 本期必须完成

本期范围包括：

1. 新增 `data-harness-cli`。
2. 完成 `build-index`、`context`、`validate`、`show`。
3. 完成所有现有 Spec 文档迁移。
4. 为所有 Spec 文件添加必要 frontmatter。
5. 将大 Spec 拆成按业务域组织的 `index.md + topic spec`。
6. 为所有 routing 文件添加轻量 frontmatter。
7. 为 playbook 添加必要 frontmatter；必要时拆成 index + topic playbook。
8. 改造 `.claude/hooks/qdm-harness-context.py`，直接使用 `data-harness-cli context`。
9. 删除旧的“append 完整 Spec / Playbook”注入路径。
10. 更新测试，验证 contextFiles 选择和 hook 输出。

## 现有文件迁移

### Spec

当前：

```text
spec/business-report.md
spec/store-report.md
spec/member-report.md
spec/financial-report.md
spec/cmr-cli-readme.md
spec/qdm-time-policy.md
```

迁移为：

```text
spec/common/
  index.md
  time-policy.md
  cmr-cli-readme.md
  cli-safety.md

spec/business/
  index.md
  report-contract.md
  core-indicators.md
  area-category-trend.md

spec/store/
  index.md
  report-contract.md
  scale-health.md
  profit-efficiency.md

spec/member/
  index.md
  report-contract.md
  repurchase.md
  retention.md
  channel-touch.md
  category-unsupported.md

spec/financial/
  index.md
  report-contract.md
  income-cost-profit.md
```

迁移要求：

- 本期完成，不分阶段保留旧文件。
- 旧文件内容迁移后删除或改为指向新位置的短索引，不再作为注入正文来源。
- 每个新文件必须有 frontmatter。

### Routing

当前：

```text
routing/business-overview.md
routing/store-overview.md
routing/member-overview.md
routing/financial-overview.md
routing/index.md
routing/qdm-cli-routing.md
```

迁移要求：

- 保留现有正文内容。
- 给每个 routing 文件增加 routing frontmatter。
- `data-harness-cli build-index` 生成 `routing-index.json`。
- `context` 必须能返回相关 routing 文件。

### Playbooks

当前：

```text
playbooks/business-overview-analysis.md
playbooks/store-overview-analysis.md
playbooks/member-overview-analysis.md
playbooks/financial-overview-analysis.md
```

可迁移为：

```text
playbooks/business/index.md
playbooks/business/default-overview.md
playbooks/store/index.md
playbooks/store/default-overview.md
playbooks/member/index.md
playbooks/member/default-overview.md
playbooks/financial/index.md
playbooks/financial/default-overview.md
```

如果暂时不拆，也必须为现有 playbook 文件添加 frontmatter。

## Hook 改造

当前 hook：

```text
.claude/hooks/qdm-harness-context.py
```

目标行为：

```text
1. 解析用户 prompt 和时间。
2. 调用：
   data-harness-cli context --question <prompt> --json
3. 输出 additionalContext：
   - 时间解析 JSON
   - context 返回的 contextFiles
   - 必须读取 contextFiles 的指令
   - constraints
4. 不再 append 完整 Spec / Playbook 正文。
```

开发期可以直接从仓库根目录调用：

```bash
go run ./cli/cmd/data-harness-cli context --question "<prompt>" --json
```

正式使用时建议编译或安装为：

```bash
data-harness-cli context --question "<prompt>" --json
```

hook 输出示例：

```text
# Data Harness Instructions

时间解析 JSON：...

必须先读取以下 contextFiles：
- spec/member/index.md
- spec/member/repurchase.md
- spec/common/time-policy.md
- routing/member-overview.md

读取完 contextFiles 后，再执行 CMR CLI。

Constraints:
- values_must_come_from_cli
- do_not_estimate_missing_values
- do_not_write_report_file_unless_requested
- do_not_read_template_before_signal
```

## 测试要求

新增 Go 测试：

```text
cli/tests/build_index_test.go
cli/tests/context_test.go
cli/tests/validate_test.go
```

更新 Python hook 测试：

```text
tests/test_qdm_harness_context.py
tests/test_business_report_hooks.py
tests/test_store_report_hooks.py
tests/test_member_report_hooks.py
tests/test_financial_report_hooks.py
```

必须覆盖：

- `build-index` 能扫描 spec/routing/playbook frontmatter。
- `validate` 能发现缺失 `id`、重复 `id`、非法 `kind`、失效路径。
- “会员复购”问题返回 member index、repurchase spec、member routing。
- “门店净利润”问题不返回 member spec。
- “全品类用户报表”返回 member category unsupported 规则。
- hook 不再输出完整 Spec 正文。
- signal 前仍不注入 template。

## 最终结构

```text
data-harness-cli
  -> build-index
  -> context
  -> validate

frontmatter
  -> spec index
  -> routing index
  -> playbook index

hook
  -> calls data-harness-cli context
  -> injects contextFiles list

Agent
  -> reads contextFiles
  -> runs CMR CLI
  -> waits for signal template
```

最终目标是让 Harness 从：

```text
命中意图 -> 注入固定大上下文
```

变成：

```text
用户问题 -> CLI context -> contextFiles -> 按需读取
```

这样可以减少上下文冗余，提高业务规则选择的可解释性、可测试性和长期扩展能力。
