# Lite Metric Duplicates 维护格式方案

## 背景

当前 `data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml` 已经可以导出指标重复治理清单，并支持人工维护后再导入。

但当前导出的 YAML 更接近机器交换格式，包含大量系统字段：

- `id`
- `root`
- `generated_by`
- `reason`
- `files.domain`
- `files.group`
- `files.name`
- `files.code`
- `files.label`
- `files.status`
- `decision.canonical`
- `decision.action`
- `decision.notes`

这些字段对程序导入有帮助，但对人工治理来说偏复杂。用户的核心诉求是：

- 知道哪些文件重复了。
- 知道它们为什么被认为重复。
- 能选择 canonical owner。
- 能标记重复文件的治理动作。

因此需要一个更轻量的 metric duplicates 维护格式。

## 目标

新增或调整 `metric-duplicates` 导出格式，使默认人工维护文件更简单。

目标：

- 默认导出人工友好的 lite YAML。
- 用简单文件路径列表表达重复文件。
- 保留重复命中类型，例如 `label`、`code`、`basename`。
- 保留重复值，方便人工判断。
- 保留 `canonical`、`action`、`notes`，支持治理闭环。
- 保留 full 格式用于调试和机器交换。

非目标：

- 不自动选择 canonical owner。
- 不删除重复文件。
- 不移动文件。
- 不自动合并 spec/playbook/template 内容。
- 不改变当前导入后写入 Markdown frontmatter 的治理字段语义。

## 推荐 lite 格式

```yaml
version: 1
format: lite

duplicates:
  - by: basename
    value: s-sale-amt.md
    label: 销售额
    severity: error
    files:
      - wikis/spec/cmr/business/s-sale-amt.md
      - wikis/spec/idx/business-manager/s-sale-amt.md
    canonical: ""
    action: ""
    notes: ""

  - by: label
    value: 销售额
    label: 销售额
    severity: error
    files:
      - wikis/spec/cmr/business/s-sale-amt.md
      - wikis/spec/idx/business-manager/s-sale-amt.md
    canonical: ""
    action: ""
    notes: ""
```

## 字段说明

### 顶层字段

```yaml
version: 1
format: lite
duplicates: []
```

- `version`: 文件版本，当前为 `1`。
- `format`: 格式类型，lite 格式固定为 `lite`。
- `duplicates`: 重复指标分组列表。

### duplicate item 字段

```yaml
by: label
value: 销售额
label: 销售额
severity: error
files: []
canonical: ""
action: ""
notes: ""
```

- `by`: 重复命中类型，对应 full 格式的 `match_type`。
- `value`: 重复命中的值，例如 label、code、basename。
- `label`: 人工识别用的中文指标名，允许为空。
- `severity`: 重复严重程度，通常为 `error` 或 `warn`。
- `files`: 重复文件路径列表。
- `canonical`: 人工选择的 canonical owner 文件路径。
- `action`: 治理动作。
- `notes`: 人工备注。

## by 取值

当前实现中 `by` 来自现有 `match_type`：

- `label`: frontmatter `label` 重复。
- `chinese_name`: 基本信息中的 `指标中文名` 重复。
- `code`: 基本信息中的 `指标英文 code` 重复。
- `name`: frontmatter `name` 重复。
- `basename`: 文件名重复。

示例：

```yaml
- by: code
  value: saleAmt
  label: 销售额
  files:
    - wikis/spec/cmr/business/s-sale-amt.md
    - wikis/spec/idx/business-manager/s-sale-amt.md
```

## severity 语义

沿用当前 full 格式的语义。

```yaml
severity: error
```

表示跨体系重复，例如同组文件同时包含 `cmr` 和 `idx`。

```yaml
severity: warn
```

表示同体系内重复或其它需要人工确认的问题。

## action 取值

沿用当前实现支持的 action：

```text
deprecate_duplicates
merge_later
manual_review
ignore_not_same_metric
```

说明：

- `deprecate_duplicates`: 已确定 canonical，其它重复文件标记为 deprecated。
- `merge_later`: 已确定 canonical，但重复文件后续再合并或清理。
- `manual_review`: 暂不治理，保留人工复核状态。
- `ignore_not_same_metric`: 判断为不是同一指标，忽略该重复命中。

## 人工维护示例

```yaml
version: 1
format: lite

duplicates:
  - by: label
    value: 销售额
    label: 销售额
    severity: error
    files:
      - wikis/spec/cmr/business/s-sale-amt.md
      - wikis/spec/idx/business-manager/s-sale-amt.md
    canonical: wikis/spec/cmr/business/s-sale-amt.md
    action: deprecate_duplicates
    notes: 销售额统一归 CMR 经营分析口径，IDX 后续清理。
```

