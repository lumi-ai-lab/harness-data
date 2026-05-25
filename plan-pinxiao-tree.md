# 经营分析一级指标树报告批量建设计划

## 目标

围绕经营分析 `business` 下的一级指标树，为每一个指标分别建设独立的 HARNESS 报告能力。每个指标作为一个子任务单元，独立产出：

- template
- playbook
- spec 知识
- routing 规则
- intent 说明
- index 挂载
- context / inject-template / 回归测试

不一次性全部实施。后续按本计划逐个子任务推进。

## 已完成范围

`品效 brandProductEffectiveness` 根指标已经完成，不纳入本次子任务范围。已完成文件：

- `templates/business/brand-product-effectiveness-report.md`
- `spec/business/brand-product-effectiveness.md`
- `playbooks/business/brand-product-effectiveness.md`
- `routing/business-brand-product-effectiveness.md`
- `intents/business-brand-product-effectiveness.md`

`品效` 下游指标仍在本计划范围内。

## 已实探 CLI 结论

使用 `harness-template` 流程，已通过 CMR CLI 验证三棵经营分析一级指标树结构。

已验证命令：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business tree -h

"$QDM_CMR_CLI" search indicators tree --report business --keyword 品效 --ai
"$QDM_CMR_CLI" search indicators tree --report business --keyword 客数渗透率 --ai
"$QDM_CMR_CLI" search indicators tree --report business --keyword 活跃供应商数 --ai

"$QDM_CMR_CLI" report business tree --values --date 2026-05-23 --indicator 品效
"$QDM_CMR_CLI" report business tree --values --date 2026-05-23 --indicator 客数渗透率
"$QDM_CMR_CLI" report business tree --values --date 2026-05-23 --indicator 活跃供应商数

"$QDM_CMR_CLI" report business tree --chart --date 2026-05-23 --indicator 品效 --with-meta
"$QDM_CMR_CLI" report business tree --chart --date 2026-05-23 --indicator 客数渗透率 --with-meta
"$QDM_CMR_CLI" report business tree --chart --date 2026-05-23 --indicator 活跃供应商数 --with-meta
```

注意：

- `search indicators tree` 使用 `--keyword <指标名>`，不是 `--indicator <指标名>`。
- `search indicators tree --report business --keyword <指标名> --ai` 返回的单指标树最适合确认父子关系。
- `report business tree --values --indicator <指标名>` 会解析 selected indicator，但返回完整经营分析树；适合取值，不适合单独判断树边界。
- `report business tree --chart --indicator <指标名>` 可返回所选指标的 area/category/trend 图表数据。
- 每个具体指标实施前，仍需对该指标单独做小样本 CLI 验证，不能只沿用本计划假设。

## 命名与目录约定

不用 `drill` 作为文件名、query_type 或 depth 的命名。经营分析归属通过 `business` 目录表达，一级指标树归属通过一级指标目录表达，避免文件名过长，也避免目录嵌套过深。

建议路径：

```text
templates/business/<tree-root-kebab>/<metric-kebab>-report.md
spec/business/<tree-root-kebab>/<metric-kebab>.md
playbooks/business/<tree-root-kebab>/<metric-kebab>.md
routing/business-<tree-root-kebab>-<metric-kebab>.md
intents/business-<tree-root-kebab>-<metric-kebab>.md
```

一级指标目录：

| 一级指标 | code | 目录 |
| --- | --- | --- |
| 客数渗透率 | `custPenetrationRate` | `cust-penetration-rate` |
| 品效 | `brandProductEffectiveness` | `brand-product-effectiveness` |
| 活跃供应商数 | `activeVenderNum` | `active-vender-num` |

说明：

- template/spec/playbook 使用目录层级表达所属树。
- routing/intent 仍在顶层目录下，文件名带 `business-<tree-root-kebab>` 前缀，便于全局检索。
- 已完成的 `品效` 根指标继续使用现有路径，不在本计划中迁移。
- `activeVenderNum` 使用 CLI 返回的原始 code 拼写，目录也保留 `vender`，避免 code 和文件名之间产生歧义。

## 通用子任务交付标准

每个指标子任务都按以下固定交付项完成。

### 1. CLI 探索

对当前指标实际运行帮助和小样本命令，确认最小必要取数路径：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" search indicators tree --report business --keyword <指标名> --ai
"$QDM_CMR_CLI" report business indicators <time_filter> --indicator <指标名> --ai
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator <指标名>
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator <指标名>
"$QDM_CMR_CLI" report business area <time_filter> --indicator <指标名> --ai
"$QDM_CMR_CLI" report business category <time_filter> --indicator <指标名> --ai
"$QDM_CMR_CLI" report business trend <time_filter> --indicator <指标名> --ai
```

