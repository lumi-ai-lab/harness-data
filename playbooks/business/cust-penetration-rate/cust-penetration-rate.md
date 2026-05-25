---
id: playbook-business-cust-penetration-rate-cust-penetration-rate
kind: playbook
domain: business
title: 客数渗透率指标报告 Playbook
tags:
  - playbook
  - business-report
  - cust-penetration-rate
  - custPenetrationRate
match:
  keywords:
    - 客数渗透率
    - custPenetrationRate
    - 客数渗透率情况
    - 客数渗透率为什么下降
    - 客数渗透率为什么提升
template: templates/business/cust-penetration-rate/cust-penetration-rate-report.md
---

# 客数渗透率指标报告 Playbook

## 目标

把“查看客数渗透率情况”“分析客数渗透率为什么下降/提升”等问题输出为经营分析下的客数渗透率专项报告。

## 适用边界

适用于：

- 查看昨天的客数渗透率情况
- 分析昨日客数渗透率
- 客数渗透率为什么下降
- 客数渗透率为什么提升
- custPenetrationRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 只问品效、活跃供应商数或其他一级指标专项的问题。
- 用户明确要求指标定义解释、指标平台或非 CMR 报表的问题。

命中该 playbook 后，不向用户追问；若用户未给时间，默认使用昨天，并在报告概述中说明默认口径。

## CLI 探索结论

已对 `客数渗透率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 客数渗透率 --ai` 可返回客数渗透率单指标树父子关系。
- `report business indicators --date 2026-05-23 --indicator 客数渗透率 --ai` 可返回客数渗透率及相关指标的当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 客数渗透率` 可返回经营分析完整树，selected indicator 为 `custPenetrationRate`，并包含客数渗透率树内取值。
- `report business tree --chart --date 2026-05-23 --indicator 客数渗透率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 客数渗透率 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/common/cmr-cli-readme.md` 与 `spec/common/time-policy.md` 为准。

使用 `qdm-cmr-cli report business`，固定指标为 `客数渗透率`。六个模块是硬性要求，模块之间没有业务顺序依赖，可以并行查询；必须全部成功后才能进入报告生成阶段。六个模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 客数渗透率 --ai`
- `report business tree --values <time_filter> --indicator 客数渗透率`
- `report business tree --chart <time_filter> --indicator 客数渗透率`
- `report business area <time_filter> --indicator 客数渗透率 --ai`
- `report business category <time_filter> --indicator 客数渗透率 --ai`
- `report business trend <time_filter> --indicator 客数渗透率 --ai`

推荐并行查询方式：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 客数渗透率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 客数渗透率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 客数渗透率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 客数渗透率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 客数渗透率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 客数渗透率 --ai &
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

- 最终报告只使用 CLI 返回的客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额及其下钻指标。
- 区域、品类、趋势证据只作为客数渗透率链路的结构性佐证。
- 数值、排名、同比、环比、阈值、异常点必须来自 CLI 输出。
- CLI 未返回的指标行、指标组或段落直接省略。
- 不使用本地 demo 数据、静态示例值或经验估算值。

## 异常处理

- 若必要模块查询失败，先重试或调整合法参数；仍失败时不得生成最终报告。
- 若某个必要模块成功但返回数据为空，保留已返回证据；不得在 template 注入前继续分析或补造缺失指标。
- 六个必要模块全部成功后，若未立即执行 `bin/data-harness-cli inject-template`，不得输出任何总结、素材整理或中间分析。
- 若 `bin/data-harness-cli inject-template` 未成功，或未收到 template 二阶段注入，不得输出最终报告正文。
