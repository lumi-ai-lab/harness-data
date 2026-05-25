---
id: playbook-business-brand-product-effectiveness-pre-price-profit-rate
kind: playbook
domain: business
title: 定价毛利率指标报告 Playbook
tags:
  - playbook
  - business-report
  - brand-product-effectiveness
  - prePriceProfitRate
match:
  keywords:
    - 定价毛利率
    - prePriceProfitRate
    - 定价毛利率情况
    - 定价毛利率为什么下降
    - 定价毛利率为什么提升
template: templates/business/brand-product-effectiveness/pre-price-profit-rate-report.md
---

# 定价毛利率指标报告 Playbook

## 目标

把“查看定价毛利率情况”“分析定价毛利率为什么下降/提升”等问题输出为经营分析下品效树中的定价毛利率专项报告。

## 适用边界

适用于：

- 查看昨天的定价毛利率情况
- 分析昨日定价毛利率
- 定价毛利率为什么下降
- 定价毛利率为什么提升
- prePriceProfitRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问品效、商品订购渗透率、预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率、售价价格指数、采购价格指数等其他指标专项的问题。

## CLI 探索结论

已对 `定价毛利率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 定价毛利率 --ai` 可返回父指标品效、当前指标定价毛利率及子指标预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率。
- `report business indicators --date 2026-05-23 --indicator 定价毛利率 --ai` 可返回当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 定价毛利率` 可返回经营分析完整树，selected indicator 为 `prePriceProfitRate`。
- `report business tree --chart --date 2026-05-23 --indicator 定价毛利率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 定价毛利率 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `定价毛利率`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 定价毛利率 --ai`
- `report business tree --values <time_filter> --indicator 定价毛利率`
- `report business tree --chart <time_filter> --indicator 定价毛利率`
- `report business area <time_filter> --indicator 定价毛利率 --ai`
- `report business category <time_filter> --indicator 定价毛利率 --ai`
- `report business trend <time_filter> --indicator 定价毛利率 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 定价毛利率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 定价毛利率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 定价毛利率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 定价毛利率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 定价毛利率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 定价毛利率 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的定价毛利率、预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率及必要的父级品效传导证据。
- 区域、品类、趋势证据只作为定价毛利率链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