根据实际返回决定哪些模块为必要、哪些为可选。不得在未验证时直接写入 playbook。

### 2. Template

template 不是把指标树机械翻译成章节。每个指标的 template 都必须先基于该指标的实际 CLI 返回数据做业务调研，再沉淀成有商业分析深度的报告结构。

写 template 前必须完成：

- 查看当前指标的 `tree --values`、`tree --chart`、`area`、`category`、`trend` 等实际返回。
- 判断当前指标最常见的业务解释路径：规模、转化、价格、毛利、履约、供应链、区域分化、品类结构、趋势异常等。
- 识别当前指标在父指标中的业务作用：是驱动项、约束项、结果项、成本项、质量项还是风险项。
- 判断哪些维度证据最有解释力，哪些只是辅助信息。
- 明确该指标报告应该回答的核心业务问题，而不是只描述指标涨跌。

模板要求：

- 只服务当前指标，不复用其他指标章节。
- 保留当前指标在经营分析一级指标树中的父子链路。
- 所有数值、同比、环比、排名、异常、根因必须来自 CLI。
- CLI 未返回的指标行直接省略。
- 不使用 demo 数据或静态示例值。
- 必须包含商业分析深度：至少覆盖“现象 -> 影响 -> 根因推断 -> 行动建议”的分析链路。
- 必须体现业务洞察：说明当前指标变化对父指标、同级指标或业务结果的影响。
- 不写空泛建议；每条建议必须能回指 CLI 证据或报告中的问题诊断。
- 对根因保持证据边界：CLI 只支持趋势或结构异常时，只能写“可能”“倾向于”，不能写成已确认事实。

建议模板结构可以按指标类型调整：

- 根指标或一级驱动指标：整体表现、子指标拆解、结构分化、核心问题、根因推断、行动建议、风险跟踪。
- 中间指标：父子传导关系、子指标贡献/拖累、区域/品类/趋势异常、对父指标的影响、优化策略。
- 叶子指标：指标表现、异常定位、影响路径、结构证据、有限根因推断、执行动作。

### 3. Spec

spec 要定义：

- 当前指标 code、中文名、父指标、子指标。
- 当前指标在经营分析一级指标树中的位置。
- 当前指标允许使用的解释链路。
- 禁放规则。
- 与兄弟指标、父指标、子指标的边界。

frontmatter 要写得足够精确，避免泛经营问题误召回当前指标 spec：

- `title` 必须明确是当前指标层面的报告规则，例如“销售额指标报告规则”，不要写成“经营分析报告规则”。
- `tags` 可以包含 `business-report`、指标 code、一级指标树名，但不要只放过泛的 `business`、`overview`。
- `match.keywords` 只放当前指标的中文名、code、明确同义表达和“为什么下降/提升”等与当前指标绑定的表达。
- 不要把 `经营`、`经营分析`、`经营情况`、`业务表现`、`销售` 这类泛 domain 词放进指标级 spec 的 `match.keywords`。
- index child keywords 也必须保持窄匹配，只放当前指标词和 code，不放泛经营词。

### 4. Playbook

playbook 要定义：

