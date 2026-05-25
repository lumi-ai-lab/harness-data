---
id: playbook-business-cust-penetration-rate-bf19-per-cust-amt
kind: playbook
domain: business
title: 19点前客单价指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - bf19PerCustAmt
match:
  keywords:
    - 19点前客单价
    - bf19PerCustAmt
    - 19点前客单价情况
    - 19点前客单价为什么下降
    - 19点前客单价为什么提升
template: templates/business/cust-penetration-rate/bf19-per-cust-amt-report.md
---

# 19点前客单价指标报告 Playbook

## 目标

把“查看19点前客单价情况”“分析19点前客单价为什么下降/提升”等问题输出为经营分析下客数渗透率树中的 19点前客单价专项报告。

## 适用边界

适用于：

- 查看昨天的19点前客单价情况
- 分析昨日19点前客单价
- 19点前客单价为什么下降
- 19点前客单价为什么提升
- bf19PerCustAmt 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问客单价、19点前单均件数、19点前件单价、客数、销售额、毛利、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `19点前客单价` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 19点前客单价 --ai` 返回 `bf19PerCustAmt`，路径为 `客数渗透率 -> 客单价 -> 19点前客单价`，并显示子指标 `19点前单均件数`、`19点前件单价`。
- `report business indicators --date 2026-05-23 --indicator 19点前客单价 --ai` 可返回 19点前客单价及相关指标的当前值、阈值、同比、环比字段；样本中当前值 23.297081810062483，阈值 GT 19.2，环比 0.2193，同比 0.0298。
- `report business tree --values --date 2026-05-23 --indicator 19点前客单价` 可返回经营分析完整树，selected indicator 为 `bf19PerCustAmt`，并包含父子链路取值。
- `report business tree --chart --date 2026-05-23 --indicator 19点前客单价 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 19点前客单价 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `19点前客单价`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 19点前客单价 --ai`
- `report business tree --values <time_filter> --indicator 19点前客单价`
- `report business tree --chart <time_filter> --indicator 19点前客单价`
- `report business area <time_filter> --indicator 19点前客单价 --ai`
- `report business category <time_filter> --indicator 19点前客单价 --ai`
- `report business trend <time_filter> --indicator 19点前客单价 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 19点前客单价 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 19点前客单价 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 19点前客单价 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 19点前客单价 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 19点前客单价 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 19点前客单价 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的 19点前客单价、19点前单均件数、19点前件单价及必要的父级客单价、客数渗透率传导证据。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
