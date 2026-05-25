---
id: playbook-business-cust-penetration-rate-bf19-member-repurchase-rate
kind: playbook
domain: business
title: 19点前复购率指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - bf19MemberRepurchaseRate
match:
  keywords:
    - 19点前复购率
    - bf19MemberRepurchaseRate
    - 19点前复购率情况
    - 19点前复购率为什么下降
    - 19点前复购率为什么提升
template: templates/business/cust-penetration-rate/bf19-member-repurchase-rate-report.md
---

# 19点前复购率指标报告 Playbook

## 目标

把“查看19点前复购率情况”“分析19点前复购率为什么下降/提升”等问题输出为经营分析下客数渗透率树中的 19点前复购率专项报告。

## 适用边界

适用于：

- 查看昨天的19点前复购率情况
- 分析昨日19点前复购率
- 19点前复购率为什么下降
- 19点前复购率为什么提升
- bf19MemberRepurchaseRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问19点前客数、19点前PI值、客数、客数渗透率、销售额、客单价、毛利、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `19点前复购率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 19点前复购率 --ai` 返回 `bf19MemberRepurchaseRate`，路径为 `客数渗透率 -> 客数 -> 19点前客数 -> 19点前复购率`。
- `report business indicators --date 2026-05-23 --indicator 19点前复购率 --ai` 可返回 19点前复购率及相关指标的当前值、同比、环比字段；样本中当前值为 0，环比 -0.2173，同比 -0.6199。
- `report business tree --values --date 2026-05-23 --indicator 19点前复购率` 可返回经营分析完整树，selected indicator 为 `bf19MemberRepurchaseRate`，并包含父级链路取值。
- `report business tree --chart --date 2026-05-23 --indicator 19点前复购率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 19点前复购率 --ai` 均可独立返回压缩结构证据；样本中各区域、品类当前值为 0，趋势在 2026/05/23 降至 0。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `19点前复购率`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 19点前复购率 --ai`
- `report business tree --values <time_filter> --indicator 19点前复购率`
- `report business tree --chart <time_filter> --indicator 19点前复购率`
- `report business area <time_filter> --indicator 19点前复购率 --ai`
- `report business category <time_filter> --indicator 19点前复购率 --ai`
- `report business trend <time_filter> --indicator 19点前复购率 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 19点前复购率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 19点前复购率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 19点前复购率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 19点前复购率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 19点前复购率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 19点前复购率 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的 19点前复购率及必要的父级 19点前客数、客数、客数渗透率传导证据。
- 若 CLI 返回 0、全区域为 0 或趋势末端归零，只能按 CLI 事实谨慎描述，不得自行解释原因。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
