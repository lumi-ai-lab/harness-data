---
id: playbook-business-cust-penetration-rate-cust-num
kind: playbook
domain: business
title: 客数指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - custNum
match:
  keywords:
    - 客数
    - custNum
    - 客数情况
    - 客数为什么下降
    - 客数为什么提升
template: templates/business/cust-penetration-rate/cust-num-report.md
---

# 客数指标报告 Playbook

## 目标

把“查看客数情况”“分析客数为什么下降/提升”等问题输出为经营分析下客数渗透率树中的客数专项报告。

## 适用边界

适用于：

- 查看昨天的客数情况
- 分析昨日客数
- 客数为什么下降
- 客数为什么提升
- custNum 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问客数渗透率、19点前客数、销售额、客单价、毛利、品效、活跃供应商数等其他指标专项的问题。

## CLI 探索结论

已对 `客数` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 客数 --ai` 会返回多个包含“客数”的匹配，当前 playbook 只使用 `custNum` 这一项。
- `report business indicators --date 2026-05-23 --indicator 客数 --ai` 可返回客数及相关指标的当前值、同比、环比字段。
- `report business tree --values --date 2026-05-23 --indicator 客数` 可返回经营分析完整树，selected indicator 为 `custNum`，并包含客数链路取值。
- `report business tree --chart --date 2026-05-23 --indicator 客数 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 客数 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `客数`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 客数 --ai`
- `report business tree --values <time_filter> --indicator 客数`
- `report business tree --chart <time_filter> --indicator 客数`
- `report business area <time_filter> --indicator 客数 --ai`
- `report business category <time_filter> --indicator 客数 --ai`
- `report business trend <time_filter> --indicator 客数 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 客数 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 客数 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 客数 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 客数 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 客数 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 客数 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的客数、19点前客数、19点前PI值、19点前复购率及必要的父级客数渗透率传导证据。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
