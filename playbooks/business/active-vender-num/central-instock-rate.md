---
id: playbook-business-active-vender-num-central-instock-rate
kind: playbook
domain: business
title: 集采入库占比指标报告 Playbook
tags:
  - playbook
  - business-report
  - active-vender-num
  - centralInstockRate
match:
  keywords:
    - 集采入库占比
    - centralInstockRate
    - 集采入库占比情况
    - 集采入库占比为什么下降
    - 集采入库占比为什么提升
template: templates/business/active-vender-num/central-instock-rate-report.md
---

# 集采入库占比指标报告 Playbook

## 目标

把“查看集采入库占比情况”“分析集采入库占比为什么下降/提升”等问题输出为经营分析下活跃供应商数树中的集采入库占比专项报告。

## 适用边界

适用于：

- 查看昨天的集采入库占比情况
- 分析昨日集采入库占比
- 集采入库占比为什么下降
- 集采入库占比为什么提升
- centralInstockRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问活跃供应商数、三率综合得分、准确率、准点率、合格率、品效、客数渗透率等其他指标专项的问题。

## CLI 探索结论

已对 `集采入库占比` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 集采入库占比 --ai` 可返回父指标活跃供应商数和当前叶子指标集采入库占比。
- `report business indicators --date 2026-05-23 --indicator 集采入库占比 --ai` 可返回当前值、同比、环比字段。
- `report business tree --values --date 2026-05-23 --indicator 集采入库占比` 可返回经营分析完整树，selected indicator 为 `centralInstockRate`。
- `report business tree --chart --date 2026-05-23 --indicator 集采入库占比 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 集采入库占比 --ai` 均可独立返回压缩结构证据；部分区域或品类可能返回 0，最终报告只能按 CLI 事实描述。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `集采入库占比`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 集采入库占比 --ai`
- `report business tree --values <time_filter> --indicator 集采入库占比`
- `report business tree --chart <time_filter> --indicator 集采入库占比`
- `report business area <time_filter> --indicator 集采入库占比 --ai`
- `report business category <time_filter> --indicator 集采入库占比 --ai`
- `report business trend <time_filter> --indicator 集采入库占比 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 集采入库占比 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 集采入库占比 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 集采入库占比 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 集采入库占比 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 集采入库占比 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 集采入库占比 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的集采入库占比及必要的父级活跃供应商数传导证据。
- 区域、品类、趋势证据只作为集采入库占比链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
