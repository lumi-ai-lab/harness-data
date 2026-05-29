# Wiki Aliases CLI 方案

## 背景

HARNESS 当前 Wiki 文档已经基本形成单指标三件套：

- `SPEC`
- `PLAYBOOK`
- `TEMPLATE`

但当前 `aliases` 覆盖不足，召回更多依赖标题、正文 BM25 或少量已有别名。对于自然语言问题，例如“销售情况”“客流”“毛利表现”“复购问题”，召回稳定性不足。

同时，系统已经决定引入 `negative_aliases` 作为后续召回消歧和降权信号，用于处理名称相近、父子指标、目标值/实际值/达成率等容易误召回的场景。

本文只讨论 Wiki aliases 维护 CLI，不讨论召回系统中 `negative_aliases` 的具体降权实现。

## 目标

新增 `data-harness-cli wikis aliases` 能力，形成一套人工可维护、可校验、可安全回写的闭环。

核心目标：

- 扫描当前 `wikis/spec` 和 `wikis/playbooks` 的 aliases 覆盖情况。
- 导出当前 aliases/negative_aliases 状态到人工可维护文件。
- 支持人工编辑后导入。
- 导入前做结构校验、冲突检查和变更预览。
- 批量更新 Markdown frontmatter。
- 默认不写文件，必须显式 `--apply` 才真正更新。

## 非目标

第一版不做以下能力：

- 不维护 `templates` 的 aliases。
- 不自动生成 aliases。
- 不直接修改召回排序策略。
- 不处理 template 注入逻辑。
- 不改 Markdown 正文，只改 frontmatter。

`templates` 第一版不参与 aliases 维护，原因是 template 应由已选中的 playbook 绑定注入，不应直接作为第一阶段召回入口。否则一次用户查询可能同时召回 spec、playbook、template，导致上下文膨胀。

## 命令设计

建议新增命令组：

```bash
data-harness-cli wikis aliases report
data-harness-cli wikis aliases export --out aliases.yaml
data-harness-cli wikis aliases lint --file aliases.yaml
data-harness-cli wikis aliases import --file aliases.yaml
data-harness-cli wikis aliases import --file aliases.yaml --apply
```

## report

用于查看当前 Wiki aliases 覆盖率和主要风险。

示例：

```bash
data-harness-cli wikis aliases report
```

预期输出：

```text
spec files: 628
spec with aliases: 6
spec with negative_aliases: 0

playbook files: 659
playbook with aliases: 10
playbook with negative_aliases: 0

duplicate aliases: 12
label conflicts: 44
missing high-priority aliases: 58
```

第一版至少统计：

- spec 文件总数。
- playbook 文件总数。
- 已有 `aliases` 的文件数。
- 已有 `negative_aliases` 的文件数。
- 重复 label 数量。
- 重复 alias 数量。
- 只有占位内容的短文档数量。

## export

用于导出当前 Wiki aliases 状态，生成供人工维护的 YAML 文件。

示例：

```bash
data-harness-cli wikis aliases export --out aliases.yaml
```

默认扫描：

```text
wikis/spec
wikis/playbooks
```

不扫描：

```text
wikis/templates
```

建议支持参数：

```bash
--root wikis
--out aliases.yaml
--format yaml
--format json
--include spec,playbooks
```

默认格式为 YAML。JSON 可以作为机器消费格式，但人工维护建议使用 YAML。

### 导出结构

推荐结构：

```yaml
version: 1
root: wikis
targets:
  - spec
  - playbooks
items:
  - id: cmr.business.saleAmt
    label: 销售额
    code: saleAmt
    domain: cmr
    group: business
    file_key: cmr/business/s-sale-amt.md
    paths:
      spec: wikis/spec/cmr/business/s-sale-amt.md
      playbook: wikis/playbooks/cmr/business/s-sale-amt.md
      template: wikis/templates/cmr/business/s-sale-amt.md

    spec:
      aliases:
        - 销售情况
        - 销售表现
        - 销售额分析
      negative_aliases:
        - 预算销售额
        - 销售额目标
        - 销售额达成率

    playbook:
      aliases:
        - 查销售额
        - 分析销售为什么下降
        - 销售额按区域拆解
        - 销售额趋势
      negative_aliases:
        - 查预算销售额
        - 销售额目标完成情况

    notes: ""
```

### 为什么 spec 和 playbook 分开

`spec` 和 `playbook` 在召回中承担不同角色：

- `spec` aliases 偏“指标是什么”。
- `playbook` aliases 偏“用户想怎么查、怎么分析”。

例如：

```yaml
spec:
  aliases:
    - 销售情况
    - 销售表现
    - 销售额分析

playbook:
  aliases:
    - 查销售额
    - 分析销售为什么下降
    - 销售额按区域拆解
```

分开维护后，未来召回层可以对 spec 和 playbook 设置不同权重。

## lint

用于校验人工维护后的 `aliases.yaml`。

示例：

```bash
data-harness-cli wikis aliases lint --file aliases.yaml
```

第一版建议支持以下规则：

- `aliases` 和 `negative_aliases` 必须是数组。
- 同一个 item 内 `aliases` 不允许重复。
- 同一个 item 内 `negative_aliases` 不允许重复。
- 同一个 item 内 `aliases` 和 `negative_aliases` 不允许交叉重复。
- alias 不能太短，例如只有“情况”“分析”“指标”。
- alias 不能过长，默认超过 40 字给出 warning。
- 同一个 alias 出现在多个 item 中时给出 warning。
- `negative_aliases` 如果找不到其他 item 的 label、code 或 alias 作为正向归属，给出 warning。
- 同 label 跨域重复时，建议必须补充 domain/report 相关 alias。
- 文件路径不存在时报 error。
- YAML 中 item 路径和当前 Wiki 三件套不匹配时报 warning 或 error。