导入后预期写回 canonical 文件：

```yaml
canonical_status: canonical
canonical_group: dup.label.销售额
```

导入后预期写回重复文件：

```yaml
canonical_status: deprecated
canonical_target: wikis/spec/cmr/business/s-sale-amt.md
canonical_reason: duplicate label: 销售额
```

## 与当前 full 格式的映射

### full 到 lite

当前 full：

```yaml
- id: dup.label.销售额
  match_type: label
  label: 销售额
  value: 销售额
  severity: error
  reason: 同一指标不应同时出现在 CMR 和 IDX
  files:
    - path: wikis/spec/cmr/business/s-sale-amt.md
      domain: cmr
      group: business
      name: saleAmt
      code: saleAmt
      label: 销售额
      status: undecided
  decision:
    canonical: ""
    action: ""
    notes: ""
```

lite：

```yaml
- by: label
  value: 销售额
  label: 销售额
  severity: error
  files:
    - wikis/spec/cmr/business/s-sale-amt.md
  canonical: ""
  action: ""
  notes: ""
```

映射关系：

- `match_type` -> `by`
- `value` -> `value`
- `label` -> `label`
- `severity` -> `severity`
- `files[].path` -> `files[]`
- `decision.canonical` -> `canonical`
- `decision.action` -> `action`
- `decision.notes` -> `notes`

### lite 到内部结构

导入时可以将 lite 归一化为现有 full 内部结构：

```go
type MetricDuplicateGroup struct {
    ID        string
    MatchType string
    Label     string
    Value     string
    Severity  string
    Reason    string
    Files     []MetricDuplicateFileItem
    Decision  MetricDuplicateDecision
}
```

lite 中缺失的字段由当前 corpus 反查补齐：

- `id`: 根据 `by` 和 `value` 生成，沿用 `metricDuplicateID(by, value)`。
- `reason`: 根据 `severity` 或是否跨体系生成。
- `files.domain`: 从路径或当前 corpus 反查。
- `files.group`: 从路径或当前 corpus 反查。
- `files.name`: 从当前 corpus 反查。
- `files.code`: 从当前 spec 基本信息反查。
- `files.label`: 从当前 corpus 或基本信息反查。
- `files.status`: 默认 `undecided`。

## 可以省略的字段

lite 格式不导出以下字段：

- `root`
- `generated_by`
- `id`
- `reason`
- `files.domain`
- `files.group`
- `files.name`
- `files.code`
- `files.label`
- `files.status`
- `decision` 嵌套层级

原因：

- `root` 和 `generated_by` 对人工判断重复文件没有帮助。
- `id` 可以由 `by + value` 稳定生成。
- `reason` 可以由 `severity` 和跨体系判断生成。
- `files.*` 元数据可以从当前 corpus 反查。
- `decision` 嵌套层级不必要，平铺后更方便人工编辑。

## CLI 行为建议

### export

默认导出 lite 格式：

```bash
data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml
```

等价于：

```bash
data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml --format lite
```

保留 full 格式：

```bash
data-harness-cli wikis metric-duplicates export --out duplicate-metrics-full.yaml --format full
```

JSON 输出可继续支持 full JSON：

```bash
data-harness-cli wikis metric-duplicates export --out duplicate-metrics.json --format json
```

第一版建议只实现：

- `--format lite`
- `--format full`
- `--format json`，保持现有 JSON 行为

### report

`report` 当前文本输出已经接近 lite 展示，只列出重复类型和值和文件列表。

可以保持不变：

```bash
data-harness-cli wikis metric-duplicates report
```

后续可考虑增加：

```bash
data-harness-cli wikis metric-duplicates report --severity error
```

但这不是 lite 格式第一版的必要内容。

### lint

lint 应同时支持 lite 和 full 两种格式：

```bash
data-harness-cli wikis metric-duplicates lint --file duplicate-metrics.yaml
```

lite 校验规则：

- `duplicates` 必须是数组。
- 每个 duplicate 必须有 `by`。
- 每个 duplicate 必须有 `value`，除非未来支持手工自定义 group。
- `files` 必须是数组。
- `files` 至少包含两个文件。
- `files` 中每个路径必须存在。
- `canonical` 如果非空，必须是 `files` 中的一个路径。
- `canonical` 非空时必须填写 `action`。
- `action` 必须是允许值之一。
- `action: ignore_not_same_metric` 时建议填写 `notes`。
- 同一个文件在多个已决策 group 中不能出现互相冲突的 canonical 状态。

