---
id: playbook-business-brand-product-effectiveness-hour-discount-rate
kind: playbook
domain: business
title: 时段折扣率指标报告 Playbook
tags:
  - playbook
  - business-report
  - brand-product-effectiveness
  - hourDiscountRate
match:
  keywords:
    - 时段折扣率
    - hourDiscountRate
    - 时段折扣率情况
    - 时段折扣率为什么下降
    - 时段折扣率为什么提升
template: templates/business/brand-product-effectiveness/hour-discount-rate-report.md
---

# 时段折扣率指标报告 Playbook

## 目标

把“查看时段折扣率情况”“分析时段折扣率为什么下降/提升”等问题输出为经营分析下品效树中定价毛利率链路的时段折扣率专项报告。

## 适用边界

适用于：

- 查看昨天的时段折扣率情况
- 分析昨日时段折扣率
- 时段折扣率为什么下降
- 时段折扣率为什么提升
- hourDiscountRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问品效、定价毛利率、预期毛利率、出库折让率、促销折扣率、损耗率、商品订购渗透率等其他指标专项的问题。

## CLI 探索结论

已对 `时段折扣率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 时段折扣率 --ai` 返回 `hourDiscountRate`，路径为 `品效 -> 定价毛利率 -> 时段折扣率`。
- `report business indicators --date 2026-05-23 --indicator 时段折扣率 --ai` 可返回时段折扣率及相关指标的当前值、阈值、同比、环比字段；样本中当前值 0.12557199756432869，阈值 BETWEEN 12.5 和 14.5，环比 -0.0119，同比 0.0145。
- `report business tree --values --date 2026-05-23 --indicator 时段折扣率` 可返回经营分析完整树，selected indicator 为 `hourDiscountRate`，并包含父级定价毛利率 0.3648983843858695。
- `report business tree --chart --date 2026-05-23 --indicator 时段折扣率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 时段折扣率 --ai` 均可独立返回压缩结构证据；样本中华东、重庆高于上限，冷藏加工、预制菜折扣率较高，趋势在 2026-05-20 达到阶段高点后回落。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `时段折扣率`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 时段折扣率 --ai`
- `report business tree --values <time_filter> --indicator 时段折扣率`
- `report business tree --chart <time_filter> --indicator 时段折扣率`
- `report business area <time_filter> --indicator 时段折扣率 --ai`
- `report business category <time_filter> --indicator 时段折扣率 --ai`
- `report business trend <time_filter> --indicator 时段折扣率 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 时段折扣率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 时段折扣率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 时段折扣率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 时段折扣率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 时段折扣率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 时段折扣率 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的时段折扣率及必要的父级定价毛利率、品效传导证据。
- 区域、品类、趋势证据只作为时段折扣率链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
