---
id: playbook-business-brand-product-effectiveness-store-can-orders
kind: playbook
domain: business
title: 可订门店数指标报告 Playbook
tags:
  - playbook
  - business-report
  - brand-product-effectiveness
  - storeCanOrders
match:
  keywords:
    - 可订门店数
    - storeCanOrders
    - 可订门店数情况
    - 可订门店数为什么下降
    - 可订门店数为什么提升
template: templates/business/brand-product-effectiveness/store-can-orders-report.md
---

# 可订门店数指标报告 Playbook

## 目标

把“查看可订门店数情况”“分析可订门店数为什么下降/提升”等问题输出为经营分析下品效树中商品订购渗透率链路的可订门店数专项报告。

## 适用边界

适用于：

- 查看昨天的可订门店数情况
- 分析昨日可订门店数
- 可订门店数为什么下降
- 可订门店数为什么提升
- storeCanOrders 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问品效、商品订购渗透率、订购门店数、定价毛利率、售价价格指数、采购价格指数等其他指标专项的问题。

## CLI 探索结论

已对 `可订门店数` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 可订门店数 --ai` 返回 `storeCanOrders`，路径为 `品效 -> 商品订购渗透率 -> 可订门店数`。
- `report business indicators --date 2026-05-23 --indicator 可订门店数 --ai` 可返回可订门店数及相关指标的当前值、同比、环比字段；样本中当前值 508.3606982778957，环比 -0.0017，同比 -0.0113。
- `report business tree --values --date 2026-05-23 --indicator 可订门店数` 可返回经营分析完整树，selected indicator 为 `storeCanOrders`，并包含父级商品订购渗透率 0.27158512688888015、同组订购门店数 176.0280726586459。
- `report business tree --chart --date 2026-05-23 --indicator 可订门店数 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 可订门店数 --ai` 均可独立返回压缩结构证据；样本中粤西、粤东可订门店基数最大，但多区域同比为负，30 天趋势多数低于对比值。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `可订门店数`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 可订门店数 --ai`
- `report business tree --values <time_filter> --indicator 可订门店数`
- `report business tree --chart <time_filter> --indicator 可订门店数`
- `report business area <time_filter> --indicator 可订门店数 --ai`
- `report business category <time_filter> --indicator 可订门店数 --ai`
- `report business trend <time_filter> --indicator 可订门店数 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 可订门店数 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 可订门店数 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 可订门店数 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 可订门店数 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 可订门店数 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 可订门店数 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的可订门店数及必要的父级商品订购渗透率、品效传导证据。
- 订购门店数只作为同组补充，用于说明实际订购承接，不替代可订门店数主线。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