- 命中表达。
- 非命中表达。
- CLI 探索后确认的必要模块。
- 并行取数策略。
- 必要模块成功后立即执行 `bin/data-harness-cli inject-template`。
- 绑定当前指标 template。

frontmatter 要保证只有用户明确问当前指标时才召回：

- `title` 必须明确当前指标，例如“销售额指标报告 Playbook”。
- `match.keywords` 只放当前指标名、code 和明确问题表达，例如“销售额为什么下降”“查看昨天销售额”。
- 不要把 `经营`、`经营分析`、`昨天经营情况`、`经营报告`、`业务表现` 放入指标级 playbook。
- 不要为了提高召回率加入父指标的大词，除非用户表达中父指标和当前指标同时出现时确实需要该 playbook。
- playbook index 的 child keywords 同样只放窄关键词；泛经营问题仍只应命中 `playbooks/business/default-overview.md`。

### 5. Routing

routing 要定义：

- 固定走 `qdm-cmr-cli report business`。
- 固定 `--indicator <当前指标名或 code>`。
- 禁止使用本地 demo 数据。
- 保持 template 注入门禁。

routing frontmatter 也要窄匹配：

- `match.keywords` 只放当前指标名、code 和明确当前指标分析表达。
- 不要把 `经营`、`经营分析`、`report business` 等泛词放进指标级 routing。
- `routing/index.md` 可以列出指标级路由，但不能依赖 index 的泛关键词触发所有指标 routing。

### 6. Intent

intent 要定义：

```yaml
query_type: business_<tree_root_snake>_<metric_snake>
report: business
indicator: <指标名>
depth: metric_report
needs_clarification: false
```

intent 文档也要避免泛化：

- 命中表达必须显式包含当前指标名或 code。
- 非命中里明确说明“查看昨天经营情况”“经营分析报告”等泛问不命中当前指标 intent。

### 6.1 Frontmatter 精准召回门禁

每个指标子任务完成前，必须人工检查新增 spec/playbook/routing 的 frontmatter：

```yaml
match:
  keywords:
    - <当前指标中文名>
    - <当前指标 code>
    - <当前指标明确同义词>
```

禁止出现在指标级 frontmatter 的关键词：

```text
经营
经营分析
经营情况
经营报告
业务表现
销售
report
business
```

例外：如果当前指标本身就是 `销售额`，可以使用“销售额”，但仍不能单独使用“销售”。

验收标准：

- `./bin/data-harness-cli context --question "查看昨天经营情况" --json` 不应召回任何指标级 spec/playbook/routing。
- `./bin/data-harness-cli context --question "查看昨天的<指标名>情况" --json` 应召回当前指标 spec/playbook/routing。
- 如果新增多个指标后发现泛问召回过多，优先收窄 frontmatter 和 index child keywords，再考虑调整候选选择代码。

### 7. Index 与候选选择

每个子任务都要更新：

- `spec/business/index.md`
- `playbooks/business/index.md`
- `routing/index.md`

如新增专项 playbook 后出现 default overview 混入，要调整或补充 `cli/internal/context/build.go` 的候选选择测试。

index 更新原则：

- domain index 顶层 `match.keywords` 不因新增指标而无限扩张；只有能表达 domain 召回且不会造成过度召回的词才放顶层。
- 指标级关键词优先放 child keywords。
- child keywords 也必须窄匹配，不放泛经营词。
- 如果一个词可能同时泛指 domain 和某个指标，优先通过更具体表达召回指标文件。

### 8. 验证

每个子任务至少验证：

```bash
./bin/data-harness-cli validate
./bin/data-harness-cli build-index
./bin/data-harness-cli context --question "<指标问题样例>" --json
./bin/data-harness-cli context --question "查看昨天经营情况" --json
go test ./cli/...
python3 -m unittest tests/test_qdm_harness_context.py
```

并补充：

