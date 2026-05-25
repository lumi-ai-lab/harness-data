---
id: playbook-business-active-vender-num-active-vender-num
kind: playbook
domain: business
title: 活跃供应商数指标报告 Playbook
tags:
  - playbook
  - business-report
  - active-vender-num
  - activeVenderNum
match:
  keywords:
    - 活跃供应商数
    - activeVenderNum
    - 活跃供应商数情况
    - 活跃供应商数为什么下降
    - 活跃供应商数为什么提升
template: templates/business/active-vender-num/active-vender-num-report.md
---

# 活跃供应商数指标报告 Playbook

## 目标

把“查看活跃供应商数情况”“分析活跃供应商数为什么下降/提升”等问题输出为经营分析下活跃供应商数树中的活跃供应商数专项报告。

## 适用边界

适用于：

- 查看昨天的活跃供应商数情况
- 分析昨日活跃供应商数
- 活跃供应商数为什么下降
- 活跃供应商数为什么提升
- activeVenderNum 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问集采入库占比、三率综合得分、准确率、准点率、合格率、品效、客数渗透率等其他指标专项的问题。

## CLI 探索结论

已对 `活跃供应商数` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 活跃供应商数 --ai` 可返回当前指标活跃供应商数、子指标集采入库占比、三率综合得分及叶子指标准确率、准点率、合格率。
- `report business indicators --date 2026-05-23 --indicator 活跃供应商数 --ai` 可返回当前值、同比、环比、阈值字段。
- `report business tree --values --date 2026-05-23 --indicator 活跃供应商数` 可返回经营分析完整树，selected indicator 为 `activeVenderNum`。
- `report business tree --chart --date 2026-05-23 --indicator 活跃供应商数 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area/category/trend --date 2026-05-23 --indicator 活跃供应商数 --ai` 均可独立返回压缩结构证据。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `活跃供应商数`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 活跃供应商数 --ai`
- `report business tree --values <time_filter> --indicator 活跃供应商数`
- `report business tree --chart <time_filter> --indicator 活跃供应商数`
- `report business area <time_filter> --indicator 活跃供应商数 --ai`
- `report business category <time_filter> --indicator 活跃供应商数 --ai`
- `report business trend <time_filter> --indicator 活跃供应商数 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 活跃供应商数 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 活跃供应商数 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 活跃供应商数 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 活跃供应商数 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 活跃供应商数 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 活跃供应商数 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的活跃供应商数、集采入库占比、三率综合得分、准确率、准点率、合格率证据。
- 区域、品类、趋势证据只作为活跃供应商数链路的结构性佐证。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
