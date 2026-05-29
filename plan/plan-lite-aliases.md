# Lite Wiki Aliases 维护格式方案

## 背景

当前 `data-harness-cli wikis aliases export --out aliases.yaml` 已经可以导出 aliases 状态，并支持人工维护后再导入。

但当前导出的 `aliases.yaml` 更接近机器交换格式，包含大量定位和系统字段：

- `root`
- `targets`
- `file_key`
- `domain`
- `group`
- `paths.spec`
- `paths.playbook`
- `paths.template`
- `notes`
- `spec.aliases`
- `playbook.aliases`

这些字段对程序有帮助，但对人工维护 aliases 来说噪音较大。人工维护者主要关心：

- 这个指标或场景是什么。
- 当前有哪些 `aliases`。
- 当前有哪些 `negative_aliases`。
- 应该补充或删除哪些别名。

因此需要一个更轻量的 aliases 维护格式。

## 目标

新增或调整 aliases 导出格式，使默认人工维护文件更简单、稳定、低噪音。

目标：

- 默认导出人工友好的 lite YAML。
- 隐藏路径、template、file_key 等机器字段。
- 通过稳定 `id` 反查当前 corpus 中的 spec/playbook 路径。
- 保留 `label` 和 `code` 作为人工识别上下文。
- 支持 `aliases` 和 `negative_aliases` 的完整维护闭环。
- 保留 full 格式用于调试或机器交换。

非目标：

- 不自动生成 aliases。
- 不改变 Markdown frontmatter 中 aliases 的最终存储字段。
- 不改变召回系统对 aliases 的使用语义。
- 不要求人工维护者理解 spec/playbook/template 的物理路径。

## 推荐格式

建议将 spec 和 playbook 分开导出。

原因：

- spec aliases 表达“用户如何称呼一个指标”。
- playbook aliases 表达“用户如何提出一个分析场景或报表意图”。
- 两者维护语义不同，放在不同列表中更清楚。

```yaml
version: 1
format: lite

specs:
  - id: cmr.business.s-active-vender-num
    label: 活跃供应商数
    code: activeVenderNum
    aliases: []
    negative_aliases: []

  - id: cmr.business.s-sale-amt
    label: 销售额
    code: saleAmt
    aliases:
      - 销售金额
      - 销售情况
    negative_aliases:
      - 预算销售额
      - 销售额达成率

playbooks:
  - id: cmr.business.default-overview
    label: 经营分析概览
    aliases:
      - 经营分析
      - 经营报表
      - 经营情况
    negative_aliases: []

  - id: cmr.business.multi-metric-report
    label: 多指标经营分析
    aliases:
      - 多指标分析
      - 经营指标对比
    negative_aliases: []
```

## 字段说明

### 顶层字段

```yaml
version: 1
format: lite
specs: []
playbooks: []
```

- `version`: 文件版本，当前为 `1`。
- `format`: 格式类型，lite 格式固定为 `lite`。
- `specs`: spec aliases 维护列表。
- `playbooks`: playbook aliases 维护列表。

### item 字段

```yaml
id: cmr.business.s-sale-amt
label: 销售额
code: saleAmt
aliases: []
negative_aliases: []
```

- `id`: 稳定逻辑 ID，用于导入时反查当前 corpus 中的目标文档。
- `label`: 人工识别用，不作为导入定位的唯一依据。
- `code`: 指标 code，主要用于人工识别；playbook 可以为空或省略。
- `aliases`: 正向别名。
- `negative_aliases`: 负向别名，用于召回消歧和降权信号。

## 可以省略的字段

lite 格式中不导出以下字段：

- `root`
- `targets`
- `file_key`
- `domain`
- `group`
- `paths`
- `paths.spec`
- `paths.playbook`
- `paths.template`
- `notes`
- `spec`
- `playbook`

这些字段都可以由 `id` 和当前 corpus 反查，或者不属于人工维护 aliases 的核心内容。

## id 规则

lite 格式继续沿用当前 full 格式中的 `id` 规则：

```text
cmr.business.s-sale-amt
```

该 ID 来自逻辑 file key：

```text
cmr/business/s-sale-amt.md
```

转换规则：

- 去掉 `.md` 后缀。
- `/` 替换为 `.`。

导入时再反向映射到当前 corpus 中的 spec/playbook 文档。

## CLI 行为建议

### export

默认导出 lite 格式：

```bash
data-harness-cli wikis aliases export --out aliases.yaml
```

等价于：

```bash
data-harness-cli wikis aliases export --out aliases.yaml --format lite
```

保留 full 格式：

```bash
data-harness-cli wikis aliases export --out aliases-full.yaml --format full
```

JSON 输出仍可支持：

```bash
data-harness-cli wikis aliases export --out aliases.json --format json
```

如需同时支持 lite JSON，可以考虑：

```bash
data-harness-cli wikis aliases export --out aliases.json --format lite-json
```

但第一版可以只支持 lite YAML 和 full YAML。

### lint

lint 应同时支持 lite 和 full 两种格式。

```bash
data-harness-cli wikis aliases lint --file aliases.yaml
```

lite 格式校验规则：

