---
id: playbook-business-brand-product-effectiveness-price-index
kind: playbook
domain: business
title: 售价价格指数指标报告 Playbook
tags:
  - playbook
  - business-report
  - brand-product-effectiveness
  - priceIndex
match:
  keywords:
    - 售价价格指数
    - 售价价格指数(线上)
    - priceIndex
    - 售价价格指数情况
    - 售价价格指数为什么下降
    - 售价价格指数为什么提升
template: templates/business/brand-product-effectiveness/price-index-report.md
---

# 售价价格指数指标报告 Playbook

## 目标

把“查看售价价格指数情况”“分析售价价格指数为什么下降/提升”等问题输出为经营分析下品效树中的售价价格指数(线上)专项报告。

## 适用边界

适用于：

- 查看昨天的售价价格指数情况
- 查看昨天的售价价格指数(线上)情况
- 售价价格指数为什么下降
- 售价价格指数为什么提升
- priceIndex 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问品效、采购价格指数、商品订购渗透率、定价毛利率等其他指标专项的问题。

## CLI 探索结论

已对 `售价价格指数(线上)` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 售价价格指数(线上) --ai` 可返回父指标品效、当前指标售价价格指数(线上)及子指标采购价格指数。
- `report business indicators --date 2026-05-23 --indicator 售价价格指数(线上) --ai` 可返回当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 售价价格指数(线上)` 可返回经营分析完整树，selected indicator 为 `priceIndex`。
- `report business tree --chart --date 2026-05-23 --indicator 售价价格指数(线上) --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 售价价格指数(线上) --ai` 均可独立返回压缩结构证据；area/trend 可能返回 null、0 或跳点，最终报告只能按 CLI 事实描述。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `售价价格指数(线上)`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 售价价格指数(线上) --ai`
- `report business tree --values <time_filter> --indicator 售价价格指数(线上)`
- `report business tree --chart <time_filter> --indicator 售价价格指数(线上)`
- `report business area <time_filter> --indicator 售价价格指数(线上) --ai`
- `report business category <time_filter> --indicator 售价价格指数(线上) --ai`
- `report business trend <time_filter> --indicator 售价价格指数(线上) --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator '售价价格指数(线上)' --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator '售价价格指数(线上)' &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator '售价价格指数(线上)' &
"$QDM_CMR_CLI" report business area <time_filter> --indicator '售价价格指数(线上)' --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator '售价价格指数(线上)' --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator '售价价格指数(线上)' --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的售价价格指数(线上)、采购价格指数及必要的父级品效传导证据。
- 区域、品类、趋势证据只作为售价价格指数链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