- context 命中特定指标 playbook。
- 泛经营问题仍命中默认经营总览。
- 泛经营问题不召回当前指标级 spec/playbook/routing。
- `inject-template` 注入当前指标模板正文。

## 已确认指标树

### 客数渗透率树

```text
客数渗透率 custPenetrationRate
├─ 销售额 saleAmt
│  └─ 19点前销售占比 bf19SaleRate
│     ├─ 19点前销售重量 bf19SaleWeight
│     └─ 订单满足率 satisfiedRate
├─ 客数 custNum
│  └─ 19点前客数 bf19CustNum
│     ├─ 19点前PI值 bf19CategoryStoreCustRate
│     └─ 19点前复购率 bf19MemberRepurchaseRate
├─ 客单价 perCustAmt
│  └─ 19点前客单价 bf19PerCustAmt
│     ├─ 19点前单均件数 bf19AvgPieceNum
│     └─ 19点前件单价 bf19PerPieceAmt
├─ 全链路毛利率 fullLinkStoreProfitNotaxRate
│  ├─ 门店毛利率 profitRate
│  └─ 供应链毛利率 scmStoreProfitNotaxRate
└─ 全链路毛利额 fullLinkStoreProfitAmtNotax
   ├─ 门店毛利额 profitAmt
   └─ 供应链毛利额 scmStoreProfitAmtNotax
```

### 品效树

```text
品效 brandProductEffectiveness
├─ 商品订购渗透率 orderArticleRate
│  ├─ 订购门店数 orderStores
│  └─ 可订门店数 storeCanOrders
├─ 定价毛利率 prePriceProfitRate
│  ├─ 预期毛利率 preProfitRate
│  │  └─ 出库折让率 scmPromotionTotalRate
│  ├─ 时段折扣率 hourDiscountRate
│  ├─ 促销折扣率 promotionDiscountRate
│  └─ 损耗率 lostRate
└─ 售价价格指数(线上) priceIndex
   └─ 采购价格指数 purchasePriceIndex
```

### 活跃供应商数树

```text
活跃供应商数 activeVenderNum
├─ 集采入库占比 centralInstockRate
└─ 三率综合得分 threeRateScore
   ├─ 准确率 vendorAccuracyRate
   ├─ 准点率 vendorIntimeRate
   └─ 合格率 vendorQualificationRate
```

## 子任务清单

### 客数渗透率树子任务

