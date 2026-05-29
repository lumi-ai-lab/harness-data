# negative_aliases 召回策略设计

## 背景

HARNESS 当前 Wiki 召回主要依赖标题、指标名、别名、正文内容等正向匹配信号。对于语义相近、名称互相包含的指标，这种机制容易产生过召回。

典型例子：

- `销售额`
- `预算销售额`
- `销售额达成率`

当用户查询“预算销售额达成率为什么下降”时，普通 `销售额` 文档也可能因为命中“销售额”而获得较高分数，导致召回上下文过宽，影响后续路由、取数和分析质量。

为解决这类问题，引入 `negative_aliases` 作为召回阶段的消歧信号。

## 目标

`negative_aliases` 用于表达：

> 某些词或短语看起来和当前文档相关，但更应该指向其他指标或其他分析意图。

它的目标不是简单排除文档，而是帮助召回系统在多个相似候选之间做更稳定的排序。

核心目标：

- 降低名称包含导致的误召回。
- 减少 Top K 上下文中不必要的相近指标。
- 提升重复 label、父子指标、目标/达成/实际值等场景下的消歧能力。
- 避免把 `negative_aliases` 设计成容易误杀的硬过滤规则。

## 修改前流程

```text
User Query
   |
   v
[Initial Retrieval]
   |
   |-- title match
   |-- label match
   |-- aliases match
   |-- body BM25/vector match
   v
Candidate Docs
   |
   v
Top K Context
   |
   v
LLM Routing / Analysis
```

修改前的问题：

```text
Query: 预算销售额达成率为什么下降

Possible Candidates:
  - saleAmt
  - saleAmtGoal
  - saleAmtFinishRate
  - business overview
```

普通 `saleAmt` 可能因为命中“销售额”而进入 Top K，但用户真正要看的通常是 `saleAmtFinishRate`，必要时再关联 `saleAmtGoal`。

## 修改后流程

```text
User Query
   |
   v
[Initial Retrieval]
   |
   |-- title match
   |-- label match
   |-- aliases match
   |-- body BM25/vector match
   v
Candidate Docs
   |
   v
[Negative Alias Check]
   |
   |-- if query hits negative_aliases
   |      mark conflict
   |      downrank candidate
   |      require stronger positive evidence
   |
   v
[Rerank / Disambiguation]
   |
   v
Top K Context
   |
   v
LLM Routing / Analysis
```

展开后的流程：

```text
                         +----------------------+
User Query -------------->| Initial Retrieval    |
                         +----------------------+
                                    |
                                    v
                         +----------------------+
                         | Candidate Docs       |
                         +----------------------+
                                    |
                                    v
                         +----------------------+
                         | Negative Alias Check |
                         +----------------------+
                           |                  |
                           | no conflict       | conflict
                           v                  v
                    keep normal score     downrank / require exact evidence
                           |                  |
                           +--------+---------+
                                    v
                         +----------------------+
                         | Reranked Top K      |
                         +----------------------+
```

## 字段语义

示例：

```yaml
label: 销售额
aliases:
  - 销售情况
  - 销售表现
  - 销售额分析
negative_aliases:
  - 预算销售额
  - 销售额目标
  - 销售额达成率
```

含义：

- 用户问“销售额怎么样”时，`销售额` 应正常召回。
- 用户问“预算销售额达成率为什么下降”时，`销售额` 不应因为包含“销售额”而压过 `销售额达成率`。
- 用户问“销售额和预算销售额差异”时，`销售额` 仍可能是必要上下文，因此不能硬过滤。

## 推荐评分策略

不建议使用硬过滤：

```text
if query contains negative_alias:
    drop document
```

推荐使用降权和消歧：

```text
score = base_score
      + label_match_boost
      + alias_match_boost
      + exact_code_boost
      + domain_match_boost
      - negative_alias_penalty
```

其中：

- `negative_alias_penalty` 用于降低候选文档排序。
- 如果 query 同时强命中当前文档的 `label`、`code` 或精确 `aliases`，则只降权，不删除。
- 如果 query 命中其他候选的精确 label 或 alias，同时命中当前候选的 `negative_aliases`，当前候选应明显降权。

## 误杀保护

`negative_aliases` 不能作为默认硬排除条件。

需要保护的典型查询：

```text
销售额和预算销售额差异
实际销售额与销售额目标对比
销售额达成率下降是因为销售额下降还是目标提高
```

这些问题可能同时需要多个相关指标。如果对 `销售额` 使用硬过滤，会丢失必要上下文。

建议规则：

- 当 query 明确表达对比、差异、拆解、原因归因时，允许保留多个相关指标。
- 当 query 只明确指向更具体指标时，基础指标被 negative 命中后应降权。
- 当候选文档只有 negative 命中，没有 label/code/alias/body 的强正向证据时，可从 Top K 中移除。

## 示例

候选配置：

```yaml
id: cmr.business.saleAmt
label: 销售额
code: saleAmt
aliases:
  - 销售情况
  - 销售表现
  - 销售额分析
negative_aliases:
  - 预算销售额
  - 销售额目标
  - 销售额达成率
```

```yaml
id: idx.business-manager.saleAmtGoal
label: 预算销售额
code: saleAmtGoal
aliases:
  - 销售额目标
  - 销售预算
  - 目标销售额
negative_aliases: []
```

```yaml
id: idx.business-manager.saleAmtFinishRate
label: 销售额达成率
code: saleAmtFinishRate
aliases:
  - 销售达成率
  - 销售目标完成率
  - 预算销售额完成率
negative_aliases: []
```

查询：

```text
预算销售额达成率为什么下降
```

修改前可能排序：

```text
1. saleAmt
2. saleAmtGoal
3. saleAmtFinishRate
```

修改后期望排序：

```text
1. saleAmtFinishRate
2. saleAmtGoal
3. saleAmt
```

其中 `saleAmt` 可以保留为弱相关上下文，但不应压过更精确的指标。

## 分阶段落地

### 阶段一：字段进入召回元数据

在 Wiki 召回索引中支持读取：

```yaml
aliases: []
negative_aliases: []
```

本阶段只确保字段能够进入索引，不改变排序策略。

### 阶段二：接入降权策略

在召回重排阶段加入 negative alias penalty。

要求：

- 命中 `negative_aliases` 时降低候选分数。
- 不做默认硬过滤。
- 保留强正向命中的文档。
- 对重复 label、父子指标、目标/实际/达成类指标优先启用。

### 阶段三：基于日志调参

记录以下召回日志：

- query
- candidate docs
- matched aliases
- matched negative_aliases
- score before penalty
- score after penalty
- final Top K

通过真实查询观察：

- 是否减少了过召回。
- 是否出现必要文档被降权过度。
- 是否需要针对部分高置信 negative alias 做硬过滤。

### 阶段四：有限硬过滤

只有在日志证明某些 `negative_aliases` 长期稳定指向其他指标，且不会参与对比分析时，才考虑硬过滤。

默认策略仍应是降权而不是删除。

## 设计结论

`negative_aliases` 应进入 HARNESS 召回系统，但它的角色是消歧和降权信号，不是默认硬过滤规则。

推荐优先用于以下场景：

- 同名或近名指标。
- 父指标与子指标。
- 实际值、目标值、达成率。
- 金额、数量、率之间名称互相包含。
- CMR 与 IDX 中 label 相同但取数链路不同的指标。

这能在不牺牲必要上下文的前提下，降低错误召回和上下文膨胀。