- `specs` 和 `playbooks` 必须是数组。
- 每个 item 必须有 `id`。
- `aliases` 必须是数组，允许为空数组。
- `negative_aliases` 必须是数组，允许为空数组。
- 同一个 item 内 `aliases` 不允许重复。
- 同一个 item 内 `negative_aliases` 不允许重复。
- 同一个 item 内 `aliases` 和 `negative_aliases` 不允许交叉重复。
- 同一个 alias 出现在多个 item 中时给 warning。
- alias 太短或太泛时给 warning。
- `negative_aliases` 找不到明显正向归属时给 warning。
- `id` 在当前 corpus 中找不到对应文档时给 error。

### import

导入时支持 dry-run 和 apply。

```bash
data-harness-cli wikis aliases import --file aliases.yaml
```

```bash
data-harness-cli wikis aliases import --file aliases.yaml --apply
```

lite import 行为：

- 读取 `specs`，通过 `id` 找到对应 spec 文档。
- 读取 `playbooks`，通过 `id` 找到对应 playbook 文档。
- 将 `aliases` 和 `negative_aliases` 写回对应 Markdown frontmatter。
- 不依赖 YAML 中的物理路径。
- 如果当前 corpus 中找不到 `id`，报错并阻止 apply。

## 兼容策略

为了避免破坏当前流程，建议按阶段推进。

### 阶段 1：双格式读取，默认仍 full

- `export` 支持 `--format lite`。
- `lint` 支持 lite 和 full。
- `import` 支持 lite 和 full。
- 默认导出仍保留当前 full 格式。

适合风险最小的落地方式。

### 阶段 2：默认导出 lite，full 显式指定

- `export --out aliases.yaml` 默认导出 lite。
- `export --format full` 导出现有完整格式。
- `lint/import` 继续兼容 full。

这是推荐最终状态。

## 导出排序

lite 格式应保持稳定排序，降低人工 review 成本。

建议排序：

1. `domain`
2. `group`
3. spec/playbook 类型
4. `id`

由于 lite 格式不导出 `domain` 和 `group`，排序只影响文件顺序，不影响字段内容。

## 空数组输出

建议空 aliases 明确输出为 `[]`：

```yaml
aliases: []
negative_aliases: []
```

避免当前这种空值：

```yaml
aliases:
negative_aliases:
```

原因：

- YAML 空值容易被误解为 null。
- 人工维护时不如 `[]` 明确。
- lint/import 可以更严格要求数组类型。

## full 格式保留价值

full 格式仍有价值，不应直接删除。

适用场景：

- 调试路径解析问题。
- 对比 spec/playbook/template 三者绑定关系。
- 排查导入目标错误。
- 机器交换或自动化脚本消费。

建议 full 格式继续沿用当前结构：

```yaml
version: 1
root: wikis
targets:
  - playbooks
  - spec
items:
  - id: cmr.business.s-sale-amt
    label: 销售额
    code: saleAmt
    file_key: cmr/business/s-sale-amt.md
    paths:
      spec: wikis/spec/cmr/business/s-sale-amt.md
      playbook: wikis/playbooks/cmr/business/s-sale-amt.md
      template: wikis/templates/cmr/business/s-sale-amt.md
    spec:
      aliases: []
      negative_aliases: []
    playbook:
      aliases: []
      negative_aliases: []
```

## 推荐实现方案

### 新增数据结构

```go
type LiteAliasesFile struct {
    Version   int               `json:"version"`
    Format    string            `json:"format"`
    Specs     []LiteAliasesItem `json:"specs"`
    Playbooks []LiteAliasesItem `json:"playbooks"`
}

type LiteAliasesItem struct {
    ID              string   `json:"id"`
    Label           string   `json:"label,omitempty"`
    Code            string   `json:"code,omitempty"`
    Aliases         []string `json:"aliases"`
    NegativeAliases []string `json:"negative_aliases"`
}
```

### 新增导出函数

```go
func ExportAliasesLite(root string, targets []string) (LiteAliasesFile, error)
```

实现可以复用当前 `ExportAliases` 的 corpus 扫描逻辑，但输出时拆成 `Specs` 和 `Playbooks`。

### 读取格式识别

`ReadAliasesFile` 可以先解析为通用 map，识别格式：

- 如果存在 `items`，按 full 格式解析。
- 如果存在 `specs` 或 `playbooks`，按 lite 格式解析。
- 如果 `format: lite`，按 lite 格式解析。

### 内部归一化

为了减少 lint/import 重复逻辑，可以将 lite/full 都归一化为同一个内部结构：

```go
type NormalizedAliasesTarget struct {
    ID              string
    Kind            Kind
    Path            string
    Label           string
    Code            string
    Aliases         []string
    NegativeAliases []string
}
```

归一化阶段负责：

- full 格式：直接使用 `paths.spec` / `paths.playbook`。
- lite 格式：通过 `id` 和 kind 从当前 corpus 反查 path。

后续 lint/import 只处理 normalized targets。

## 示例维护流程

```bash
# 1. 导出轻量维护文件
data-harness-cli wikis aliases export --out aliases.yaml

# 2. 人工维护 aliases.yaml

# 3. 校验
data-harness-cli wikis aliases lint --file aliases.yaml

# 4. dry-run 导入
data-harness-cli wikis aliases import --file aliases.yaml

# 5. 确认后 apply
data-harness-cli wikis aliases import --file aliases.yaml --apply
```

## 结论

aliases 人工维护文件应该以 lite 格式为默认。

full 格式适合程序调试，但不适合日常人工维护。lite 格式隐藏路径和系统字段，只保留 `id`、`label`、`code`、`aliases`、`negative_aliases`，可以显著降低维护成本，并减少人工误改机器字段导致导入失败的风险。
