---
id: playbook-business-cust-penetration-rate-scm-store-profit-amt-notax
kind: playbook
domain: business
title: 供应链毛利额指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - scmStoreProfitAmtNotax
match:
  keywords:
    - 供应链毛利额
    - scmStoreProfitAmtNotax
    - 供应链毛利额情况
    - 供应链毛利额为什么下降
    - 供应链毛利额为什么提升
template: templates/business/cust-penetration-rate/scm-store-profit-amt-notax-report.md
---

# 供应链毛利额指标报告 Playbook

## 目标

把“查看供应链毛利额情况”“分析供应链毛利额为什么下降/提升”等问题输出为经营分析下客数渗透率树中的供应链毛利额专项报告。

## 适用边界

适用于：

- 查看昨天的供应链毛利额情况
- 分析昨日供应链毛利额
- 供应链毛利额为什么下降
- 供应链毛利额为什么提升
- scmStoreProfitAmtNotax 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问全链路毛利额、门店毛利额、全链路毛利率、供应链毛利率、销售额、客数、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `供应链毛利额` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 供应链毛利额 --ai` 返回 `scmStoreProfitAmtNotax`，路径为 `客数渗透率 -> 全链路毛利额 -> 供应链毛利额`。
- `report business indicators --date 2026-05-23 --indicator 供应链毛利额 --ai` 可返回供应链毛利额及相关指标的当前值、同比、环比字段；样本中当前值 1239.2642136641439，环比 0.1415，同比 0.0306。
- `report business tree --values --date 2026-05-23 --indicator 供应链毛利额` 可返回经营分析完整树，selected indicator 为 `scmStoreProfitAmtNotax`，并包含父级全链路毛利额 4217.478029103727、同组门店毛利额 2978.2138154395852。
- `report business tree --chart --date 2026-05-23 --indicator 供应链毛利额 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 供应链毛利额 --ai` 均可独立返回压缩结构证据；样本中运营直管、粤东、粤西领先，天津、长沙、武汉、合肥等区域同比为负。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `供应链毛利额`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 供应链毛利额 --ai`
- `report business tree --values <time_filter> --indicator 供应链毛利额`
- `report business tree --chart <time_filter> --indicator 供应链毛利额`
- `report business area <time_filter> --indicator 供应链毛利额 --ai`
- `report business category <time_filter> --indicator 供应链毛利额 --ai`
- `report business trend <time_filter> --indicator 供应链毛利额 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 供应链毛利额 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 供应链毛利额 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 供应链毛利额 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 供应链毛利额 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 供应链毛利额 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 供应链毛利额 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的供应链毛利额及必要的父级全链路毛利额、客数渗透率传导证据。
- 门店毛利额只作为同组补充，用于说明毛利额结构，不替代供应链毛利额主线。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
