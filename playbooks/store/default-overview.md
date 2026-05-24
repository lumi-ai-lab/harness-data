---
id: playbook-store-default-overview
kind: playbook
domain: store
title: 门店管理默认取数 Playbook
tags:
  - playbook
  - store-report
match:
  keywords:
    - 门店管理
    - 门店运营
    - 门店报告
---

# 门店管理深度报告 Playbook

## 目标

把“昨天的门店管理情况”等门店管理类问题输出为一份结构稳定、证据可追溯、可行动的门店管理深度报告。

分析主线固定为：

1. 门店规模与健康度
2. 门店盈利与运营效率

最终报告版式、章节顺序和表格结构在 signal 后由二阶段注入的 template 决定。

## 适用边界

适用于用户询问门店管理、门店情况、门店规模、门店利润、门店健康度、门店运营效率等问题。

不适用于：

- 泛问经营概览、销售经营分析、品效或供应链整体分析。
- 单个指标定义解释。
- 用户明确要求走指标平台、指标口径或非 CMR 报表的问题。

命中该 playbook 后，不向用户追问；若用户未给时间，默认使用昨天；若用户未给区域，默认使用全国（不含港澳）；品类固定为全品类。

## 输入与口径确认

执行查询前先归一化以下口径：

- 时间口径：支持日期、周、月；“昨天”使用 `<time_filter>`。
- 区域口径：区域支持下钻。未指定区域时使用 `--area-type 管理区域 --area CN00`，即全国（不含港澳）。
- 品类口径：门店管理报表品类不支持下钻，也不做业务过滤，固定使用 `--category-type 大分类 --category 00`，即全品类。
- 报告范围：从 `overview.filters` 返回结果中确认 report、时间、区域、品类解析结果。

“昨天的门店管理情况（全品类，全国维度）”在 2026-05-22 执行时，对应 CLI 过滤条件为：

```bash
--date 2026-05-21 --area-type 管理区域 --area CN00 --category-type 大分类 --category 00
```

## 查询原则

默认全国维度、全品类口径下，`qdm-cmr-cli report store overview <time_filter> --ai` 是唯一必需查询。源头支持 `--ai`，会返回 compact 的 `#section/#cols/#data` 结构，包含 `indicators`、`area`、`category`、`trend`，足够支撑核心报告取数。`overview` 成功后，下一步必须立即执行 `before-report-signal.py store-overview`。

Agent 不应在默认全国全品类场景下主动拆开调用 `inspect`、`tree --values`、`indicators`、`area`、`trend` 或 `table`。只有在以下情况才允许补充探索：

- 用户指定了非全国区域，需要确认该区域下的可用下钻证据。
- `overview --ai` 返回缺失、为空或口径异常。
- 需要读取完整 `filters` JSON 来确认 report/time/area/category。
- 报告需要区域维度子指标明细，而 `overview.area` 只能提供一级指标分布。
- 需要校验前端图谱父子结构，而不是生成常规报告正文。

## 推荐查询方式

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/common/cmr-cli-readme.md` 与 `spec/common/time-policy.md` 为准。

使用 `qdm-cmr-cli report store overview --ai` 作为门店管理报表主取数入口。该命令一次返回 compact 的 `indicators`、`area`、`category`、`trend`；对“昨天的门店管理情况（全品类、全国维度）”这类报告，已经可以覆盖核心指标值、同比、环比、区域和趋势基础证据。

默认推荐命令：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report store overview <time_filter> --ai
```

只有需要完整 JSON 结构或 `filters` 字段时，才执行非 `--ai` 版本：

```bash
"$QDM_CMR_CLI" report store overview <time_filter>
```

若非全国区域或区域下钻场景需要同时分析两条主线，仍优先使用 `overview` 并分别指定一级指标；`overview` 会把 `area` 和 `trend` 切换到对应指标，`indicators` 仍返回全量指标：

```bash
"$QDM_CMR_CLI" report store overview <time_filter> --indicator 营业门店数 --ai
"$QDM_CMR_CLI" report store overview <time_filter> --indicator 门店净利润 --ai
```

## 可选校验与补充

仅在 `overview` 不够时补充独立模块：

- 需要进一步确认过滤条件解析且非 `--ai` 的 `overview` 仍不够时，用 `inspect`。
- 需要展示或校验报表图谱父子关系时，用 `tree --values`。
- 需要区域维度子指标明细时，用 `table`。

```bash
"$QDM_CMR_CLI" report store inspect <time_filter>
"$QDM_CMR_CLI" report store tree --values <time_filter>
"$QDM_CMR_CLI" table --report store <time_filter> --indicator 营业门店数 --dim-type 管理区域 --ai
"$QDM_CMR_CLI" table --report store <time_filter> --indicator 门店净利润 --dim-type 管理区域 --ai
```

`table` 用于补充区域明细。营业门店数表会同时返回净增门店数、开店数、待开业门店数、闭店数、停业超30天门店数、存量门店数、停业门店数等子指标；门店净利润表会同时返回盈亏平衡点、坪效、门店面积、人效、门店人数等子指标。

除非有明确的结构校验或明细下钻需求，不需要把 `overview` 拆成 `indicators`、`area`、`trend` 多次查询。

## 品类下钻规则

门店管理报表不做品类下钻。实测：

```bash
"$QDM_CMR_CLI" report store category <time_filter> --indicator 营业门店数 --ai
```

返回空结构：

```text
#cols:
#data:
```