| 任务 | 指标 | code | 父指标 | 子指标 | 建议文件前缀 |
| --- | --- | --- | --- | --- | --- |
| CPR-01 | 客数渗透率 | `custPenetrationRate` | 无 | 销售额、客数、客单价、全链路毛利率、全链路毛利额 | `cust-penetration-rate/cust-penetration-rate` |
| CPR-02 | 销售额 | `saleAmt` | 客数渗透率 | 19点前销售占比 | `cust-penetration-rate/sale-amt` |
| CPR-03 | 19点前销售占比 | `bf19SaleRate` | 销售额 | 19点前销售重量、订单满足率 | `cust-penetration-rate/bf19-sale-rate` |
| CPR-04 | 19点前销售重量 | `bf19SaleWeight` | 19点前销售占比 | 无 | `cust-penetration-rate/bf19-sale-weight` |
| CPR-05 | 订单满足率 | `satisfiedRate` | 19点前销售占比 | 无 | `cust-penetration-rate/satisfied-rate` |
| CPR-06 | 客数 | `custNum` | 客数渗透率 | 19点前客数 | `cust-penetration-rate/cust-num` |
| CPR-07 | 19点前客数 | `bf19CustNum` | 客数 | 19点前PI值、19点前复购率 | `cust-penetration-rate/bf19-cust-num` |
| CPR-08 | 19点前PI值 | `bf19CategoryStoreCustRate` | 19点前客数 | 无 | `cust-penetration-rate/bf19-category-store-cust-rate` |
| CPR-09 | 19点前复购率 | `bf19MemberRepurchaseRate` | 19点前客数 | 无 | `cust-penetration-rate/bf19-member-repurchase-rate` |
| CPR-10 | 客单价 | `perCustAmt` | 客数渗透率 | 19点前客单价 | `cust-penetration-rate/per-cust-amt` |
| CPR-11 | 19点前客单价 | `bf19PerCustAmt` | 客单价 | 19点前单均件数、19点前件单价 | `cust-penetration-rate/bf19-per-cust-amt` |
| CPR-12 | 19点前单均件数 | `bf19AvgPieceNum` | 19点前客单价 | 无 | `cust-penetration-rate/bf19-avg-piece-num` |
| CPR-13 | 19点前件单价 | `bf19PerPieceAmt` | 19点前客单价 | 无 | `cust-penetration-rate/bf19-per-piece-amt` |
| CPR-14 | 全链路毛利率 | `fullLinkStoreProfitNotaxRate` | 客数渗透率 | 门店毛利率、供应链毛利率 | `cust-penetration-rate/full-link-store-profit-notax-rate` |
| CPR-15 | 门店毛利率 | `profitRate` | 全链路毛利率 | 无 | `cust-penetration-rate/profit-rate` |
| CPR-16 | 供应链毛利率 | `scmStoreProfitNotaxRate` | 全链路毛利率 | 无 | `cust-penetration-rate/scm-store-profit-notax-rate` |
| CPR-17 | 全链路毛利额 | `fullLinkStoreProfitAmtNotax` | 客数渗透率 | 门店毛利额、供应链毛利额 | `cust-penetration-rate/full-link-store-profit-amt-notax` |
| CPR-18 | 门店毛利额 | `profitAmt` | 全链路毛利额 | 无 | `cust-penetration-rate/profit-amt` |
| CPR-19 | 供应链毛利额 | `scmStoreProfitAmtNotax` | 全链路毛利额 | 无 | `cust-penetration-rate/scm-store-profit-amt-notax` |

### 品效树子任务

`品效 brandProductEffectiveness` 根指标已完成，本清单只包含下游指标。

| 任务 | 指标 | code | 父指标 | 子指标 | 建议文件前缀 |
| --- | --- | --- | --- | --- | --- |
| BPE-01 | 商品订购渗透率 | `orderArticleRate` | 品效 | 订购门店数、可订门店数 | `brand-product-effectiveness/order-article-rate` |
| BPE-02 | 订购门店数 | `orderStores` | 商品订购渗透率 | 无 | `brand-product-effectiveness/order-stores` |
| BPE-03 | 可订门店数 | `storeCanOrders` | 商品订购渗透率 | 无 | `brand-product-effectiveness/store-can-orders` |
| BPE-04 | 定价毛利率 | `prePriceProfitRate` | 品效 | 预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率 | `brand-product-effectiveness/pre-price-profit-rate` |
| BPE-05 | 预期毛利率 | `preProfitRate` | 定价毛利率 | 出库折让率 | `brand-product-effectiveness/pre-profit-rate` |
| BPE-06 | 出库折让率 | `scmPromotionTotalRate` | 预期毛利率 | 无 | `brand-product-effectiveness/scm-promotion-total-rate` |
| BPE-07 | 时段折扣率 | `hourDiscountRate` | 定价毛利率 | 无 | `brand-product-effectiveness/hour-discount-rate` |
| BPE-08 | 促销折扣率 | `promotionDiscountRate` | 定价毛利率 | 无 | `brand-product-effectiveness/promotion-discount-rate` |
| BPE-09 | 损耗率 | `lostRate` | 定价毛利率 | 无 | `brand-product-effectiveness/lost-rate` |
| BPE-10 | 售价价格指数(线上) | `priceIndex` | 品效 | 采购价格指数 | `brand-product-effectiveness/price-index` |
| BPE-11 | 采购价格指数 | `purchasePriceIndex` | 售价价格指数(线上) | 无 | `brand-product-effectiveness/purchase-price-index` |