### import

导入时支持 dry-run 和 apply：

```bash
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml
```

```bash
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml --apply
```

lite import 行为：

- 读取 `duplicates`。
- 将每个 duplicate 归一化为现有内部 `MetricDuplicateGroup`。
- 如果 `canonical` 或 `action` 为空，跳过该 group 的写回。
- 如果 `action` 是 `manual_review` 或 `ignore_not_same_metric`，不写 canonical/deprecated 标记。
- 如果 `action` 是 `deprecate_duplicates`，canonical 文件写 `canonical_status: canonical`，其它文件写 `canonical_status: deprecated`。
- 如果 `action` 是 `merge_later`，canonical 文件写 `canonical_status: canonical`，其它文件写 `canonical_status: merge_later`。

## 兼容策略

为了降低风险，建议分阶段推进。

### 阶段 1：新增 lite 导出，保留 full 默认

- `export --format lite` 输出 lite 格式。
- `export` 默认仍输出 full。
- `lint/import` 支持 lite 和 full。

适合先验证人工维护体验。

### 阶段 2：默认导出 lite

- `export --out duplicate-metrics.yaml` 默认输出 lite。
- `export --format full` 输出当前完整结构。
- `lint/import` 继续兼容 full。

这是推荐最终状态。

## 去重后的重复展示问题

当前同一对文件可能因为多个维度重复而出现多次，例如：

- `basename`
- `label`
- `code`

lite 格式第一版可以保持当前行为，即一条命中维度对应一个 duplicate item。

后续如果人工觉得重复过多，可以再引入聚合格式：

```yaml
- duplicate: 销售额
  by:
    - basename
    - label
    - code
  values:
    basename: s-sale-amt.md
    label: 销售额
    code: saleAmt
  files:
    - wikis/spec/cmr/business/s-sale-amt.md
    - wikis/spec/idx/business-manager/s-sale-amt.md
```

但聚合会增加实现复杂度，也会让 import 的 group id 和 canonical 标记变复杂。因此第一版不建议聚合。

## 推荐实现方案

### 新增数据结构

```go
type LiteMetricDuplicatesFile struct {
    Version    int                         `json:"version"`
    Format     string                      `json:"format"`
    Duplicates []LiteMetricDuplicateGroup  `json:"duplicates"`
}

type LiteMetricDuplicateGroup struct {
    By        string   `json:"by"`
    Value     string   `json:"value"`
    Label     string   `json:"label,omitempty"`
    Severity  string   `json:"severity"`
    Files     []string `json:"files"`
    Canonical string   `json:"canonical"`
    Action    string   `json:"action"`
    Notes     string   `json:"notes"`
}
```

### 新增导出函数

```go
func ExportMetricDuplicatesLite(root string) (LiteMetricDuplicatesFile, error)
```

实现方式：

- 复用 `buildMetricDuplicateGroups(root)`。
- 将每个 `MetricDuplicateGroup` 转为 `LiteMetricDuplicateGroup`。
- 只保留 `files[].path`。
- 将 `decision` 平铺为 `canonical/action/notes`。

### 读取格式识别

`ReadMetricDuplicatesFile` 可以先根据 YAML 顶层字段识别格式：

- 存在 `groups`：full 格式。
- 存在 `duplicates`：lite 格式。
- `format: lite`：lite 格式。

JSON 也可用同样规则识别。

### 内部归一化

建议新增归一化函数：

```go
func NormalizeMetricDuplicates(root string, data any) (MetricDuplicatesFile, error)
```

或更简单地：

```go
func ReadMetricDuplicatesFile(root, file string) (MetricDuplicatesFile, error)
```

读取 lite 后立即补齐成现有 `MetricDuplicatesFile`，让后续 `LintMetricDuplicates` 和 `ImportMetricDuplicates` 复用现有逻辑。

## 示例维护流程

```bash
# 1. 导出轻量重复治理文件
data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml

# 2. 人工维护 canonical/action/notes

# 3. 校验
data-harness-cli wikis metric-duplicates lint --file duplicate-metrics.yaml

# 4. dry-run 导入
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml

# 5. 确认后 apply
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml --apply
```

## 结论

`metric-duplicates` 的人工维护文件应该默认使用 lite 格式。

当前 full 格式适合程序调试，但不适合日常治理。lite 格式只保留 `by`、`value`、`label`、`severity`、`files`、`canonical`、`action`、`notes`，能直接满足“知道哪些文件重复了”和“选择 canonical owner”的核心需求，同时保留后续导入写回治理状态的能力。