因此生成门店管理报告时不得调用品类维度进行分析，不得生成品类排名、品类拖累或品类贡献。

## 指标树与取数映射

### 门店规模与健康度

核心路径：

```text
营业门店数 -> 净增门店数、存量门店数、停业门店数 -> 开店数/闭店数 -> 待开业门店数/停业超30天门店数
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 营业门店数 | `stores` | `overview.indicators` | 核心一级指标，衡量门店网络规模 |
| 净增门店数 | `increaseStores` | `overview.indicators` | 解释规模净增长 |
| 开店数 | `openStores` | `overview.indicators` | 解释新增门店落地 |
| 待开业门店数 | `unopenStores` | `overview.indicators` | 解释潜在扩张储备 |
| 闭店数 | `closeStores` | `overview.indicators` | 解释门店退出 |
| 停业超30天门店数 | `stop30dayStores` | `overview.indicators` | 解释长期停业和资源占用 |
| 存量门店数 | `stockStores` | `overview.indicators` | 解释门店基础盘 |
| 停业门店数 | `stopBusinessStores` | `overview.indicators` | 解释短期停业风险 |

2026-05-21 全国全品类实测值：

| 指标 | 当前值 | 环比 | 同比 |
| :--- | :--- | :--- | :--- |
| 营业门店数 | 2876 | +10 | -1 |
| 净增门店数 | 0 | 0 | +2 |
| 开店数 | 0 | 0 | 0 |
| 待开业门店数 | 51 | +2 | 0 |
| 闭店数 | 0 | 0 | -2 |
| 停业超30天门店数 | 9 | 0 | 0 |
| 存量门店数 | 2893 | +5 | -5 |
| 停业门店数 | 17 | -5 | -4 |

### 门店盈利与运营效率

核心路径：

```text
门店净利润 -> 盈亏平衡点、坪效、人效 -> 成本支出、门店面积、门店人数
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 门店净利润 | `netProfit` | `overview.indicators` | 核心一级指标，衡量整体盈利水平 |
| 盈亏平衡点 | `breakEvenPoint` | `overview.indicators` | 解释单店盈利门槛和成本压力 |
| 员工工资 | `storeTotalSalary` | `overview.indicators` | 成本结构 |
| 租金和物业管理费 | `storeDormTotalRent` | `overview.indicators` | 成本结构 |
| 店铺水电费 | `waterRent` | `overview.indicators` | 成本结构 |
| 门店其他支出 | `storeOtherFee` | `overview.indicators` | 成本结构 |
| 坪效 | `areaEffective` | `overview.indicators` | 单位面积产出 |
| 门店面积 | `storeArea` | `overview.indicators` | 解释坪效 |
| 人效 | `laborEffective` | `overview.indicators` | 单位人力产出 |
| 门店人数 | `storeNum` | `overview.indicators` | 解释人效 |

2026-05-21 全国全品类实测值：

| 指标 | 当前值 | 环比 | 同比 |
| :--- | :--- | :--- | :--- |
| 门店净利润 | 632.14 | 0 | 0 |
| 盈亏平衡点 | 1864.29 | 0 | 0 |
| 员工工资 | 968.43 | 0 | 0 |
| 租金和物业管理费 | 460.65 | 0 | 0 |
| 店铺水电费 | 100.78 | 0 | 0 |
| 门店其他支出 | 334.42 | 0 | 0 |
| 坪效 | 207.26 | +1.7% | -0.07% |
| 门店面积 | 56.91 | +0.12% | -0.02% |
| 人效 | 2246.26 | +1.16 | +37.11 |
| 门店人数 | 5.25 | 0 | 0 |

## 区域和趋势证据

区域支持下钻，优先使用 `overview` 的 `area` section。需要切换区域和趋势对应的指标时，在 `overview` 上指定 `--indicator`：

```bash
"$QDM_CMR_CLI" report store overview <time_filter> --indicator 营业门店数 --ai
"$QDM_CMR_CLI" report store overview <time_filter> --indicator 门店净利润 --ai
```

需要子指标明细时使用：

```bash
"$QDM_CMR_CLI" table --report store <time_filter> --indicator 营业门店数 --dim-type 管理区域 --ai
"$QDM_CMR_CLI" table --report store <time_filter> --indicator 门店净利润 --dim-type 管理区域 --ai
```

趋势支持近 30 天对比，来自 `overview` 的 `trend` section。

## 证据优先级

1. `overview.filters` 确认口径解析。
2. `overview.indicators` 确认当前值、同比、环比、阈值、单位和指标 code。
3. `overview.area` 和 `overview.trend` 提供区域与趋势证据。
4. `tree --values` 仅用于需要校验图谱父子关系的场景。
5. `table --ai` 仅用于区域维度子指标明细，不替代 `overview`。

## 报告生成约束

- `overview` 成功取数后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py store-overview`。
- `overview` 成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- signal 前不读取、不打开、不猜测、不使用 template。
- 最终报告必须使用 signal 后二阶段注入的 template。
- 章节顺序保持 signal 后 template 的结构。
- 第二章只展示营业门店数、门店净利润两项一级核心指标。
- 第三章只放门店规模与健康度指标。
- 第四章只放门店盈利与运营效率指标。
- 第五章只做区域下钻或区域证据总结。
- 不输出品类下钻章节或品类结论。
- 所有数值、同比、环比、阈值、排名、异常点必须来自 CLI 输出。
- CLI 未返回的指标行、指标组或段落直接省略，不补造。
