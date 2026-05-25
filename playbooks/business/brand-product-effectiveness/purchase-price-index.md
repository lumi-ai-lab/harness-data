---
id: playbook-business-brand-product-effectiveness-purchase-price-index
kind: playbook
domain: business
title: 采购价格指数指标报告 Playbook
tags:
  - playbook
  - brand-product-effectiveness
  - purchasePriceIndex
match:
  keywords:
    - 采购价格指数
    - purchasePriceIndex
    - 采购价格指数情况
    - 采购价格指数为什么下降
    - 采购价格指数为什么提升
template: templates/business/brand-product-effectiveness/purchase-price-index-report.md
---

# 采购价格指数指标报告 Playbook

## 目标

把“查看采购价格指数情况”“分析采购价格指数为什么下降/提升”等问题输出为经营分析下品效树中的采购价格指数专项报告。

## 适用边界

适用于：

- 查看昨天的采购价格指数情况
- 采购价格指数为什么下降
- 采购价格指数为什么提升
- purchasePriceIndex 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问品效、售价价格指数(线上)、商品订购渗透率、定价毛利率、损耗率等其他指标专项的问题。

## CLI 探索结论

已对 `采购价格指数` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 采购价格指数 --ai` 可返回固定链路 `品效 -> 售价价格指数(线上) -> 采购价格指数`，当前指标为 `purchasePriceIndex`。
- `report business indicators --date 2026-05-23 --indicator 采购价格指数 --ai` 可返回采购价格指数当前值、同比、环比字段。
- `report business tree --values --date 2026-05-23 --indicator 采购价格指数` 可返回经营分析完整树，selected indicator 为 `purchasePriceIndex`，父指标为 `priceIndex`。
- `report business tree --chart --date 2026-05-23 --indicator 采购价格指数 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area --date 2026-05-23 --indicator 采购价格指数 --ai` 可返回区域采购价格指数，其中部分区域高于阈值 100，部分区域返回 0 或 null。
- `report business category --date 2026-05-23 --indicator 采购价格指数 --ai` 可返回品类采购价格指数，样本中蔬菜为非零品类，其他品类返回 0。
- `report business trend --date 2026-05-23 --indicator 采购价格指数 --ai` 可返回近 30 天趋势，样本中存在连续 0 值和末期恢复点，最终报告只能按 CLI 事实描述。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `采购价格指数`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 采购价格指数 --ai`
- `report business tree --values <time_filter> --indicator 采购价格指数`
- `report business tree --chart <time_filter> --indicator 采购价格指数`
- `report business area <time_filter> --indicator 采购价格指数 --ai`
- `report business category <time_filter> --indicator 采购价格指数 --ai`
- `report business trend <time_filter> --indicator 采购价格指数 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator '采购价格指数' --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator '采购价格指数' &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator '采购价格指数' &
"$QDM_CMR_CLI" report business area <time_filter> --indicator '采购价格指数' --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator '采购价格指数' --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator '采购价格指数' --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的采购价格指数及必要的父级售价价格指数(线上)、品效传导证据。
- 区域、品类、趋势证据只作为采购价格指数链路的结构性佐证。
- 高于阈值的区域或品类可描述为采购成本压力；低于阈值的区域或品类可描述为成本端相对缓和或价格优势证据。
- CLI 返回 null、0 或跳点时，只能描述为数据异常或结构异常，不能估算修正。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
