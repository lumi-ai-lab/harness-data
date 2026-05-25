---
id: playbook-business-cust-penetration-rate-sale-amt
kind: playbook
domain: business
title: 销售额指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - saleAmt
match:
  keywords:
    - 销售额
    - saleAmt
    - 销售额情况
    - 销售额为什么下降
    - 销售额为什么提升
template: templates/business/cust-penetration-rate/sale-amt-report.md
---

# 销售额指标报告 Playbook

## 目标

把“查看销售额情况”“分析销售额为什么下降/提升”等问题输出为经营分析下客数渗透率树中的销售额专项报告。

## 适用边界

适用于：

- 查看昨天的销售额情况
- 分析昨日销售额
- 销售额为什么下降
- 销售额为什么提升
- saleAmt 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问客数、客单价、毛利、品效、活跃供应商数等其他指标专项的问题。
- 用户明确要求指标定义解释、指标平台或非 CMR 报表的问题。

命中该 playbook 后，不向用户追问；若用户未给时间，默认使用昨天，并在报告概述中说明默认口径。

## CLI 探索结论

已对 `销售额` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 销售额 --ai` 可返回父指标客数渗透率、当前指标销售额、子指标19点前销售占比及叶子指标19点前销售重量、订单满足率。
- `report business indicators --date 2026-05-23 --indicator 销售额 --ai` 可返回销售额及相关指标的当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 销售额` 可返回经营分析完整树，selected indicator 为 `saleAmt`，并包含销售额链路取值。
- `report business tree --chart --date 2026-05-23 --indicator 销售额 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 销售额 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `销售额`。六个模块是硬性要求，模块之间没有业务顺序依赖，可以并行查询；必须全部成功后才能进入报告生成阶段。六个模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 销售额 --ai`
- `report business tree --values <time_filter> --indicator 销售额`
- `report business tree --chart <time_filter> --indicator 销售额`
- `report business area <time_filter> --indicator 销售额 --ai`
- `report business category <time_filter> --indicator 销售额 --ai`
- `report business trend <time_filter> --indicator 销售额 --ai`

推荐并行查询方式：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 销售额 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 销售额 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 销售额 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 销售额 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 销售额 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 销售额 --ai &
wait

bin/data-harness-cli inject-template
```

## 分析步骤

1. 明确时间口径和筛选口径。
2. 并行查询 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
3. 若六个模块均成功，立即执行 `bin/data-harness-cli inject-template`。
4. template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
5. inject-template 成功并收到 template 二阶段注入后，再按 template 组织最终报告正文。

## 证据规则

- 最终报告只使用 CLI 返回的销售额、19点前销售占比、19点前销售重量、订单满足率及必要的父级客数渗透率传导证据。
- 区域、品类、趋势证据只作为销售额链路的结构性佐证。
- 数值、排名、同比、环比、阈值、异常点必须来自 CLI 输出。
- CLI 未返回的指标行、指标组或段落直接省略。
- 不使用本地 demo 数据、静态示例值或经验估算值。

## 异常处理

- 若必要模块查询失败，先重试或调整合法参数；仍失败时不得生成最终报告。
- 若某个必要模块成功但返回数据为空，保留已返回证据；不得在 template 注入前继续分析或补造缺失指标。
- 六个必要模块全部成功后，若未立即执行 `bin/data-harness-cli inject-template`，不得输出任何总结、素材整理或中间分析。
- 若 `bin/data-harness-cli inject-template` 未成功，或未收到 template 二阶段注入，不得输出最终报告正文。
