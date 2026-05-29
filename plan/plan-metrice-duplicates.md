# Wiki Metric Duplicates CLI 方案

## 背景

HARNESS Wiki 当前存在同名指标跨体系重复维护的问题。例如同一个指标不应该同时出现在 CMR 和 IDX 中，但当前已经发现多组重复 `label`。

这类问题本质上不是召回消歧问题，而是指标治理问题：

- 同一个指标应该只有一个权威归属。
- 重复维护会导致召回上下文过多。
- 重复维护会导致 routing 摇摆。
- 重复维护会让 `SPEC -> PLAYBOOK -> TEMPLATE` 链路变得不唯一。

因此需要在 `data-harness-cli wikis` 下新增专门能力，用于检查、导出、维护和回写指标重复治理状态。

## 命令命名

采用：

```bash
data-harness-cli wikis metric-duplicates ...
```

不用泛化的 `duplicates`，原因是 `duplicates` 没有说明检查对象，可能被理解成文件重复、alias 重复、routing 重复或 template 重复。

`metric-duplicates` 明确表达：该命令检查的是 Wiki 中维护的指标重复。

## 目标

新增 `metric-duplicates` 能力，形成一套指标重复治理闭环：

- 扫描当前 `wikis/spec` 中的指标。
- 发现同名、同 code、同中文名、同文件名等重复情况。
- 特别识别 CMR 与 IDX 跨体系重复。
- 导出人工可维护的重复指标治理清单。
- 支持人工确认唯一 canonical owner。
- 支持将治理状态写回 Markdown frontmatter。
- 默认 dry run，显式 `--apply` 才写文件。

## 非目标

第一版不做以下能力：

- 不删除文件。
- 不移动文件。
- 不自动合并 spec/playbook/template 内容。
- 不自动决定 canonical owner。
- 不做模糊匹配。
- 不直接修改召回排序策略。

CLI 只负责发现、记录和回写治理状态。最终清理、删除、迁移仍需要人工确认。

## 命令设计

建议新增命令：

```bash
data-harness-cli wikis metric-duplicates report
data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml
data-harness-cli wikis metric-duplicates lint --file duplicate-metrics.yaml
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml --apply
```

## report

用于直接查看当前指标重复情况。

示例：

```bash
data-harness-cli wikis metric-duplicates report
```

预期输出：

```text
metric files scanned: 628
duplicate label groups: 44
duplicate code groups: 8
duplicate basename groups: 31
cross-system duplicate groups: 27

ERROR cross-system duplicate:
  label: 销售额
  files:
    - wikis/spec/cmr/business/s-sale-amt.md
    - wikis/spec/idx/business-manager/s-sale-amt.md

WARN duplicate label:
  label: 促销折扣率
  files:
    - wikis/spec/cmr/business/s-promotion-discount-rate.md
    - wikis/spec/idx/business-manager/s-promotion-discount-rate.md
    - wikis/spec/idx/full-link/s-promotion-discount-rate.md
```

第一版至少统计：

- 扫描的 metric spec 文件数。
- 重复 `label` 组数。
- 重复指标中文名组数。
- 重复指标英文 code 组数。
- 重复 `name` 组数。
- 重复 basename 组数。
- 跨体系重复组数。

## export

用于导出重复指标治理清单，供人工确认 canonical owner。

示例：

```bash
data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml
```

建议支持参数：

```bash
--root wikis
--out duplicate-metrics.yaml
--format yaml
--format json
```

默认格式为 YAML，方便人工维护和 code review。

### 导出结构

推荐结构：

```yaml
version: 1
root: wikis
generated_by: data-harness-cli wikis metric-duplicates export
groups:
  - id: dup.label.saleAmt
    match_type: label
    label: 销售额
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
      - path: wikis/spec/idx/business-manager/s-sale-amt.md
        domain: idx
        group: business-manager
        name: s_sale_amt
        code: saleAmt
        label: 销售额
        status: undecided
    decision:
      canonical: ""
      action: ""
      notes: ""
```

人工维护后示例：

```yaml
decision:
  canonical: wikis/spec/cmr/business/s-sale-amt.md
  action: deprecate_duplicates
  notes: 销售额统一归 CMR 经营分析口径，IDX 侧后续清理。
```

## lint

用于校验人工维护后的重复指标治理清单。

示例：

```bash
data-harness-cli wikis metric-duplicates lint --file duplicate-metrics.yaml
```

第一版建议校验规则：

- `groups` 必须是数组。
- 每个 group 必须有 `id`、`match_type`、`files`、`decision`。
- 每个 group 至少包含 2 个文件。
- `decision.canonical` 如果填写，必须是当前 group 中的一个文件。
- `decision.action` 如果填写，必须是允许值。
- canonical 文件不能被标记为 deprecated。
- 非 canonical 文件必须有明确 action。
- 文件路径必须存在。
- 同一个文件不应在多个冲突决策中被指定为不同 canonical 状态。

建议 action 允许值：

```yaml
deprecate_duplicates
merge_later
manual_review
ignore_not_same_metric
```

含义：

- `deprecate_duplicates`: canonical 之外的重复项后续废弃。
- `merge_later`: 暂不废弃，但需要后续合并。
- `manual_review`: 需要人工继续确认。
- `ignore_not_same_metric`: 虽然命中重复规则，但确认不是同一指标。

示例输出：

