---
id: playbook-business-cust-penetration-rate-full-link-store-profit-notax-rate
kind: playbook
domain: business
title: 全链路毛利率指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - fullLinkStoreProfitNotaxRate
match:
  keywords:
    - 全链路毛利率
    - fullLinkStoreProfitNotaxRate
    - 全链路毛利率情况
    - 全链路毛利率为什么下降
    - 全链路毛利率为什么提升
template: templates/business/cust-penetration-rate/full-link-store-profit-notax-rate-report.md
---

# 全链路毛利率指标报告 Playbook

## 目标

把“查看全链路毛利率情况”“分析全链路毛利率为什么下降/提升”等问题输出为经营分析下客数渗透率树中的全链路毛利率专项报告。

## 适用边界

适用于：

- 查看昨天的全链路毛利率情况
- 分析昨日全链路毛利率
- 全链路毛利率为什么下降
- 全链路毛利率为什么提升
- fullLinkStoreProfitNotaxRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问门店毛利率、供应链毛利率、全链路毛利额、销售额、客数、客单价、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `全链路毛利率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 全链路毛利率 --ai` 可返回父指标客数渗透率、当前指标全链路毛利率及子指标门店毛利率、供应链毛利率。
- `report business indicators --date 2026-05-23 --indicator 全链路毛利率 --ai` 可返回当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 全链路毛利率` 可返回经营分析完整树，selected indicator 为 `fullLinkStoreProfitNotaxRate`。
- `report business tree --chart --date 2026-05-23 --indicator 全链路毛利率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 全链路毛利率 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `全链路毛利率`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 全链路毛利率 --ai`
- `report business tree --values <time_filter> --indicator 全链路毛利率`
- `report business tree --chart <time_filter> --indicator 全链路毛利率`
- `report business area <time_filter> --indicator 全链路毛利率 --ai`
- `report business category <time_filter> --indicator 全链路毛利率 --ai`
- `report business trend <time_filter> --indicator 全链路毛利率 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 全链路毛利率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 全链路毛利率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 全链路毛利率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 全链路毛利率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 全链路毛利率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 全链路毛利率 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的全链路毛利率、门店毛利率、供应链毛利率及必要的父级客数渗透率传导证据。
- 区域、品类、趋势证据只作为全链路毛利率链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
