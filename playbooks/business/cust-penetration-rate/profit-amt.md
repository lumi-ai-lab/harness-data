---
id: playbook-business-cust-penetration-rate-profit-amt
kind: playbook
domain: business
title: 门店毛利额指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - profitAmt
match:
  keywords:
    - 门店毛利额
    - profitAmt
    - 门店毛利额情况
    - 门店毛利额为什么下降
    - 门店毛利额为什么提升
template: templates/business/cust-penetration-rate/profit-amt-report.md
---

# 门店毛利额指标报告 Playbook

## 目标

把“查看门店毛利额情况”“分析门店毛利额为什么下降/提升”等问题输出为经营分析下客数渗透率树中的门店毛利额专项报告。

## 适用边界

适用于：

- 查看昨天的门店毛利额情况
- 分析昨日门店毛利额
- 门店毛利额为什么下降
- 门店毛利额为什么提升
- profitAmt 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问全链路毛利额、供应链毛利额、全链路毛利率、门店毛利率、销售额、客数、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `门店毛利额` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 门店毛利额 --ai` 返回 `profitAmt`，路径为 `客数渗透率 -> 全链路毛利额 -> 门店毛利额`。
- `report business indicators --date 2026-05-23 --indicator 门店毛利额 --ai` 可返回门店毛利额及相关指标的当前值、阈值、同比、环比字段；样本中当前值 2978.2138154395852，阈值 GE 2952.121507489769，环比 0.1902，同比 -0.07。
- `report business tree --values --date 2026-05-23 --indicator 门店毛利额` 可返回经营分析完整树，selected indicator 为 `profitAmt`，并包含父级全链路毛利额 4217.478029103727、同组供应链毛利额 1239.2642136641439。
- `report business tree --chart --date 2026-05-23 --indicator 门店毛利额 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 门店毛利额 --ai` 均可独立返回压缩结构证据；样本中重庆、成都低于阈值，多数品类同比为负，最近一天高于对比值。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `门店毛利额`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 门店毛利额 --ai`
- `report business tree --values <time_filter> --indicator 门店毛利额`
- `report business tree --chart <time_filter> --indicator 门店毛利额`
- `report business area <time_filter> --indicator 门店毛利额 --ai`
- `report business category <time_filter> --indicator 门店毛利额 --ai`
- `report business trend <time_filter> --indicator 门店毛利额 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 门店毛利额 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 门店毛利额 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 门店毛利额 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 门店毛利额 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 门店毛利额 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 门店毛利额 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的门店毛利额及必要的父级全链路毛利额、客数渗透率传导证据。
- 供应链毛利额只作为同组补充，用于说明毛利额结构，不替代门店毛利额主线。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