```text
ERROR canonical is not in group:
  group: dup.label.saleAmt
  canonical: wikis/spec/cmr/business/s-other.md

WARN undecided group:
  group: dup.label.profitRate
  label: 门店毛利率

WARN ignored duplicate:
  group: dup.label.someMetric
  action: ignore_not_same_metric
  notes: missing explanation
```

## import

用于把人工维护后的治理决策写回 Markdown frontmatter。

### 默认行为

`import` 默认只做 dry run，不写文件。

```bash
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml
```

默认执行：

- 读取 duplicate-metrics.yaml。
- 执行 lint。
- 对比当前 frontmatter。
- 输出将要写入的治理字段。
- 不写任何文件。

示例输出：

```text
DRY RUN

GROUP dup.label.saleAmt
  canonical:
    wikis/spec/cmr/business/s-sale-amt.md

  mark canonical:
    wikis/spec/cmr/business/s-sale-amt.md
      canonical_status: canonical
      canonical_group: dup.label.saleAmt

  mark deprecated:
    wikis/spec/idx/business-manager/s-sale-amt.md
      canonical_status: deprecated
      canonical_target: wikis/spec/cmr/business/s-sale-amt.md
      canonical_reason: duplicate label: 销售额

SUMMARY
  groups scanned: 44
  files to update: 61
  canonical marks: 27
  deprecated marks: 34

No files were changed. Re-run with --apply to write changes.
```

### 写入行为

必须显式加 `--apply` 才真正写回。

```bash
data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml --apply
```

示例输出：

```text
APPLIED

groups applied: 27
updated files: 61
canonical marks: 27
deprecated marks: 34
```

## 回写字段

导入时只修改 Markdown frontmatter，不修改正文。

canonical 文件写入：

```yaml
canonical_status: canonical
canonical_group: dup.label.saleAmt
```

非 canonical 文件写入：

```yaml
canonical_status: deprecated
canonical_target: wikis/spec/cmr/business/s-sale-amt.md
canonical_reason: duplicate label: 销售额
```

如果 action 是 `merge_later`，可以写入：

```yaml
canonical_status: merge_later
canonical_target: wikis/spec/cmr/business/s-sale-amt.md
canonical_reason: duplicate label: 销售额
```

如果 action 是 `ignore_not_same_metric`，默认不写回 frontmatter，避免污染文档。该决策保留在治理清单中即可。

## 检测规则

第一版只做精确匹配。

建议检测：

1. `label` 完全相同。
2. 基本信息表中的 `指标中文名` 完全相同。
3. 基本信息表中的 `指标英文 code` 完全相同。
4. frontmatter `name` 完全相同。
5. 文件 basename 完全相同，例如 `s-sale-amt.md`。

暂不做：

- 近义词匹配。
- 编辑距离匹配。
- 拼音匹配。
- 大模型判断是否同一指标。

原因是模糊匹配容易误报，第一版应先建立可靠的精确治理流程。

## 严重级别

建议 severity：

```text
error:
  CMR 与 IDX 跨体系同 label 或同 code

warn:
  同体系内同 label，但 code 不同
  同 code 但 label 不同
  basename 相同但 label/code 不同

info:
  低风险重复，例如人工确认不是同一指标
```

跨体系重复应优先治理，因为这类问题最容易导致召回同时命中两套取数链路。

## 与 aliases CLI 的关系

`metric-duplicates` 和 `aliases` 是平级能力：

```bash
data-harness-cli wikis aliases ...
data-harness-cli wikis metric-duplicates ...
```

职责区别：

```text
aliases:
  管理一个指标如何被召回。

metric-duplicates:
  管理一个指标是否被重复维护。
```

二者可以共享底层能力：

- Wiki 文件扫描。
- frontmatter 解析。
- spec/playbook/template 路径解析。
- YAML 读写。
- dry-run diff 输出。

但命令职责应保持分离。

## 推荐工作流

```text
1. 查看当前重复指标情况
   data-harness-cli wikis metric-duplicates report

2. 导出重复指标治理清单
   data-harness-cli wikis metric-duplicates export --out duplicate-metrics.yaml

3. 人工维护 canonical owner 和 action

4. 校验治理清单
   data-harness-cli wikis metric-duplicates lint --file duplicate-metrics.yaml

5. 预览写回 Markdown 的治理状态
   data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml

6. 确认无误后写回
   data-harness-cli wikis metric-duplicates import --file duplicate-metrics.yaml --apply

7. 后续人工清理、合并或删除 deprecated 文件
```

## 后续扩展

未来可以增加：

```bash
data-harness-cli wikis metric-duplicates resolve
```

但不建议第一版实现自动 resolve。

也可以在统一体检命令中聚合：

```bash
data-harness-cli wikis health report
```

该命令可同时检查：

- aliases 覆盖率。
- negative_aliases 覆盖率。
- metric duplicates。
- 三件套完整性。
- 短文档和占位文档。
- routing 冲突。

## 结论

`metric-duplicates` 应作为 Wiki 指标治理能力集成到 `data-harness-cli wikis` 下。

第一版推荐实现：

- `report`
- `export`
- `lint`
- `import`
- `import --apply`

默认策略：

- 只做精确匹配。
- 默认 dry run。
- 不删除文件。
- 不移动文件。
- 不自动合并。
- 只写 frontmatter 治理状态。

该方案能把“同一个指标被多处维护”的问题从一次性人工排查，变成可持续、可审计、可批量治理的 Wiki 质量能力。
