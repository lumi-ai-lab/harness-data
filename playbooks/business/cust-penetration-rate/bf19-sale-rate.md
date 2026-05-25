---
id: playbook-business-cust-penetration-rate-bf19-sale-rate
kind: playbook
domain: business
title: 19点前销售占比指标报告 Playbook
tags:
  - playbook
  - cust-penetration-rate
  - bf19SaleRate
match:
  keywords:
    - 19点前销售占比
    - bf19SaleRate
    - 19点前销售占比情况
    - 19点前销售占比为什么下降
    - 19点前销售占比为什么提升
template: templates/business/cust-penetration-rate/bf19-sale-rate-report.md
---

# 19点前销售占比指标报告 Playbook

## 目标

把“查看19点前销售占比情况”“分析19点前销售占比为什么下降/提升”等问题输出为经营分析下客数渗透率树中的19点前销售占比专项报告。

## 适用边界

适用于：

- 查看昨天的19点前销售占比情况
- 19点前销售占比为什么下降
- 19点前销售占比为什么提升
- bf19SaleRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问销售额、19点前销售重量、订单满足率、客数、客单价、毛利等其他指标专项的问题。

## CLI 探索结论

已对 `19点前销售占比` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 19点前销售占比 --ai` 可返回固定链路 `客数渗透率 -> 销售额 -> 19点前销售占比 -> 19点前销售重量、订单满足率`，当前指标为 `bf19SaleRate`。
- `report business indicators --date 2026-05-23 --indicator 19点前销售占比 --ai` 可返回当前值、同比、环比、阈值字段；样本中阈值为 `GT 78`。
- `report business tree --values --date 2026-05-23 --indicator 19点前销售占比` 可返回经营分析完整树，selected indicator 为 `bf19SaleRate`。
- `report business tree --chart --date 2026-05-23 --indicator 19点前销售占比 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 19点前销售占比 --ai` 均可独立返回压缩结构证据；样本中整体略高于阈值，部分区域和品类低于阈值。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `19点前销售占比`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 19点前销售占比 --ai`
- `report business tree --values <time_filter> --indicator 19点前销售占比`
- `report business tree --chart <time_filter> --indicator 19点前销售占比`
- `report business area <time_filter> --indicator 19点前销售占比 --ai`
- `report business category <time_filter> --indicator 19点前销售占比 --ai`
- `report business trend <time_filter> --indicator 19点前销售占比 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 19点前销售占比 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 19点前销售占比 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 19点前销售占比 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 19点前销售占比 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 19点前销售占比 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 19点前销售占比 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的19点前销售占比及必要的父级销售额、客数渗透率和子指标传导证据。
- 区域、品类、趋势证据只作为19点前销售占比链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