### 活跃供应商数树子任务

| 任务 | 指标 | code | 父指标 | 子指标 | 建议文件前缀 |
| --- | --- | --- | --- | --- | --- |
| AVN-01 | 活跃供应商数 | `activeVenderNum` | 无 | 集采入库占比、三率综合得分 | `active-vender-num/active-vender-num` |
| AVN-02 | 集采入库占比 | `centralInstockRate` | 活跃供应商数 | 无 | `active-vender-num/central-instock-rate` |
| AVN-03 | 三率综合得分 | `threeRateScore` | 活跃供应商数 | 准确率、准点率、合格率 | `active-vender-num/three-rate-score` |
| AVN-04 | 准确率 | `vendorAccuracyRate` | 三率综合得分 | 无 | `active-vender-num/vendor-accuracy-rate` |
| AVN-05 | 准点率 | `vendorIntimeRate` | 三率综合得分 | 无 | `active-vender-num/vendor-intime-rate` |
| AVN-06 | 合格率 | `vendorQualificationRate` | 三率综合得分 | 无 | `active-vender-num/vendor-qualification-rate` |

## 每个子任务的文件展开规则

以上表格中的 `建议文件前缀` 展开为：

```text
templates/business/<建议文件前缀>-report.md
spec/business/<建议文件前缀>.md
playbooks/business/<建议文件前缀>.md
routing/business-<建议文件前缀中的 / 替换为 ->.md
intents/business-<建议文件前缀中的 / 替换为 ->.md
```

示例：`cust-penetration-rate/sale-amt`

```text
templates/business/cust-penetration-rate/sale-amt-report.md
spec/business/cust-penetration-rate/sale-amt.md
playbooks/business/cust-penetration-rate/sale-amt.md
routing/business-cust-penetration-rate-sale-amt.md
intents/business-cust-penetration-rate-sale-amt.md
```

## 建议实施顺序

优先级按一级指标树和业务复用价值推进：

1. 客数渗透率根指标及一级子指标：CPR-01、CPR-02、CPR-06、CPR-10、CPR-14、CPR-17
2. 品效下游一级驱动：BPE-04、BPE-01、BPE-10
3. 活跃供应商数根指标及一级子指标：AVN-01、AVN-02、AVN-03
4. 高频诊断叶子指标：BPE-09、BPE-11、AVN-04、AVN-05、AVN-06
5. 客数渗透率 19 点前链路：CPR-03、CPR-04、CPR-05、CPR-07、CPR-08、CPR-09、CPR-11、CPR-12、CPR-13
6. 客数渗透率毛利链路叶子指标：CPR-15、CPR-16、CPR-18、CPR-19
7. 品效剩余叶子指标：BPE-02、BPE-03、BPE-05、BPE-06、BPE-07、BPE-08

理由：

- 先做根指标和一级子指标，能沉淀每棵树的模板结构。
- 再做业务诊断高频叶子指标，如损耗率、采购价格指数、供应商三率。
- 最后补齐更细的 19 点前链路、毛利链路和门店数类指标。

## 每个子任务完成定义

一个指标子任务只有在以下全部满足时才算完成：

- 已完成该指标 CLI 探索，并记录最终必要命令。
- 已基于该指标实际返回数据完成业务调研，明确模板应回答的核心业务问题。
- 已新增或更新该指标 template。
- template 具备商业分析深度和业务洞察，不只是指标树复述或数据填空。
- 已新增该指标 spec。
- 已新增该指标 playbook 并绑定 template。
- 已新增该指标 routing。
- 已新增该指标 intent。
- 已更新 spec/playbook/routing index。
- 已通过 context 验证，问题能命中当前指标 playbook。
- 已通过 inject-template 验证，注入当前指标模板正文。
- 已通过泛经营问题回归，默认 overview 未被破坏。
- 已通过 `validate`、`build-index`、Go 测试和 Python 测试。