示例输出：

```text
ERROR duplicate alias in same item:
  item: cmr.business.saleAmt
  alias: 销售情况

WARN alias appears in multiple items:
  alias: 销售额达成率
  items:
    - cmr.business.saleAmt
    - idx.business-manager.saleAmtFinishRate

WARN negative alias without positive owner:
  item: cmr.business.saleAmt
  negative_alias: 预算销售额完成情况

WARN alias too generic:
  item: cmr.business.saleAmt
  alias: 情况
```

## import

用于将人工维护后的 aliases 文件写回 Markdown frontmatter。

### 默认行为

`import` 默认只做 dry run，不写文件。

```bash
data-harness-cli wikis aliases import --file aliases.yaml
```

默认执行：

- 读取 aliases.yaml。
- 校验 YAML 结构。
- 校验目标文件是否存在。
- 对比当前 frontmatter。
- 输出将要修改的文件和字段变化。
- 不写入任何文件。

示例输出：

```text
DRY RUN

UPDATE wikis/spec/cmr/business/s-sale-amt.md
  aliases:
    + 销售情况
    + 销售表现
  negative_aliases:
    + 预算销售额
    + 销售额达成率

NO CHANGE wikis/playbooks/cmr/business/s-sale-amt.md

SUMMARY
  files scanned: 628
  files to update: 42
  aliases added: 108
  negative_aliases added: 31

No files were changed. Re-run with --apply to write changes.
```

### 写入行为

必须显式加 `--apply` 才真正写回文件。

```bash
data-harness-cli wikis aliases import --file aliases.yaml --apply
```

示例输出：

```text
APPLIED

updated files: 42
aliases added: 108
negative_aliases added: 31
```

选择默认 dry run 的原因：

- aliases 会影响召回质量。
- import 会批量修改大量 Markdown 文件。
- 人容易忘记加 `--dry-run`，因此更安全的设计是默认预览，显式 `--apply` 才写入。

## 回写规则

导入时只修改 Markdown frontmatter 中的以下字段：

```yaml
aliases:
negative_aliases:
```

其他字段必须保留，例如：

```yaml
name:
label:
```

正文不做任何修改。

如果文件已有 frontmatter：

```markdown
---
name: "saleAmt"
label: "销售额"
---
```

导入后：

```markdown
---
name: "saleAmt"
label: "销售额"
aliases:
  - 销售情况
  - 销售表现
negative_aliases:
  - 预算销售额
  - 销售额达成率
---
```

如果文件没有 frontmatter，则自动增加：

```markdown
---
aliases:
  - 查销售额
negative_aliases:
  - 查预算销售额
---

# 原正文标题
```

## 空数组策略

建议默认策略：

```text
empty arrays are not written
```

也就是说：

```yaml
aliases: []
negative_aliases: []
```

不会被写入 Markdown，避免所有文件都出现空字段。

未来可以增加参数：

```bash
--empty keep
--empty remove
```

第一版不强制实现该参数。

## 字段语义

### aliases

正向召回别名。

用于表达用户可能如何称呼这个指标、问题或分析动作。

例：

```yaml
aliases:
  - 销售情况
  - 销售表现
  - 销售额分析
```

### negative_aliases

负向召回别名。

用于表达“这个词看起来相关，但更应该召回其他指标或其他分析意图”。

例：

```yaml
negative_aliases:
  - 预算销售额
  - 销售额目标
  - 销售额达成率
```

`negative_aliases` 不代表硬排除。它是后续召回系统的消歧和降权信号。

## 推荐工作流

```text
1. 生成覆盖率报告
   data-harness-cli wikis aliases report

2. 导出当前状态
   data-harness-cli wikis aliases export --out aliases.yaml

3. 人工维护 aliases.yaml

4. 校验维护结果
   data-harness-cli wikis aliases lint --file aliases.yaml

5. 预览导入变更
   data-harness-cli wikis aliases import --file aliases.yaml

6. 确认无误后写回
   data-harness-cli wikis aliases import --file aliases.yaml --apply

7. 再次查看覆盖率
   data-harness-cli wikis aliases report
```

## 后续扩展

后续可以考虑新增：

```bash
data-harness-cli wikis aliases suggest
```

但不建议第一版实现自动生成 aliases。

原因：

- 自动生成容易引入错误业务语义。
- 错误 aliases 会直接影响召回质量。
- 第一阶段应先建立人工维护和安全回写闭环。

未来也可以接入召回日志，生成候选别名建议：

- 高频用户问法。
- 未命中 query。
- 命中多个重复 label 的 query。
- 被人工修正过路由的 query。

这些建议仍应人工审核后再导入。

## 结论

第一版采用“Markdown frontmatter 为最终落点，YAML 为人工维护中间件”的方案。

推荐范围：

- 维护 `spec` 和 `playbooks`。
- 暂不维护 `templates`。
- 支持 `aliases` 和 `negative_aliases`。
- `import` 默认 dry run。
- 显式 `--apply` 才批量回写。

该方案能在不大改现有 Wiki 召回结构的前提下，快速补齐 aliases 覆盖，并为后续 `negative_aliases` 进入召回消歧策略打基础。
