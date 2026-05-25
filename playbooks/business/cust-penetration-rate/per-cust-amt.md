---
id: playbook-business-cust-penetration-rate-per-cust-amt
kind: playbook
domain: business
title: 客单价指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - perCustAmt
match:
  keywords:
    - 客单价
    - perCustAmt
    - 客单价情况
    - 客单价为什么下降
    - 客单价为什么提升
template: templates/business/cust-penetration-rate/per-cust-amt-report.md
---

# 客单价指标报告 Playbook

## 目标

把“查看客单价情况”“分析客单价为什么下降/提升”等问题输出为经营分析下客数渗透率树中的客单价专项报告。

## 适用边界

适用于：

- 查看昨天的客单价情况
- 分析昨日客单价
- 客单价为什么下降
- 客单价为什么提升
- perCustAmt 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问客数渗透率、19点前客单价、销售额、客数、毛利、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `客单价` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 客单价 --ai` 会返回 `perCustAmt` 与 `bf19PerCustAmt` 两个匹配，当前 playbook 只使用 `perCustAmt`。
- `report business indicators --date 2026-05-23 --indicator 客单价 --ai` 可返回客单价及相关指标的当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 客单价` 可返回经营分析完整树，selected indicator 为 `perCustAmt`，并包含客单价链路取值。
- `report business tree --chart --date 2026-05-23 --indicator 客单价 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 客单价 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `客单价`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 客单价 --ai`
- `report business tree --values <time_filter> --indicator 客单价`
- `report business tree --chart <time_filter> --indicator 客单价`
- `report business area <time_filter> --indicator 客单价 --ai`
- `report business category <time_filter> --indicator 客单价 --ai`
- `report business trend <time_filter> --indicator 客单价 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 客单价 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 客单价 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 客单价 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 客单价 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 客单价 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 客单价 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的客单价、19点前客单价、19点前单均件数、19点前件单价及必要的父级客数渗透率传导证据。
- 区域、品类、趋势证据只作为客单价链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
